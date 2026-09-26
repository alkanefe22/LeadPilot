import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "@/server/agent/loop";
import { buildSystemPrompt } from "@/server/agent/prompt";
import { isKnown } from "@/server/agent/tools/helpers";
import type { Database } from "@/server/db/client";
import { agentSteps, bookings, workspaces } from "@/server/db/schema";
import { FakeLlm, lastToolResult } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, setWorkspace, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

// Strong fit, but the lead never said how much or when (what small models tend to book anyway).
const NO_BUDGET = { ...GOOD_SCORE, budget: null, timeline: "not specified", missing: ["budget"] };

describe("rule: budget and timeline before booking", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  const script = (score: typeof GOOD_SCORE | typeof NO_BUDGET) =>
    new FakeLlm([
      { tools: [{ name: "score_lead", input: score }] },
      { tools: [{ name: "check_availability", input: {} }] },
      (req) => ({
        tools: [
          {
            name: "book_meeting",
            input: {
              start: (lastToolResult(req, "check_availability") as { slots: { start: string }[] })
                .slots[0]!.start,
            },
          },
        ],
      }),
      { text: "Done.", stop: "end_turn" },
    ]);

  it("refuses to book when budget or timeline is unknown, telling the model to ask instead", async () => {
    const lead = await createLead(db);
    const out = await runAgent({
      leadId: lead.id,
      trigger: "rerun", // no nudge: keep the scripted turns aligned
      llm: script(NO_BUDGET),
      adapters: testAdapters(),
      db,
    });
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const book = steps.find((s) => s.toolName === "book_meeting")!;
    expect(book.status).toBe("error");
    expect((book.output as { error: string }).error).toMatch(
      /budget and timeline must be known before booking \(missing: budget, timeline\).*ask_followup_question/,
    );
    expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(0);
  });

  it("books normally when both are stated, and can be switched off per workspace", async () => {
    const ok = await createLead(db);
    await runAgent({
      leadId: ok.id,
      trigger: "rerun",
      llm: script(GOOD_SCORE),
      adapters: testAdapters(),
      db,
    });
    expect(await db.select().from(bookings).where(eq(bookings.leadId, ok.id))).toHaveLength(1);

    await setWorkspace(db, { requireBudgetTimelineToBook: false });
    try {
      const lead = await createLead(db);
      await runAgent({
        leadId: lead.id,
        trigger: "rerun",
        llm: script(NO_BUDGET),
        adapters: testAdapters(),
        db,
      });
      expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(1);
    } finally {
      await setWorkspace(db, { requireBudgetTimelineToBook: true });
    }
  });

  it("treats placeholder answers as unknown", () => {
    for (const v of [
      null,
      "",
      "  ",
      "N/A",
      "unknown",
      "Not specified",
      "not mentioned.",
      "TBD",
      "?",
    ]) {
      expect(isKnown(v)).toBe(false);
    }
    for (const v of ["$20k", "~250.000 TL", "next month", "Q1", "within 4 weeks"]) {
      expect(isKnown(v)).toBe(true);
    }
  });

  it("tells the model about the rule only when it is on", async () => {
    const [ws] = await db.select().from(workspaces);
    expect(buildSystemPrompt(ws!)).toContain(
      "Booking requires BOTH a stated budget and a stated timeline",
    );
    expect(buildSystemPrompt({ ...ws!, requireBudgetTimelineToBook: false })).not.toContain(
      "Booking requires BOTH",
    );
  });
});
