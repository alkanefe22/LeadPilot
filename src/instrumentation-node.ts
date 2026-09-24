import { parseEnv } from "./lib/env-core";

/**
 * Validates the environment at boot so a misconfigured production deployment (e.g. weak
 * ADMIN_PASSWORD) refuses to start with a clear message instead of serving traffic.
 * `next build` also sets NODE_ENV=production, so only enforce when actually serving.
 */
if (process.env.NEXT_PHASE !== "phase-production-build") {
  try {
    parseEnv(process.env);
  } catch (err) {
    console.error(
      `\n[leadpilot] Refusing to start.\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    // Without an explicit exit, Next keeps listening and answers every request with a 500.
    process.exit(1);
  }
}
