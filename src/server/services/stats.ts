import "server-only";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { sweepStaleRuns } from "../agent/runs";
import { getDb } from "../db/client";
import { agentRuns, bookings, leads, type LeadStatus } from "../db/schema";

export type DailyPoint = { day: string; leads: number; cost: number };

export type OverviewStats = {
  totalLeads: number;
  leadsToday: number;
  scoredLeads: number;
  qualifiedPct: number | null;
  meetingsBooked: number;
  avgFirstResponseMs: number | null;
  respondedLeads: number;
  avgCostPerLead: number | null;
  totalCost: number;
  totalRuns: number;
  avgRunLatencyMs: number | null;
  statusCounts: Record<LeadStatus, number>;
  daily: DailyPoint[];
  recentRuns: {
    id: string;
    leadId: string;
    leadName: string;
    status: string;
    trigger: string;
    costUsd: number;
    latencyMs: number;
    startedAt: string;
  }[];
};

const DAYS = 14;

/** All Overview KPIs come from real rows (leads, runs, bookings) — nothing is hardcoded. */
export async function getOverviewStats(
  workspaceId: string,
  now = new Date(),
): Promise<OverviewStats> {
  const db = getDb();
  await sweepStaleRuns(db);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rangeStart = new Date(dayStart.getTime() - (DAYS - 1) * 86_400_000);
  const ws = eq(leads.workspaceId, workspaceId);

  const [leadAgg, statusRows, bookingAgg, runAgg, dailyLeads, dailyCost, recent] =
    await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          today: sql<number>`count(*) filter (where ${leads.createdAt} >= ${dayStart.toISOString()}::timestamptz)::int`,
          scored: sql<number>`count(${leads.score})::int`,
          responded: sql<number>`count(${leads.firstResponseAt})::int`,
          // Agent speed: measured from when the agent could first act on the lead (its first
          // run), not from lead creation — seeded/imported leads were "created" long before.
          avgResponseMs: sql<number | null>`(avg(extract(epoch from (
            ${leads.firstResponseAt} - greatest(
              ${leads.createdAt},
              (select min(r.started_at) from agent_runs r where r.lead_id = "leads"."id")
            )
          ))) * 1000)::float`,
        })
        .from(leads)
        .where(ws),
      db
        .select({ status: leads.status, n: sql<number>`count(*)::int` })
        .from(leads)
        .where(ws)
        .groupBy(leads.status),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(bookings)
        .where(and(eq(bookings.workspaceId, workspaceId), eq(bookings.status, "confirmed"))),
      db
        .select({
          runs: sql<number>`count(*)::int`,
          cost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
          leadsWithRuns: sql<number>`count(distinct ${agentRuns.leadId})::int`,
          avgLatency: sql<
            number | null
          >`avg(${agentRuns.latencyMs}) filter (where ${agentRuns.status} <> 'running')::float`,
        })
        .from(agentRuns)
        .innerJoin(leads, eq(leads.id, agentRuns.leadId))
        .where(ws),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${leads.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          n: sql<number>`count(*)::int`,
        })
        .from(leads)
        .where(and(ws, gte(leads.createdAt, rangeStart)))
        .groupBy(sql`1`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${agentRuns.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          cost: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
        })
        .from(agentRuns)
        .innerJoin(leads, eq(leads.id, agentRuns.leadId))
        .where(and(ws, gte(agentRuns.startedAt, rangeStart)))
        .groupBy(sql`1`),
      db
        .select({
          id: agentRuns.id,
          leadId: agentRuns.leadId,
          leadName: sql<string>`coalesce(${leads.name}, ${leads.company}, 'Unknown sender')`,
          status: agentRuns.status,
          trigger: agentRuns.trigger,
          costUsd: agentRuns.costUsd,
          latencyMs: agentRuns.latencyMs,
          startedAt: agentRuns.startedAt,
        })
        .from(agentRuns)
        .innerJoin(leads, eq(leads.id, agentRuns.leadId))
        .where(and(ws, isNotNull(agentRuns.startedAt)))
        .orderBy(desc(agentRuns.startedAt))
        .limit(8),
    ]);

  const la = leadAgg[0]!;
  const ra = runAgg[0]!;
  const statusCounts = { new: 0, needs_info: 0, qualified: 0, booked: 0, disqualified: 0 };
  for (const r of statusRows) statusCounts[r.status] = r.n;
  const qualifiedLike = statusCounts.qualified + statusCounts.booked;

  const byDayLeads = new Map(dailyLeads.map((d) => [d.day, d.n]));
  const byDayCost = new Map(dailyCost.map((d) => [d.day, Number(d.cost)]));
  const daily: DailyPoint[] = Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(rangeStart.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    return { day, leads: byDayLeads.get(day) ?? 0, cost: byDayCost.get(day) ?? 0 };
  });

  return {
    totalLeads: la.total,
    leadsToday: la.today,
    scoredLeads: la.scored,
    qualifiedPct: la.scored ? (qualifiedLike / la.scored) * 100 : null,
    meetingsBooked: bookingAgg[0]?.n ?? 0,
    avgFirstResponseMs: la.avgResponseMs === null ? null : Number(la.avgResponseMs),
    respondedLeads: la.responded,
    avgCostPerLead: ra.leadsWithRuns ? Number(ra.cost) / ra.leadsWithRuns : null,
    totalCost: Number(ra.cost),
    totalRuns: ra.runs,
    avgRunLatencyMs: ra.avgLatency === null ? null : Number(ra.avgLatency),
    statusCounts,
    daily,
    recentRuns: recent.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })),
  };
}
