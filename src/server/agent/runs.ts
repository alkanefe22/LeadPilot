import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentRuns, agentSteps } from "../db/schema";

export const STALE_RUN_MS = 2 * 60_000;

/**
 * A serverless function can be killed mid-run (timeout, deploy, crash), leaving a run
 * stuck in "running". That would make the UI poll forever and — because of the
 * one-running-run-per-lead unique index — block every future run for that lead.
 * Called before each new run and whenever a trace is polled.
 */
export async function sweepStaleRuns(db: Database, maxAgeMs = STALE_RUN_MS, now = new Date()) {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const rows = await db
    .update(agentRuns)
    .set({
      status: "failed",
      error: "timed out",
      finishedAt: now,
      latencyMs: sql`GREATEST(0, (EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - ${agentRuns.startedAt})) * 1000)::int)`,
    })
    .where(and(eq(agentRuns.status, "running"), lt(agentRuns.startedAt, cutoff)))
    .returning({ id: agentRuns.id });
  return rows.length;
}

export async function getRunsForLead(db: Database, leadId: string) {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.leadId, leadId))
    .orderBy(desc(agentRuns.startedAt));
}

export async function getSteps(db: Database, runId: string) {
  return db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(asc(agentSteps.idx));
}
