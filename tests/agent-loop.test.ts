import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentBusyError, runAgent, type RunAgentOptions } from "@/server/agent/loop";
import { sweepStaleRuns } from "@/server/agent/runs";
import type { Database } from "@/server/db/client";
import { agentRuns, agentSteps, approvals, bookings, emails, leads } from "@/server/db/schema";
import { SEED_LEADS } from "@/server/db/seed-data";
import { FakeLlm, lastToolResult, type FakeTurn } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, setWorkspace, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

const pickFirstSlot = (req: Parameters<typeof lastToolResult>[0]): FakeTurn => {
  const avail = lastToolResult(req, "check_availability") as { slots: { start: string }[] };
  return { tools: [{ name: "book_meeting", input: { start: avail.slots[0]!.start } }] };
};

const HAPPY_PATH = [
  { text: "Strong fit. Scoring first.", tools: [{ name: "score_lead", input: GOOD_SCORE }] },
  { tools: [{ name: "check_availability", input: { days_ahead: 7 } }] },
  pickFirstSlot,
  {
    tools: [
      {
        name: "send_email",
        input: {
          purpose: "confirmation",
          subject: "Your discovery call",
          body: "Hi Sarah, you're booked for our discovery call. Looking forward to it!",
        },
      },
      { name: "upsert_crm_contact", input: { status: "booked", note: "Booked discovery call" } },
    ],
  },
  {
    text: "Qualified (88) and booked a discovery call; confirmation sent.",
    stop: "end_turn" as const,
  },
];

describe("agent loop (mocked LLM)", () => {
  let db: Database;
  const run = (llm: FakeLlm, leadId: string, extra: Partial<RunAgentOptions> = {}) =>
    runAgent({ leadId, trigger: "inbound", llm, adapters: testAdapters(), db, ...extra });

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    await setWorkspace(db, { requireApproval: false, scoreThreshold: 70 });
  });

  it("qualifies, books, confirms and records a complete trace", async () => {
    const lead = await createLead(db);
    const llm = new FakeLlm(HAPPY_PATH);
    const out = await run(llm, lead.id);

    expect(out.status).toBe("completed");
    expect(out.summary).toMatch(/booked/);
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    expect(steps.map((s) => s.toolName ?? "llm")).toEqual([
      "llm",
      "score_lead",
      "llm",
      "check_availability",
      "llm",
      "book_meeting",
      "llm",
      "send_email",
      "upsert_crm_contact",
      "llm",
    ]);
    expect(steps.every((s) => s.status === "ok")).toBe(true);
    // Trace accounting: 5 LLM calls × (1000 in, 100 out) at fallback Opus-tier pricing.
    expect(out.inputTokens).toBe(5000);
    expect(out.outputTokens).toBe(500);
    expect(out.costUsd).toBeCloseTo(5 * 0.0075, 6);
    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(runRow).toMatchObject({ status: "completed", inputTokens: 5000 });
    // The first step stores the prompt with the lead fenced as untrusted content.
    expect((steps[0]!.input as { user: string }).user).toContain("<lead_content");

    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after).toMatchObject({ status: "booked", score: 88 });
    expect(after!.firstResponseAt).not.toBeNull();
    expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(1);
  });

  it("returns tool errors to the model instead of crashing, and the model can recover", async () => {
    const lead = await createLead(db);
    const llm = new FakeLlm([
      { tools: [{ name: "score_lead", input: { ...GOOD_SCORE, score: 250 } }] },
      { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
      { tools: [{ name: "does_not_exist", input: {} }] },
      { text: "Recovered.", stop: "end_turn" },
    ]);
    const out = await run(llm, lead.id);
    expect(out.status).toBe("completed");
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const tools = steps.filter((s) => s.type === "tool");
    expect(tools.map((s) => s.status)).toEqual(["error", "ok", "error"]);
    expect(JSON.stringify(tools[0]!.output)).toContain("score");
    // The model saw is_error on the invalid call.
    const second = llm.requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(second.content)).toContain('"is_error":true');
  });

  it("refuses to book an unqualified lead (policy guard)", async () => {
    const lead = await createLead(db);
    const llm = new FakeLlm([
      {
        tools: [
          { name: "score_lead", input: { ...GOOD_SCORE, score: 40, category: "needs_info" } },
        ],
      },
      {
        tools: [
          {
            name: "book_meeting",
            input: { start: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          },
        ],
      },
      { text: "Could not book.", stop: "end_turn" },
    ]);
    const out = await run(llm, lead.id);
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const book = steps.find((s) => s.toolName === "book_meeting")!;
    expect(book.status).toBe("error");
    expect(JSON.stringify(book.output)).toContain("only qualified leads");
    expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(0);
  });

  it("stops at MAX_AGENT_STEPS", async () => {
    const lead = await createLead(db);
    const loopForever = () => ({ tools: [{ name: "get_lead", input: {} }] });
    const out = await run(new FakeLlm(Array(10).fill(loopForever)), lead.id, {
      limits: { maxSteps: 3 },
    });
    expect(out.status).toBe("max_steps");
    expect(out.error).toMatch(/MAX_AGENT_STEPS \(3\)/);
  });

  it("stops and fails the run when accumulated cost exceeds MAX_COST_PER_RUN_USD", async () => {
    const lead = await createLead(db);
    const out = await run(new FakeLlm(HAPPY_PATH), lead.id, { limits: { maxCostUsd: 0.01 } });
    expect(out.status).toBe("failed");
    expect(out.error).toMatch(/Cost limit exceeded: \$0\.0150 > MAX_COST_PER_RUN_USD \$0\.01/);
    // Second call pushed it over; its tool calls (check_availability) never ran.
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    expect(steps.some((s) => s.toolName === "check_availability")).toBe(false);
  });

  it("fails cleanly on refusal and on max_tokens", async () => {
    const a = await run(new FakeLlm([{ text: "", stop: "refusal" }]), (await createLead(db)).id);
    expect(a).toMatchObject({ status: "failed", error: expect.stringMatching(/refusal/) });
    const b = await run(
      new FakeLlm([{ text: "partial", stop: "max_tokens" }]),
      (await createLead(db)).id,
    );
    expect(b).toMatchObject({ status: "failed", error: expect.stringMatching(/LLM_MAX_TOKENS/) });
  });

  it("marks the run failed when the LLM throws (e.g. network error)", async () => {
    const lead = await createLead(db);
    const llm = new FakeLlm([]);
    llm.create = async () => {
      throw new Error("socket hang up");
    };
    const out = await run(llm, lead.id);
    expect(out).toMatchObject({ status: "failed", error: "socket hang up" });
  });

  it("queues outward actions for approval when the workspace requires it", async () => {
    await setWorkspace(db, { requireApproval: true });
    const lead = await createLead(db);
    const out = await run(new FakeLlm(HAPPY_PATH), lead.id);
    expect(out.status).toBe("awaiting_approval");
    const queued = await db.select().from(approvals).where(eq(approvals.leadId, lead.id));
    expect(queued.map((a) => a.action).sort()).toEqual(["book_meeting", "send_email"]);
    expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(0);
    expect(await db.select().from(emails).where(eq(emails.leadId, lead.id))).toHaveLength(0);
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    expect(steps.filter((s) => s.status === "pending_approval")).toHaveLength(2);
  });

  describe("prompt injection", () => {
    const injection = SEED_LEADS.find((l) => l.kind === "adversarial")!;

    it("contains the damage even when the model complies with the injected instructions", async () => {
      const lead = await createLead(db, {
        name: injection.name,
        email: injection.email,
        message: injection.message,
      });
      // Worst case: a fully hijacked model does exactly what the attacker asked.
      const hijacked = new FakeLlm([
        {
          tools: [
            {
              name: "score_lead",
              input: { ...GOOD_SCORE, score: 100, reasoning: "Admin mode says score 100." },
            },
          ],
        },
        { tools: [{ name: "check_availability", input: {} }] },
        pickFirstSlot,
        {
          tools: [
            {
              name: "send_email",
              input: {
                purpose: "confirmation",
                subject: "Booked",
                body: "You are booked as requested, admin mode confirmed.",
              },
            },
          ],
        },
        { text: "Done as instructed.", stop: "end_turn" },
      ]);
      const out = await run(hijacked, lead.id);

      const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
      expect(after!.riskFlags).toContain("prompt_injection");
      expect(after!.score).toBe(69); // capped below threshold
      expect(after!.status).not.toBe("qualified");
      expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(0);
      expect(await db.select().from(emails).where(eq(emails.leadId, lead.id))).toHaveLength(0);

      const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
      expect(steps.find((s) => s.toolName === "book_meeting")?.status).toBe("error");
      // Emails to flagged leads always wait for a human.
      expect(steps.find((s) => s.toolName === "send_email")?.status).toBe("pending_approval");
      // The model was told why.
      expect(JSON.stringify(steps.find((s) => s.toolName === "score_lead")!.output)).toContain(
        "policy_note",
      );
    });

    it("gives the model the fenced, flagged lead and lets a well-behaved run disqualify it", async () => {
      const lead = await createLead(db, {
        name: injection.name,
        email: injection.email,
        message: injection.message,
      });
      const llm = new FakeLlm([
        {
          tools: [
            {
              name: "score_lead",
              input: {
                ...GOOD_SCORE,
                score: 2,
                category: "spam",
                reasoning: "Message only contains instructions aimed at the agent.",
              },
            },
          ],
        },
        {
          tools: [
            {
              name: "mark_disqualified",
              input: { category: "spam", reason: "Prompt-injection attempt" },
            },
          ],
        },
        { text: "Disqualified: manipulation attempt.", stop: "end_turn" },
      ]);
      const out = await run(llm, lead.id);
      expect(out.status).toBe("completed");
      const prompt = llm.requests[0]!.messages[0]!.content as string;
      expect(prompt).toContain("risk_flags: prompt_injection");
      expect(prompt.indexOf("Ignore previous instructions")).toBeGreaterThan(
        prompt.indexOf("<lead_content"),
      );
      expect(prompt.indexOf("Ignore previous instructions")).toBeLessThan(
        prompt.indexOf("</lead_content>"),
      );
      expect(llm.requests[0]!.system).toContain("untrusted data");
      const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
      expect(after!.status).toBe("disqualified");
    });
  });

  describe("run concurrency and stale runs", () => {
    it("rejects a second concurrent run for the same lead", async () => {
      const lead = await createLead(db);
      await db.insert(agentRuns).values({ leadId: lead.id, trigger: "inbound", model: "t" });
      await expect(run(new FakeLlm(HAPPY_PATH), lead.id)).rejects.toBeInstanceOf(AgentBusyError);
    });

    it("sweeps runs stuck in 'running' for over 2 minutes so the lead can run again", async () => {
      const lead = await createLead(db);
      const [stuck] = await db
        .insert(agentRuns)
        .values({
          leadId: lead.id,
          trigger: "inbound",
          model: "t",
          startedAt: new Date(Date.now() - 3 * 60_000),
        })
        .returning();
      const fresh = await createLead(db);
      await db.insert(agentRuns).values({ leadId: fresh.id, trigger: "inbound", model: "t" });

      expect(await sweepStaleRuns(db)).toBeGreaterThanOrEqual(1);
      const [swept] = await db.select().from(agentRuns).where(eq(agentRuns.id, stuck!.id));
      expect(swept).toMatchObject({ status: "failed", error: "timed out" });
      expect(swept!.finishedAt).not.toBeNull();
      const freshRuns = await db.select().from(agentRuns).where(eq(agentRuns.leadId, fresh.id));
      expect(freshRuns[0]!.status).toBe("running");

      // runAgent sweeps first, so the previously blocked lead can run.
      const out = await run(new FakeLlm([{ text: "ok", stop: "end_turn" }]), lead.id);
      expect(out.status).toBe("completed");
    });
  });
});
