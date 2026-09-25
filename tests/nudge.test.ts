import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { NUDGE, runAgent, shouldNudge } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { leads } from "@/server/db/schema";
import { FakeLlm } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

describe("continuation nudge (model stops before deciding)", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });
  const run = (llm: FakeLlm, leadId: string, trigger: "inbound" | "rerun" = "inbound") =>
    runAgent({ leadId, trigger, llm, adapters: testAdapters(), db });

  it("reminds the model once when it only wrote text, and the run then continues", async () => {
    const llm = new FakeLlm([
      // What small local models do: narrate, or write the tool call as plain text.
      { text: "<functions=score_lead> category=fit score=88", stop: "end_turn" },
      { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
      { text: "Scored.", stop: "end_turn" },
    ]);
    const lead = await createLead(db);
    const out = await run(llm, lead.id);
    expect(out).toMatchObject({ status: "completed", summary: "Scored." });
    const second = llm.requests[1]!.messages;
    expect(second.at(-1)).toEqual({ role: "user", content: NUDGE });
    const [row] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.score).toBe(GOOD_SCORE.score);
  });

  it("nudges at most once", async () => {
    const llm = new FakeLlm([
      { text: "Thinking about it.", stop: "end_turn" },
      { text: "Still just talking.", stop: "end_turn" },
    ]);
    const out = await run(llm, (await createLead(db)).id);
    expect(llm.requests).toHaveLength(2);
    expect(out.status).toBe("completed");
  });

  it("never nudges re-runs or approvals, or runs that already decided something", () => {
    const base = { qualification: null, approvalsQueued: 0, outwardActions: [] };
    const none = { ...base, completedTools: ["get_lead"] };
    expect(shouldNudge("inbound", none, 0)).toBe(true);
    expect(shouldNudge("reply", none, 0)).toBe(true);
    expect(shouldNudge("rerun", none, 0)).toBe(false);
    expect(shouldNudge("approval", none, 0)).toBe(false);
    expect(shouldNudge("inbound", none, 1)).toBe(false);
    expect(shouldNudge("inbound", { ...base, completedTools: ["score_lead"] }, 0)).toBe(false);
  });

  it("a re-run that just ends is left alone", async () => {
    const llm = new FakeLlm([{ text: "Nothing new to do.", stop: "end_turn" }]);
    const out = await run(llm, (await createLead(db)).id, "rerun");
    expect(llm.requests).toHaveLength(1);
    expect(out.status).toBe("completed");
  });
});
