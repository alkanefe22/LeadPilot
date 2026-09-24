import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { isWorkComplete, runAgent } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { agentRuns } from "@/server/db/schema";
import type { LlmClient, LlmRequest, LlmResponse } from "@/server/llm/types";
import { FakeLlm, lastToolResult, type FakeTurn } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

/** Plays a script, then hangs (until the run's time budget aborts it) on the next call. */
function hangAfter(script: ConstructorParameters<typeof FakeLlm>[0]): LlmClient {
  const fake = new FakeLlm(script);
  let n = 0;
  return {
    model: fake.model,
    create(req: LlmRequest): Promise<LlmResponse> {
      if (n++ < script.length) return fake.create(req);
      return new Promise((_, reject) =>
        req.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
  };
}

const book = (req: Parameters<typeof lastToolResult>[0]): FakeTurn => ({
  tools: [
    {
      name: "book_meeting",
      input: {
        start: (lastToolResult(req, "check_availability") as { slots: { start: string }[] })
          .slots[0]!.start,
      },
    },
  ],
});

describe("time budget", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });
  const run = (llm: LlmClient, leadId: string) =>
    runAgent({
      leadId,
      trigger: "inbound",
      llm,
      adapters: testAdapters(),
      db,
      limits: { timeBudgetMs: 300 },
    });

  it("completes (summary skipped) when all actions are done and only the closing summary timed out", async () => {
    const lead = await createLead(db);
    const out = await run(
      hangAfter([
        { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
        { tools: [{ name: "check_availability", input: {} }] },
        book,
        {
          tools: [
            {
              name: "send_email",
              input: {
                purpose: "confirmation",
                subject: "Booked",
                body: "Hi Sarah, your discovery call is booked. Best, Northwind",
              },
            },
            { name: "upsert_crm_contact", input: { status: "booked" } },
          ],
        },
      ]),
      lead.id,
    );
    expect(out.status).toBe("completed");
    expect(out.error).toBeNull();
    expect(out.summary).toBe(
      "Summary skipped (time budget). Completed: score_lead, check_availability, book_meeting, send_email, upsert_crm_contact.",
    );
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(row).toMatchObject({ status: "completed", error: null });
  });

  it("still fails when real work is unfinished (booked, but no confirmation or CRM yet)", async () => {
    const out = await run(
      hangAfter([
        { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
        { tools: [{ name: "check_availability", input: {} }] },
        book,
      ]),
      (await createLead(db)).id,
    );
    expect(out).toMatchObject({ status: "failed", error: "Run exceeded its time budget of 0s." });
  });

  it("isWorkComplete: terminal action + CRM (not needed for spam), no errors in the last turn", () => {
    const base = { qualification: null, approvalsQueued: 0, outwardActions: [] };
    expect(
      isWorkComplete({
        ...base,
        completedTools: ["score_lead", "ask_followup_question", "upsert_crm_contact"],
      }),
    ).toBe(true);
    expect(
      isWorkComplete({ ...base, completedTools: ["score_lead", "ask_followup_question"] }),
    ).toBe(false);
    const spam = {
      score: 2,
      category: "spam" as const,
      reasoning: "x",
      budget: null,
      timeline: null,
      need: null,
      authority: null,
      missing: [],
    };
    expect(
      isWorkComplete({
        ...base,
        qualification: spam,
        completedTools: ["score_lead", "mark_disqualified"],
      }),
    ).toBe(true);
    expect(
      isWorkComplete({
        ...base,
        completedTools: ["book_meeting", "send_email", "upsert_crm_contact"],
        lastTurnHadErrors: true,
      }),
    ).toBe(false);
  });
});
