import { z } from "zod";
import type { RunSummary, TraceStep } from "@/server/services/trace";

/**
 * Recorded real agent runs for the public demo's replay mode. `pnpm demo:record` runs the agent
 * with a real model and snapshots the run (lead, steps with their original timing, outcome) into
 * demo/recordings.json, which is committed and deployed with the app. Public visitors then watch
 * a replay — no model calls, no cost — while admins still run the agent live.
 *
 * Runs of the development fake LLM can never become recordings: they say nothing about how a
 * real model behaves, and the replay badge promises "a real run".
 */

export const FAKE_LLM_MODEL = "dev-fake-llm";
export const REPLAYABLE_STATUSES = ["completed", "awaiting_approval"] as const;

const stepSchema = z.object({
  id: z.string(),
  idx: z.number().int(),
  type: z.enum(["llm", "tool", "human"]),
  toolName: z.string().nullable(),
  toolUseId: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  text: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  latencyMs: z.number(),
  status: z.enum(["ok", "error", "pending_approval"]),
  /** Milliseconds after the run started when the step was recorded (its original timing). */
  atMs: z.number().nonnegative(),
});

export const recordingSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/),
    recordedAt: z.string(),
    /** Human label of the provider at record time, e.g. "OpenAI-compatible · qwen3.5:9b (local…)". */
    provider: z.string(),
    lead: z.object({
      name: z.string().nullable(),
      company: z.string().nullable(),
      email: z.string().nullable(),
      website: z.string().nullable(),
      message: z.string(),
    }),
    outcome: z.object({
      status: z.string(),
      score: z.number().nullable(),
      qualification: z.unknown(),
    }),
    run: z.object({
      trigger: z.string(),
      status: z.enum(REPLAYABLE_STATUSES),
      model: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
      billingTier: z.string().nullable(),
      latencyMs: z.number(),
      summary: z.string().nullable(),
    }),
    steps: z.array(stepSchema).min(1),
  })
  .superRefine((r, ctx) => {
    const fake =
      r.run.model === FAKE_LLM_MODEL ||
      r.steps.some((s) => (s.output as { model?: unknown } | null)?.model === FAKE_LLM_MODEL);
    if (fake) {
      ctx.addIssue({
        code: "custom",
        path: ["run", "model"],
        message: "runs of the development fake LLM can't be replayed as real runs",
      });
    }
    if (!r.steps.some((s) => s.type === "llm")) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "no model calls recorded" });
    }
  });

export type Recording = z.infer<typeof recordingSchema>;

export class NotReplayableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotReplayableError";
  }
}

/** Validates recordings (e.g. the committed JSON); invalid or fake ones are dropped with a warning. */
export function parseRecordings(raw: unknown): Recording[] {
  if (!Array.isArray(raw)) return [];
  const out: Recording[] = [];
  for (const item of raw) {
    const parsed = recordingSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else console.warn(`[demo] skipping invalid recording: ${parsed.error.issues[0]?.message}`);
  }
  return out;
}

/** Replaces the recording with the same id (re-recording a seed), keeps the rest in order. */
export function upsertRecording(list: Recording[], rec: Recording): Recording[] {
  const i = list.findIndex((r) => r.id === rec.id);
  if (i < 0) return [...list, rec];
  return list.map((r, j) => (j === i ? rec : r));
}

/** When each step appears in a replay: original gaps, each wait capped (default 3s). */
export function replaySchedule(steps: Pick<Recording["steps"][number], "atMs">[], capMs = 3000) {
  let prev = 0;
  let t = 0;
  return steps.map((s) => {
    t += Math.min(capMs, Math.max(0, s.atMs - prev));
    prev = s.atMs;
    return t;
  });
}

/** Shapes a (partially revealed) recording like a live trace so the same timeline renders it. */
export function replayRun(
  rec: Recording,
  revealed: number,
): { run: RunSummary; steps: TraceStep[] } {
  const done = revealed >= rec.steps.length;
  const shown = rec.steps.slice(0, revealed);
  const sum = (k: "inputTokens" | "outputTokens" | "costUsd") =>
    shown.reduce((a, s) => a + (s.type === "llm" ? s[k] : 0), 0);
  return {
    run: {
      id: `replay-${rec.id}`,
      trigger: rec.run.trigger as RunSummary["trigger"],
      status: done ? rec.run.status : "running",
      model: rec.run.model,
      inputTokens: done ? rec.run.inputTokens : sum("inputTokens"),
      outputTokens: done ? rec.run.outputTokens : sum("outputTokens"),
      costUsd: done ? rec.run.costUsd : sum("costUsd"),
      billingTier: rec.run.billingTier,
      latencyMs: done ? rec.run.latencyMs : (shown.at(-1)?.atMs ?? 0),
      summary: done ? rec.run.summary : null,
      error: null,
      startedAt: new Date(new Date(rec.recordedAt).getTime() - rec.run.latencyMs).toISOString(),
      finishedAt: done ? rec.recordedAt : null,
    },
    steps: shown.map(({ atMs, ...s }) => ({
      ...s,
      createdAt: new Date(
        new Date(rec.recordedAt).getTime() - rec.run.latencyMs + atMs,
      ).toISOString(),
    })),
  };
}
