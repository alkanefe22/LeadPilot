import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { executeToolCall } from "@/server/agent/executor";
import type { ToolContext } from "@/server/agent/types";
import type { Database } from "@/server/db/client";
import { agentRuns, bookings, emails, messages, workspaces } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID } from "@/server/db/seed-data";
import { sendLeadEmail } from "@/server/services/email";
import { isUniqueViolation } from "@/server/db/errors";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

async function makeCtx(db: Database): Promise<ToolContext> {
  const lead = await createLead(db);
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
  const [run] = await db
    .insert(agentRuns)
    .values({ leadId: lead.id, trigger: "inbound", model: "t" })
    .returning();
  return {
    db,
    adapters: testAdapters(),
    workspace: workspace!,
    lead,
    runId: run!.id,
    trigger: "inbound",
    now: () => new Date(),
    state: { qualification: null, approvalsQueued: 0, outwardActions: [] },
    approved: false,
  };
}

describe("idempotency", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  it("never books the same lead twice (tool level)", async () => {
    const ctx = await makeCtx(db);
    await executeToolCall("score_lead", GOOD_SCORE, ctx);
    const avail = await executeToolCall("check_availability", {}, ctx);
    const slots = avail.output.slots as { start: string }[];
    const first = await executeToolCall("book_meeting", { start: slots[0]!.start }, ctx);
    const second = await executeToolCall("book_meeting", { start: slots[1]!.start }, ctx);
    expect(first.output.status).toBe("booked");
    expect(second.output.status).toBe("already_booked");
    expect(second.output.booking_id).toBe(first.output.booking_id);
    const rows = await db.select().from(bookings).where(eq(bookings.leadId, ctx.lead.id));
    expect(rows).toHaveLength(1);
    expect(ctx.lead.status).toBe("booked");
  });

  it("enforces one confirmed booking per lead at the database level", async () => {
    const ctx = await makeCtx(db);
    const values = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      leadId: ctx.lead.id,
      startAt: new Date(),
      endAt: new Date(),
      title: "x",
      provider: "mock",
    };
    await db.insert(bookings).values(values);
    const err = await db
      .insert(bookings)
      .values(values)
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    // A cancelled booking doesn't block a new one.
    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.leadId, ctx.lead.id));
    await expect(db.insert(bookings).values(values)).resolves.toBeDefined();
  });

  it("sends an identical email only once and records one outbound thread message", async () => {
    const ctx = await makeCtx(db);
    const args = {
      db,
      adapter: ctx.adapters.email,
      workspace: ctx.workspace,
      lead: ctx.lead,
      subject: "Your discovery call",
      body: "Hi Sarah, your call is booked for Tuesday. Talk soon!",
      kind: "confirmation",
    };
    const a = await sendLeadEmail(args);
    const b = await sendLeadEmail({
      ...args,
      body: "  Hi Sarah, your call is booked for   Tuesday. Talk soon! ",
    });
    expect(a.status).toBe("sent");
    expect(b.status).toBe("duplicate");
    expect(await db.select().from(emails).where(eq(emails.leadId, ctx.lead.id))).toHaveLength(1);
    const outbound = (
      await db.select().from(messages).where(eq(messages.leadId, ctx.lead.id))
    ).filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
  });

  it("releases the idempotency key when the provider fails, so a retry can send", async () => {
    const ctx = await makeCtx(db);
    const failing = {
      name: "console" as const,
      send: async () => Promise.reject(new Error("boom")),
      testConnection: async () => ({ ok: true as const, detail: "" }),
    };
    const args = {
      db,
      workspace: ctx.workspace,
      lead: ctx.lead,
      subject: "Hello there",
      body: "A body that is long enough.",
      kind: "reply",
    };
    expect((await sendLeadEmail({ ...args, adapter: failing })).status).toBe("failed");
    expect((await sendLeadEmail({ ...args, adapter: ctx.adapters.email })).status).toBe("sent");
  });

  it("allows only one running agent run per lead", async () => {
    const ctx = await makeCtx(db);
    const err = await db
      .insert(agentRuns)
      .values({ leadId: ctx.lead.id, trigger: "rerun", model: "t" })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });
});
