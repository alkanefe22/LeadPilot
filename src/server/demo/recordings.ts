import "server-only";
import { asc, eq } from "drizzle-orm";
import recordingsJson from "../../../demo/recordings.json";
import {
  FAKE_LLM_MODEL,
  NotReplayableError,
  parseRecordings,
  recordingSchema,
  REPLAYABLE_STATUSES,
  type Recording,
} from "@/lib/replay";
import type { Database } from "../db/client";
import { agentRuns, agentSteps, leads } from "../db/schema";

let cached: Recording[] | undefined;

/** The committed recordings (demo/recordings.json), validated once. */
export function loadRecordings(): Recording[] {
  cached ??= parseRecordings(recordingsJson);
  return cached;
}

export function getRecording(id: string): Recording | null {
  return loadRecordings().find((r) => r.id === id) ?? null;
}

export function pickRecording(list: Recording[], random = Math.random): Recording | null {
  return list.length ? list[Math.floor(random() * list.length)]! : null;
}

/** Snapshots a finished run from the database. Throws NotReplayableError for fake/failed runs. */
export async function buildRecording(
  db: Database,
  runId: string,
  meta: { id: string; provider: string },
): Promise<Recording> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw new NotReplayableError(`run ${runId} not found`);
  if (run.model === FAKE_LLM_MODEL) {
    throw new NotReplayableError("runs of the development fake LLM can't be recorded");
  }
  if (!(REPLAYABLE_STATUSES as readonly string[]).includes(run.status)) {
    throw new NotReplayableError(
      `run ended as "${run.status}"${run.error ? `: ${run.error}` : ""}`,
    );
  }
  const [lead] = await db.select().from(leads).where(eq(leads.id, run.leadId));
  const steps = await db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(asc(agentSteps.idx));
  const start = run.startedAt.getTime();
  const recording = {
    version: 1 as const,
    id: meta.id,
    recordedAt: (run.finishedAt ?? run.startedAt).toISOString(),
    provider: meta.provider,
    lead: {
      name: lead?.name ?? null,
      company: lead?.company ?? null,
      email: lead?.email ?? null,
      website: lead?.website ?? null,
      message: lead?.message ?? "",
    },
    outcome: {
      status: lead?.status ?? "new",
      score: lead?.score ?? null,
      qualification: lead?.qualification ?? null,
    },
    run: {
      trigger: run.trigger,
      status: run.status as Recording["run"]["status"],
      model: run.model,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: run.costUsd,
      billingTier: run.billingTier,
      latencyMs: run.latencyMs,
      summary: run.summary,
    },
    steps: steps.map(({ runId: _r, createdAt, ...s }) => ({
      ...s,
      atMs: Math.max(0, createdAt.getTime() - start),
    })),
  };
  const parsed = recordingSchema.safeParse(recording);
  if (!parsed.success) throw new NotReplayableError(parsed.error.issues[0]!.message);
  return parsed.data;
}
