import { count } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { demoMode, parseEnv, resetEnvCache } from "@/lib/env";
import {
  NotReplayableError,
  parseRecordings,
  replayRun,
  replaySchedule,
  upsertRecording,
  type Recording,
} from "@/lib/replay";
import { runAgent } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { leads } from "@/server/db/schema";
import { buildRecording } from "@/server/demo/recordings";
import { DevFakeLlm } from "@/server/llm/fake";
import type * as AuthModule from "@/server/auth";
import type * as LlmModule from "@/server/llm/anthropic";
import type * as RecordingsModule from "@/server/demo/recordings";
import { FakeLlm } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

// ── Route dependencies: who is asking, and spies proving no model/agent is touched ──
const viewer = vi.hoisted(() => ({ current: { isAdmin: false } }));
const recordings = vi.hoisted(() => ({ list: [] as unknown[] }));
const getLlm = vi.hoisted(() => vi.fn(() => ({ model: "should-not-be-called" })));
const startAgentRun = vi.hoisted(() => vi.fn(async () => ({ runId: "run_x" })));

vi.mock("@/server/auth", async (orig) => ({
  ...(await orig<typeof AuthModule>()),
  getViewer: async () => ({
    role: viewer.current.isAdmin ? "admin" : "public",
    isAdmin: viewer.current.isAdmin,
    authConfigured: true,
    publicDemo: true,
  }),
}));
vi.mock("@/server/llm/anthropic", async (orig) => ({
  ...(await orig<typeof LlmModule>()),
  getLlm,
}));
vi.mock("@/server/agent/trigger", () => ({ startAgentRun, runAgentInBackground: vi.fn() }));
vi.mock("@/server/demo/recordings", async (orig) => ({
  ...(await orig<typeof RecordingsModule>()),
  loadRecordings: () => recordings.list,
}));

let db: Database;
let realRecording: Recording;

beforeAll(async () => {
  db = await createTestDb();
  // A real-model-shaped run (scripted LLM whose model isn't the dev fake) → a valid recording.
  const lead = await createLead(db);
  const out = await runAgent({
    leadId: lead.id,
    trigger: "simulate",
    llm: new FakeLlm([
      { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
      { text: "Scored and qualified.", stop: "end_turn" },
    ]),
    adapters: testAdapters(),
    db,
  });
  realRecording = await buildRecording(db, out.runId, { id: "seed-1", provider: "test" });
});
beforeEach(() => {
  getLlm.mockClear();
  startAgentRun.mockClear();
  viewer.current = { isAdmin: false };
  recordings.list = [realRecording];
});

const simulate = async () => {
  const { POST } = await import("@/app/api/simulate/route");
  return POST(new NextRequest("http://localhost/api/simulate", { method: "POST" }));
};
const leadCount = async () => (await db.select({ n: count() }).from(leads))[0]!.n;

describe("public demo replay mode", () => {
  it("defaults to replay when PUBLIC_DEMO=true, live otherwise, and DEMO_MODE overrides", () => {
    expect(demoMode(parseEnv({ DATABASE_URL: "x" }))).toBe("replay");
    expect(demoMode(parseEnv({ DATABASE_URL: "x", PUBLIC_DEMO: "false" }))).toBe("live");
    expect(demoMode(parseEnv({ DATABASE_URL: "x", DEMO_MODE: "live" }))).toBe("live");
  });

  it("Simulate lead for a public visitor returns a recording — no LLM, no agent run, no new lead", async () => {
    const before = await leadCount();
    const res = await simulate();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replayId: "seed-1" });
    expect(getLlm).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(await leadCount()).toBe(before);
  });

  it("says so (503) when there is nothing to replay, still without calling the LLM", async () => {
    recordings.list = [];
    const res = await simulate();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "no_recordings" });
    expect(getLlm).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it("admins still run the agent live", async () => {
    viewer.current = { isAdmin: true };
    vi.stubEnv("OPENAI_COMPAT_MODEL", "qwen3.5:9b");
    resetEnvCache();
    try {
      const res = await simulate();
      expect(res.status).toBe(202);
      expect(startAgentRun).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  });

  it("replays with the original relative timing, each wait capped at 3s", () => {
    expect(
      replaySchedule([{ atMs: 500 }, { atMs: 26_500 }, { atMs: 26_510 }, { atMs: 28_000 }]),
    ).toEqual([500, 3500, 3510, 5000]);
    const half = replayRun(realRecording, 1);
    expect(half.run.status).toBe("running");
    expect(half.run.summary).toBeNull();
    expect(half.steps).toHaveLength(1);
    const full = replayRun(realRecording, realRecording.steps.length);
    expect(full.run).toMatchObject({
      status: "completed",
      summary: "Scored and qualified.",
      model: "claude-test-model",
    });
  });
});

describe("fake-LLM runs can never be replayable", () => {
  it("demo recording refuses a run of the development fake LLM", async () => {
    const lead = await createLead(db);
    const out = await runAgent({
      leadId: lead.id,
      trigger: "simulate",
      llm: new DevFakeLlm(),
      adapters: testAdapters(),
      db,
    });
    expect(out.runId).toBeTruthy();
    await expect(buildRecording(db, out.runId, { id: "fake", provider: "x" })).rejects.toThrow(
      NotReplayableError,
    );
  });

  it("the loader drops recordings whose run or steps came from the fake LLM", () => {
    const fakeRun = {
      ...realRecording,
      id: "a",
      run: { ...realRecording.run, model: "dev-fake-llm" },
    };
    const fakeStep = {
      ...realRecording,
      id: "b",
      steps: realRecording.steps.map((s) =>
        s.type === "llm" ? { ...s, output: { ...(s.output as object), model: "dev-fake-llm" } } : s,
      ),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseRecordings([realRecording, fakeRun, fakeStep]).map((r) => r.id)).toEqual([
      "seed-1",
    ]);
    warn.mockRestore();
  });

  it("failed runs are not recorded; re-recording a seed replaces it", async () => {
    const lead = await createLead(db);
    const out = await runAgent({
      leadId: lead.id,
      trigger: "simulate",
      llm: new FakeLlm([{ text: "", stop: "max_tokens" }]),
      adapters: testAdapters(),
      db,
    });
    await expect(buildRecording(db, out.runId, { id: "x", provider: "x" })).rejects.toThrow(
      /ended as "failed"/,
    );
    const newer = { ...realRecording, provider: "newer" };
    expect(upsertRecording([realRecording], newer)).toEqual([newer]);
  });
});
