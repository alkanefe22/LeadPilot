import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { rateLimits } from "../db/schema";

export { clientIp } from "./client-ip";

export type RateLimitResult = { ok: boolean; count: number; limit: number; resetAt: Date };

/**
 * Fixed-window rate limiter backed by Postgres, so it holds across serverless
 * instances without an extra service. One atomic upsert per check.
 */
export async function rateLimit(
  db: Database,
  key: string,
  limit: number,
  windowSeconds: number,
  now = new Date(),
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  const count = row?.count ?? 1;
  return { ok: count <= limit, count, limit, resetAt: new Date(windowStart.getTime() + windowMs) };
}

/** Removes windows older than a day. Cheap; called opportunistically. */
export async function pruneRateLimits(db: Database, now = new Date()) {
  await db.execute(
    sql`DELETE FROM rate_limits WHERE window_start < ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
  );
}
