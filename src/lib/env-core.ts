import { z } from "zod";

/**
 * Server-side environment, validated once with Zod.
 *
 * Design rule: only DATABASE_URL is strictly required to boot. Everything else
 * has a safe default so the app degrades to DEMO MODE instead of crashing.
 * Integration adapters decide on their own whether they have enough config
 * (see src/server/adapters/*) and fall back to mocks otherwise.
 */

// Treat "" the same as "unset" — `.env` files often contain `KEY=`.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

const bool = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? String(fallback) : v),
    z.stringbool(),
  ) as z.ZodType<boolean>;

const int = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? fallback : v),
    z.coerce.number().int().min(min).max(max),
  ) as z.ZodType<number>;

const float = z.preprocess(
  (v) => (v === undefined || v === "" ? undefined : v),
  z.coerce.number().nonnegative().optional(),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Core
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.preprocess(
    (v) => (v === undefined || v === "" ? "http://localhost:3000" : v),
    z.url(),
  ) as z.ZodType<string>,

  // LLM
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  ANTHROPIC_PRICE_INPUT_PER_MTOK: float,
  ANTHROPIC_PRICE_OUTPUT_PER_MTOK: float,
  MAX_AGENT_STEPS: int(12, 1, 50),
  // Development only: rule-based stand-in for Claude so the UI can be exercised
  // without an API key. Refused when NODE_ENV=production.
  DEV_FAKE_LLM: bool(false),
  // Optional `output_config.effort` (low | medium | high | xhigh | max). Only sent when set,
  // because not every model accepts it.
  ANTHROPIC_EFFORT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  ),
  // Guardrails: per-call output cap and per-run spend cap.
  LLM_MAX_TOKENS: int(8000, 256, 64000),
  MAX_COST_PER_RUN_USD: z.preprocess(
    (v) => (v === undefined || v === "" ? 0.1 : v),
    z.coerce.number().positive(),
  ) as z.ZodType<number>,
  // Wall-clock budget for a single run; keep below the route's maxDuration (60s).
  RUN_TIME_BUDGET_MS: int(50_000, 5_000, 800_000),

  // Auth / demo
  ADMIN_PASSWORD: optionalString,
  SESSION_SECRET: optionalString,
  PUBLIC_DEMO: bool(true),
  // Public demo deployments: always use the built-in calendar / CRM / email, even if real
  // integration keys are present. Real integrations are demoed from a local run instead.
  PUBLIC_DEMO_FORCE_MOCK: bool(false),
  // Global daily budget for simulated (public demo) runs, UTC day.
  DEMO_DAILY_RUN_LIMIT: int(50, 0, 100_000),
  DEMO_DAILY_COST_LIMIT_USD: z.preprocess(
    (v) => (v === undefined || v === "" ? 2 : v),
    z.coerce.number().nonnegative(),
  ) as z.ZodType<number>,
  DEMO_VIDEO_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()) as z.ZodType<
    string | undefined
  >,

  // Adapter selection ("auto" = real adapter when its keys exist, otherwise mock)
  CALENDAR_ADAPTER: z.enum(["auto", "mock", "google"]).default("auto"),
  CRM_ADAPTER: z.enum(["auto", "internal", "airtable", "hubspot"]).default("auto"),
  EMAIL_ADAPTER: z.enum(["auto", "console", "resend"]).default("auto"),

  // Google Calendar
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REFRESH_TOKEN: optionalString,
  GOOGLE_CALENDAR_ID: optionalString,

  // HubSpot
  HUBSPOT_ACCESS_TOKEN: optionalString,

  // Email
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  INBOUND_EMAIL_DOMAIN: optionalString,
  INBOUND_EMAIL_SECRET: optionalString,
  // Svix signing secret of the Resend inbound webhook (whsec_…).
  RESEND_WEBHOOK_SECRET: optionalString,
  // Local port for `pnpm google:auth` (OAuth loopback redirect).
  GOOGLE_OAUTH_PORT: int(53682, 1024, 65535),

  // Inbound webhook (seeded into the default workspace; editable in Settings)
  WEBHOOK_SECRET: optionalString,
});

export type Env = z.infer<typeof envSchema>;

/** Well-known development password; must never be used in production. */
export const DEV_ADMIN_PASSWORD = "leadpilot-dev";
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Production refuses to boot with weak or missing admin credentials: a public
 * deployment with a guessable password would hand out the agent (and its spend).
 */
const validatedEnvSchema = envSchema.superRefine((e, ctx) => {
  if (e.NODE_ENV !== "production") return;
  const fail = (path: keyof Env, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });

  if (!e.ADMIN_PASSWORD) fail("ADMIN_PASSWORD", "is required in production");
  else if (e.ADMIN_PASSWORD === DEV_ADMIN_PASSWORD) {
    fail("ADMIN_PASSWORD", `must not be the development default "${DEV_ADMIN_PASSWORD}"`);
  } else if (e.ADMIN_PASSWORD.length < MIN_ADMIN_PASSWORD_LENGTH) {
    fail(
      "ADMIN_PASSWORD",
      `must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters in production`,
    );
  }

  if (!e.SESSION_SECRET) fail("SESSION_SECRET", "is required in production (openssl rand -hex 32)");
  else if (e.SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    fail(
      "SESSION_SECRET",
      `must be at least ${MIN_SESSION_SECRET_LENGTH} characters in production`,
    );
  }

  if (e.DEV_FAKE_LLM) fail("DEV_FAKE_LLM", "must be false in production");
});

let cached: Env | undefined;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = validatedEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}

export function isLlmConfigured(e: Env = env()) {
  return (
    (e.DEV_FAKE_LLM && e.NODE_ENV !== "production") ||
    Boolean(e.ANTHROPIC_API_KEY && e.ANTHROPIC_MODEL)
  );
}
