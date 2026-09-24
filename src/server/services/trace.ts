import "server-only";
import { desc, eq } from "drizzle-orm";
import { sweepStaleRuns, getSteps } from "../agent/runs";
import { getDb } from "../db/client";
import { agentRuns, approvals, leads, type AgentRun, type AgentStep } from "../db/schema";
import { redactDeep } from "../security/redact";

export type RunSummary = Pick<
  AgentRun,
  | "id"
  | "trigger"
  | "status"
  | "model"
  | "inputTokens"
  | "outputTokens"
  | "costUsd"
  | "latencyMs"
  | "summary"
  | "error"
> & { startedAt: string; finishedAt: string | null };

export type TraceStep = Omit<AgentStep, "createdAt" | "runId"> & { createdAt: string };

export type ApprovalState = { status: string; decidedAt: string | null };

export type LeadTrace = {
  /** Decision state of every held action, keyed by approval id (steps reference it). */
  approvals: Record<string, ApprovalState>;
  lead: {
    id: string;
    status: string;
    score: number | null;
    riskFlags: string[];
    riskMatches: string[];
  };
  runs: RunSummary[];
  selectedRunId: string | null;
  steps: TraceStep[];
};

const toRun = (r: AgentRun): RunSummary => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  model: r.model,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  costUsd: r.costUsd,
  latencyMs: r.latencyMs,
  summary: r.summary,
  error: r.error,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** Everything the trace timeline needs, in one poll-friendly payload. */
export async function getLeadTrace(
  leadId: string,
  opts: { runId?: string | null; redact: boolean },
): Promise<LeadTrace | null> {
  const db = getDb();
  // Polling is also the heartbeat that unsticks runs whose function died.
  await sweepStaleRuns(db);
  const [lead] = await db
    .select({
      id: leads.id,
      status: leads.status,
      score: leads.score,
      riskFlags: leads.riskFlags,
      riskMatches: leads.riskMatches,
    })
    .from(leads)
    .where(eq(leads.id, leadId));
  if (!lead) return null;
  const runs = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.leadId, leadId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(20);
  const selected = runs.find((r) => r.id === opts.runId) ?? runs[0] ?? null;
  const steps = selected ? await getSteps(db, selected.id) : [];
  const approvalRows = await db
    .select({ id: approvals.id, status: approvals.status, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(eq(approvals.leadId, leadId));
  const trace: LeadTrace = {
    approvals: Object.fromEntries(
      approvalRows.map((a) => [
        a.id,
        { status: a.status, decidedAt: a.decidedAt?.toISOString() ?? null },
      ]),
    ),
    lead,
    runs: runs.map(toRun),
    selectedRunId: selected?.id ?? null,
    steps: steps.map(({ runId: _r, createdAt, ...s }) => ({
      ...s,
      createdAt: createdAt.toISOString(),
    })),
  };
  return opts.redact ? redactDeep(trace) : trace;
}
