import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { agentSteps, emails } from "@/server/db/schema";
import { FakeLlm, lastToolResult } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

const confirm = (body: string) => ({
  tools: [{ name: "send_email", input: { purpose: "confirmation", subject: "Booked", body } }],
});

describe("rule: one confirmation email per booking", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });
  const run = (llm: FakeLlm, leadId: string) =>
    runAgent({ leadId, trigger: "rerun", llm, adapters: testAdapters(), db });

  it("a re-run can't re-send the confirmation, even worded differently", async () => {
    const lead = await createLead(db);
    await run(
      new FakeLlm([
        { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
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
        confirm("Hi Sarah, your call is booked. Best, Northwind"),
        { text: "Done.", stop: "end_turn" },
      ]),
      lead.id,
    );
    const second = await run(
      new FakeLlm([
        confirm("Hello again Sarah — just confirming your discovery call. Best, Northwind"),
        { text: "Done.", stop: "end_turn" },
      ]),
      lead.id,
    );
    const sent = await db.select().from(emails).where(eq(emails.leadId, lead.id));
    expect(sent.filter((e) => e.kind === "confirmation")).toHaveLength(1);
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, second.runId));
    expect(steps.find((s) => s.toolName === "send_email")).toMatchObject({
      status: "error",
      output: { error: expect.stringContaining("already sent") },
    });
  });

  it("refuses a confirmation when nothing was booked", async () => {
    const lead = await createLead(db);
    const out = await run(
      new FakeLlm([
        confirm("Hi Sam, you are booked for a discovery call next week. Best, Northwind"),
        { text: "Done.", stop: "end_turn" },
      ]),
      lead.id,
    );
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    expect(steps.find((s) => s.toolName === "send_email")).toMatchObject({
      status: "error",
      output: { error: expect.stringContaining("needs a confirmed booking") },
    });
    expect(await db.select().from(emails).where(eq(emails.leadId, lead.id))).toHaveLength(0);
  });
});
