import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentRuns, leads } from "../db/schema";

export type DemoBudget = {
  runsToday: number;
  costToday: number;
  runLimit: number;
  costLimit: number;
  limitReached: boolean;
  videoUrl: string | null;
};

export function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Global (all visitors) budget for simulated runs, reset at 00:00 UTC. */
export async function getDemoBudget(
  db: Database,
  opts: { workspaceId: string; runLimit: number; costLimit: number; videoUrl?: string | null },
  now = new Date(),
): Promise<DemoBudget> {
  const [row] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      cost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
    })
    .from(agentRuns)
    .innerJoin(leads, eq(leads.id, agentRuns.leadId))
    .where(
      and(
        eq(leads.workspaceId, opts.workspaceId),
        eq(agentRuns.trigger, "simulate"),
        gte(agentRuns.startedAt, startOfUtcDay(now)),
      ),
    );
  const runsToday = Number(row?.runs ?? 0);
  const costToday = Number(row?.cost ?? 0);
  return {
    runsToday,
    costToday,
    runLimit: opts.runLimit,
    costLimit: opts.costLimit,
    limitReached: runsToday >= opts.runLimit || costToday >= opts.costLimit,
    videoUrl: opts.videoUrl ?? null,
  };
}
