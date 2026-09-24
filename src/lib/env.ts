import "server-only";
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

  // Adapter selection ("auto" = real adapter when its keys exist, otherwise mock)
  CALENDAR_ADAPTER: z.enum(["auto", "mock", "google"]).default("auto"),
  CRM_ADAPTER: z.enum(["auto", "internal", "airtable", "hubspot"]).default("auto"),
  EMAIL_ADAPTER: z.enum(["auto", "console", "resend"]).default("auto"),

  // Google Calendar
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REFRESH_TOKEN: optionalString,
  GOOGLE_CALENDAR_ID: optionalString,

  // Airtable
  AIRTABLE_API_KEY: optionalString,
  AIRTABLE_BASE_ID: optionalString,
  AIRTABLE_TABLE_NAME: optionalString,

  // HubSpot
  HUBSPOT_ACCESS_TOKEN: optionalString,

  // Email
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  INBOUND_EMAIL_DOMAIN: optionalString,
  INBOUND_EMAIL_SECRET: optionalString,

  // Inbound webhook (seeded into the default workspace; editable in Settings)
  WEBHOOK_SECRET: optionalString,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
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
  return Boolean(e.ANTHROPIC_API_KEY && e.ANTHROPIC_MODEL);
}
