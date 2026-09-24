import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { agentRuns, agentSteps, approvals, bookings, emails } from "@/server/db/schema";
import { ApprovalError, decideApproval } from "@/server/services/approvals";
import { FakeLlm, lastToolResult, type FakeTurn } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE, setWorkspace, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

const SCRIPT = [
  { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
  { tools: [{ name: "check_availability", input: {} }] },
  (req: Parameters<typeof lastToolResult>[0]): FakeTurn => {
    const slots = (lastToolResult(req, "check_availability") as { slots: { start: string }[] })
      .slots;
    return { tools: [{ name: "book_meeting", input: { start: slots[0]!.start } }] };
  },
  {
    tools: [
      {
        name: "send_email",
        input: {
          purpose: "confirmation",
          subject: "You're booked",
          body: "Hi Sarah, see you at our discovery call. Best, Northwind",
        },
      },
    ],
  },
  { text: "Queued booking and confirmation for approval.", stop: "end_turn" as const },
];

describe("approvals", () => {
  let db: Database;
  const adapters = testAdapters();

  beforeAll(async () => {
    db = await createTestDb();
  });
  beforeEach(async () => {
    await setWorkspace(db, { requireApproval: true });
  });

  async function heldRun() {
    const lead = await createLead(db);
    const run = await runAgent({
      leadId: lead.id,
      trigger: "inbound",
      llm: new FakeLlm(SCRIPT),
      adapters,
      db,
    });
    const held = await db.select().from(approvals).where(eq(approvals.leadId, lead.id));
    return {
      lead,
      run,
      booking: held.find((a) => a.action === "book_meeting")!,
      email: held.find((a) => a.action === "send_email")!,
    };
  }

  it("approve executes the held action and records the decision + action in the trace", async () => {
    const { lead, run, booking } = await heldRun();
    expect(run.status).toBe("awaiting_approval");

    const out = await decideApproval(db, adapters, {
      approvalId: booking.id,
      decision: "approve",
      note: "looks good",
    });
    expect(out.status).toBe("executed");
    expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(1);

    const [decisionRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(decisionRun).toMatchObject({ trigger: "approval", model: "human", status: "completed" });
    const steps = await db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, out.runId))
      .orderBy(asc(agentSteps.idx));
    expect(steps.map((s) => [s.type, s.toolName, s.status])).toEqual([
      ["human", "book_meeting", "ok"],
      ["tool", "book_meeting", "ok"],
    ]);
    expect(steps[0]!.text).toBe("Admin approved book_meeting: looks good");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, booking.id));
    expect(row).toMatchObject({
      status: "executed",
      result: expect.objectContaining({ status: "booked" }),
    });
  });

  it("approve with an edited payload runs the edited version and keeps both in the trace", async () => {
    const { lead, email } = await heldRun();
    const edited = {
      purpose: "confirmation",
      subject: "Edited subject line",
      body: "Hi Sarah, an admin tweaked this confirmation text. Best, Northwind",
    };
    const out = await decideApproval(db, adapters, {
      approvalId: email.id,
      decision: "approve",
      payload: edited,
    });
    expect(out.status).toBe("executed");
    const [sent] = await db.select().from(emails).where(eq(emails.leadId, lead.id));
    expect(sent!.subject).toBe("Edited subject line");
    const [human] = await db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, out.runId))
      .orderBy(asc(agentSteps.idx));
    expect(human!.input).toMatchObject({
      edited: true,
      proposed_payload: expect.objectContaining({ subject: "You're booked" }),
      approved_payload: edited,
    });
  });

  it("rejects an invalid edited payload before claiming the approval", async () => {
    const { email } = await heldRun();
    await expect(
      decideApproval(db, adapters, {
        approvalId: email.id,
        decision: "approve",
        payload: { purpose: "nope", subject: "x", body: "y" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, email.id));
    expect(row!.status).toBe("pending");
  });

  it("reject sends nothing, records the decision, and closes the original run when nothing is left", async () => {
    const { lead, run, booking, email } = await heldRun();
    await decideApproval(db, adapters, { approvalId: booking.id, decision: "reject" });
    let [orig] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.runId));
    expect(orig!.status).toBe("awaiting_approval"); // email still pending
    const out = await decideApproval(db, adapters, {
      approvalId: email.id,
      decision: "reject",
      note: "wrong tone",
    });
    expect(out).toMatchObject({ status: "rejected", result: null });
    expect(await db.select().from(bookings).where(eq(bookings.leadId, lead.id))).toHaveLength(0);
    expect(await db.select().from(emails).where(eq(emails.leadId, lead.id))).toHaveLength(0);
    [orig] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.runId));
    expect(orig!.status).toBe("completed");
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: "human",
      output: { decision: "reject", decided_by: "admin" },
    });
  });

  it("cannot be decided twice", async () => {
    const { booking } = await heldRun();
    await decideApproval(db, adapters, { approvalId: booking.id, decision: "approve" });
    const second = decideApproval(db, adapters, { approvalId: booking.id, decision: "approve" });
    await expect(second).rejects.toBeInstanceOf(ApprovalError);
    await expect(second).rejects.toMatchObject({ status: 409 });
  });

  it("refuses while the agent is running on the same lead, leaving the approval pending", async () => {
    const { lead, booking } = await heldRun();
    await db.insert(agentRuns).values({ leadId: lead.id, trigger: "reply", model: "t" }); // in-flight
    await expect(
      decideApproval(db, adapters, { approvalId: booking.id, decision: "approve" }),
    ).rejects.toMatchObject({ status: 409 });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, booking.id));
    expect(row!.status).toBe("pending");
  });
});
