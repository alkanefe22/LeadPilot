import { getDb } from "../db/client";
import { adapterHealth } from "../db/schema";

export type ProviderName = "google" | "hubspot" | "resend" | "gemini";

const LABEL: Record<ProviderName, string> = {
  google: "Google Calendar",
  hubspot: "HubSpot",
  resend: "Resend",
  gemini: "Gemini",
};

/**
 * A real integration failed. Deliberately NOT caught by adapter selection: a broken
 * provider must surface as a tool error in the trace (and a red badge in Settings),
 * never as a silent switch to the mock.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly status: number | null,
    readonly detail: string,
    readonly retryable: boolean,
  ) {
    super(`${LABEL[provider]} error${status ? ` (HTTP ${status})` : ""}: ${detail}`);
    this.name = "ProviderError";
  }

  toToolOutput() {
    return {
      error: this.message,
      provider: this.provider,
      http_status: this.status,
      hint:
        this.status === 401 || this.status === 403
          ? "Credentials are invalid or lack permissions — an admin must fix the integration. Do not retry."
          : this.retryable
            ? "Temporary provider problem — already retried. Continue without this action."
            : "The provider rejected the request.",
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ProviderFetchOptions = {
  /** Base backoff between attempts (tests use 0). */
  backoffMs?: number;
  /** Extra attempts after the first on 429/5xx/network errors. Default 1. */
  retries?: number;
  /** Cap for server-suggested waits (Retry-After header / Google RetryInfo). Default 5s. */
  maxRetryDelayMs?: number;
  /** Which HTTP statuses to retry. Default: 429 and 5xx. */
  retryOn?: (status: number) => boolean;
};

let defaultBackoffMs = 500;
/** Tests set this to 0 so retries don't slow the suite. */
export function setProviderBackoff(ms: number) {
  defaultBackoffMs = ms;
}

type ParsedError = { message: string; retryDelayMs: number | null; dailyQuota?: boolean };

/**
 * Google QuotaFailure details. A per-day quota (e.g. the Gemini free tier's
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier") won't recover by retrying in
 * seconds, even though Google still sends a short retryDelay — so we fail fast.
 */
function dailyQuota(j: Record<string, unknown>): string | null {
  const details = (j.error as { details?: unknown[] } | undefined)?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const violations = (d as { violations?: unknown[] }).violations;
    for (const v of Array.isArray(violations) ? violations : []) {
      const q = v as {
        quotaId?: string;
        quotaValue?: string;
        quotaDimensions?: { model?: string };
      };
      if (q.quotaId && /PerDay/i.test(q.quotaId)) {
        const model = q.quotaDimensions?.model ? ` for ${q.quotaDimensions.model}` : "";
        return `daily quota exhausted (${q.quotaValue ?? "?"} requests/day${model}; resets at midnight Pacific time)`;
      }
    }
  }
  return null;
}

/** Google RPC errors: { error: { details: [{ "@type": "…RetryInfo", retryDelay: "37s" }] } } */
function retryInfoMs(j: Record<string, unknown>): number | null {
  const details = (j.error as { details?: unknown[] } | undefined)?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const delay = (d as { retryDelay?: unknown }).retryDelay;
    if (typeof delay === "string" && /^\d+(\.\d+)?s$/.test(delay)) {
      return Math.round(parseFloat(delay) * 1000);
    }
  }
  return null;
}

export async function readError(res: Response): Promise<ParsedError> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const retryDelayMs = retryInfoMs(j);
    const daily = dailyQuota(j);
    if (daily) {
      const status = (j.error as { status?: string } | undefined)?.status;
      return {
        message: `${status ? `${status}: ` : ""}${daily}`,
        retryDelayMs: null,
        dailyQuota: true,
      };
    }
    const e = j.error as Record<string, unknown> | string | undefined;
    // OAuth errors: { error: "invalid_grant", error_description: "Token has been expired…" }
    if (typeof e === "string" && typeof j.error_description === "string") {
      return { message: `${e}: ${j.error_description}`.slice(0, 300), retryDelayMs };
    }
    const msg =
      (typeof e === "object" && e ? (e.message as string) : undefined) ??
      (typeof e === "string" ? e : undefined) ??
      (j.message as string | undefined) ??
      (j.error_description as string | undefined);
    // Google APIs add a status like RESOURCE_EXHAUSTED — useful context in the trace.
    const status =
      typeof e === "object" && e && typeof e.status === "string" ? `${e.status}: ` : "";
    if (msg) return { message: `${status}${String(msg)}`.slice(0, 300), retryDelayMs };
  } catch {
    // not JSON
  }
  return {
    message: (text || res.statusText || "request failed").slice(0, 300),
    retryDelayMs: null,
  };
}

/**
 * fetch() for real providers: JSON by default, retries on 429/5xx/network errors with
 * backoff (honoring Retry-After / RetryInfo up to a cap), typed ProviderError otherwise.
 * Every outcome updates the provider's health row so Settings can show a red badge.
 */
export async function providerFetch<T = unknown>(
  provider: ProviderName,
  url: string,
  init: RequestInit & { json?: unknown } = {},
  opts: ProviderFetchOptions = {},
): Promise<T> {
  const { json, ...rest } = init;
  const request: RequestInit = {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  };
  const backoff = opts.backoffMs ?? defaultBackoffMs;
  const attempts = 1 + (opts.retries ?? 1);
  const maxDelay = opts.maxRetryDelayMs ?? 5000;

  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, request);
    } catch (err) {
      if (request.signal?.aborted) throw err; // run time budget exhausted: not a provider fault
      lastError = new ProviderError(
        provider,
        null,
        `network error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
      if (attempt < attempts) {
        await sleep(backoff * attempt);
        continue;
      }
      break;
    }
    if (res.ok) {
      await recordHealth(provider, null);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const parsed = await readError(res);
    const retryable = (res.status === 429 || res.status >= 500) && !parsed.dailyQuota;
    lastError = new ProviderError(provider, res.status, parsed.message, retryable);
    const retryHere = retryable && (opts.retryOn ? opts.retryOn(res.status) : true);
    if (retryHere && attempt < attempts) {
      const header = Number(res.headers.get("retry-after")) * 1000;
      const suggested =
        parsed.retryDelayMs ?? (Number.isFinite(header) && header > 0 ? header : null);
      await sleep(suggested !== null ? Math.min(suggested, maxDelay) : backoff * attempt);
      continue;
    }
    break;
  }
  await recordHealth(provider, lastError);
  throw lastError!;
}

export async function recordHealth(provider: ProviderName, error: ProviderError | Error | null) {
  const now = new Date();
  try {
    await getDb()
      .insert(adapterHealth)
      .values(
        error
          ? { provider, lastErrorAt: now, lastError: error.message, failing: true }
          : { provider, lastOkAt: now, failing: false },
      )
      .onConflictDoUpdate({
        target: adapterHealth.provider,
        set: error
          ? { lastErrorAt: now, lastError: error.message, failing: true }
          : { lastOkAt: now, failing: false },
      });
  } catch (err) {
    // Health bookkeeping must never break the actual request path.
    console.warn("[adapters] could not record health", err);
  }
}
