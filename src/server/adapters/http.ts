import { getDb } from "../db/client";
import { adapterHealth } from "../db/schema";

export type ProviderName = "google" | "hubspot" | "resend";

const LABEL: Record<ProviderName, string> = {
  google: "Google Calendar",
  hubspot: "HubSpot",
  resend: "Resend",
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
            ? "Temporary provider problem — already retried once. Continue without this action."
            : "The provider rejected the request.",
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ProviderFetchOptions = {
  /** Test hook: backoff multiplier (0 in tests). */
  backoffMs?: number;
};

let defaultBackoffMs = 500;
/** Tests set this to 0 so retries don't slow the suite. */
export function setProviderBackoff(ms: number) {
  defaultBackoffMs = ms;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error as Record<string, unknown> | string | undefined;
    // OAuth errors: { error: "invalid_grant", error_description: "Token has been expired…" }
    if (typeof e === "string" && typeof j.error_description === "string") {
      return `${e}: ${j.error_description}`.slice(0, 300);
    }
    const msg =
      (typeof e === "object" && e ? (e.message as string) : undefined) ??
      (typeof e === "string" ? e : undefined) ??
      (j.message as string | undefined) ??
      (j.error_description as string | undefined);
    if (msg) return String(msg).slice(0, 300);
  } catch {
    // not JSON
  }
  return (text || res.statusText || "request failed").slice(0, 300);
}

/**
 * fetch() for real providers: JSON by default, one retry on 429/5xx/network errors with
 * backoff (honoring Retry-After up to 5s), typed ProviderError otherwise. Every outcome
 * updates the provider's health row so Settings can show a red badge with the last error.
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

  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, request);
    } catch (err) {
      lastError = new ProviderError(
        provider,
        null,
        `network error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
      if (attempt === 1) {
        await sleep(backoff);
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
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new ProviderError(provider, res.status, await readError(res), retryable);
    if (retryable && attempt === 1) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : backoff,
      );
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
