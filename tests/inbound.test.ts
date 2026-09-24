import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { emails, leads, messages } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID } from "@/server/db/seed-data";
import {
  normalizeInboundEmail,
  stripQuotedReply,
  threadTokenFromAddresses,
} from "@/server/inbound/email";
import { signPayload, verifySignature } from "@/server/inbound/hmac";
import { ingestInboundEmail } from "@/server/inbound/threading";
import { ingestWebhook, webhookPayloadSchema } from "@/server/inbound/webhook";
import { createLead } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

const SECRET = "whsec_test";
const now = new Date("2026-05-01T12:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));

describe("webhook HMAC", () => {
  const body = JSON.stringify({ name: "Ann", message: "hello" });

  it("accepts a correctly signed, fresh request", () => {
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: body,
        signature: signPayload(SECRET, ts, body),
        timestamp: ts,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a tampered body, a wrong secret and missing headers", () => {
    const sig = signPayload(SECRET, ts, body);
    expect(
      verifySignature({ secret: SECRET, rawBody: `${body} `, signature: sig, timestamp: ts, now })
        .ok,
    ).toBe(false);
    expect(
      verifySignature({ secret: "other", rawBody: body, signature: sig, timestamp: ts, now }).ok,
    ).toBe(false);
    expect(
      verifySignature({ secret: SECRET, rawBody: body, signature: null, timestamp: ts, now }).ok,
    ).toBe(false);
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: body,
        signature: "sha256=abc",
        timestamp: ts,
        now,
      }).ok,
    ).toBe(false);
  });

  it("rejects replays outside the 5-minute window (signature bound to timestamp)", () => {
    const old = String(Number(ts) - 301);
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: body,
        signature: signPayload(SECRET, old, body),
        timestamp: old,
        now,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/replay/) });
    // Re-using an old signature with a fresh timestamp fails too.
    expect(
      verifySignature({
        secret: SECRET,
        rawBody: body,
        signature: signPayload(SECRET, old, body),
        timestamp: ts,
        now,
      }).ok,
    ).toBe(false);
  });
});

describe("webhook ingest", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });
  const ws = { id: DEFAULT_WORKSPACE_ID };

  it("requires a message and accepts common aliases", () => {
    expect(webhookPayloadSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(webhookPayloadSchema.safeParse({ notes: "from typeform" }).success).toBe(true);
  });

  it("dedupes retries by external_id — one lead, and the retry reports duplicate", async () => {
    const payload = webhookPayloadSchema.parse({
      external_id: "zap-42",
      name: "Ann",
      email: "ann@acme.io",
      message: "We need an AI SDR",
    });
    const a = await ingestWebhook(db, ws, payload, JSON.stringify(payload));
    const b = await ingestWebhook(db, ws, payload, `${JSON.stringify(payload)}\n`); // different bytes, same id
    expect(a.status).toBe("created");
    expect(b).toEqual({ status: "duplicate", lead: { id: a.lead.id } });
    expect(await db.select().from(leads).where(eq(leads.externalId, "ext:zap-42"))).toHaveLength(1);
  });

  it("dedupes identical retried bodies when no external_id is sent", async () => {
    const raw = JSON.stringify({ name: "Bo", message: "Retry me" });
    const payload = webhookPayloadSchema.parse(JSON.parse(raw));
    expect((await ingestWebhook(db, ws, payload, raw)).status).toBe("created");
    expect((await ingestWebhook(db, ws, payload, raw)).status).toBe("duplicate");
  });
});

describe("inbound email", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  const postmark = (over: Record<string, unknown> = {}) => ({
    From: "Sarah Mitchell <sarah@freightlane.io>",
    FromFull: { Email: "Sarah@FreightLane.io", Name: "Sarah Mitchell" },
    To: "hello@inbound.example",
    ToFull: [{ Email: "hello@inbound.example" }],
    Subject: "Re: A couple of quick questions",
    TextBody:
      "Budget is $20k, we can start next month.\n\nOn Tue, Northwind wrote:\n> Could you share your budget?",
    MessageID: "abc-123",
    Headers: [{ Name: "Message-ID", Value: "<abc-123@mail.example>" }],
    ...over,
  });

  it("normalizes Postmark and strips quoted history", () => {
    const e = normalizeInboundEmail(postmark())!;
    expect(e).toMatchObject({
      provider: "postmark",
      fromEmail: "sarah@freightlane.io",
      fromName: "Sarah Mitchell",
      messageId: "<abc-123@mail.example>",
    });
    expect(e.text).toBe("Budget is $20k, we can start next month.");
  });

  it("normalizes Resend email.received events", () => {
    const e = normalizeInboundEmail({
      type: "email.received",
      data: {
        from: "Ann <ann@acme.io>",
        to: ["reply+t_abc123@inbound.example"],
        subject: "Hi",
        text: "Hello there",
        headers: { "In-Reply-To": "<em_1@x>" },
      },
    })!;
    expect(e).toMatchObject({
      provider: "resend",
      fromEmail: "ann@acme.io",
      inReplyTo: "<em_1@x>",
    });
    expect(threadTokenFromAddresses(e.to)).toBe("t_abc123");
  });

  it("strips common reply separators", () => {
    expect(stripQuotedReply("Yes!\n-----Original Message-----\nFrom: x")).toBe("Yes!");
  });

  it("threads a reply via the reply+token address and records it once", async () => {
    const lead = await createLead(db);
    const e = normalizeInboundEmail(
      postmark({
        ToFull: [{ Email: `reply+${lead.threadToken}@inbound.example` }],
        MessageID: "tok-1",
        Headers: [{ Name: "Message-ID", Value: "<tok-1@mail>" }],
      }),
    )!;
    const r1 = await ingestInboundEmail(db, DEFAULT_WORKSPACE_ID, e);
    const r2 = await ingestInboundEmail(db, DEFAULT_WORKSPACE_ID, e); // provider retry
    expect(r1).toMatchObject({ status: "reply", via: "reply_token", lead: { id: lead.id } });
    expect(r2.status).toBe("duplicate");
    const thread = await db.select().from(messages).where(eq(messages.leadId, lead.id));
    expect(thread.filter((m) => m.direction === "inbound")).toHaveLength(2); // original + reply
  });

  it("threads via In-Reply-To pointing at an email we sent", async () => {
    const lead = await createLead(db);
    await db.insert(emails).values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      leadId: lead.id,
      to: lead.email!,
      from: "a@b.c",
      subject: "s",
      bodyText: "b",
      provider: "console",
      messageIdHeader: "<em_sent_1@leadpilot.local>",
      idempotencyKey: `k-${lead.id}`,
    });
    const e = normalizeInboundEmail(
      postmark({
        FromFull: { Email: "someone.else@acme.io" },
        MessageID: "irt-1",
        Headers: [
          { Name: "Message-ID", Value: "<irt-1@mail>" },
          { Name: "In-Reply-To", Value: "<em_sent_1@leadpilot.local>" },
        ],
      }),
    )!;
    expect(await ingestInboundEmail(db, DEFAULT_WORKSPACE_ID, e)).toMatchObject({
      status: "reply",
      via: "in_reply_to",
      lead: { id: lead.id },
    });
  });

  it("creates a new lead for an unknown sender", async () => {
    const e = normalizeInboundEmail(
      postmark({
        FromFull: { Email: "new@prospect.io", Name: "New Prospect" },
        MessageID: "new-1",
        Headers: [{ Name: "Message-ID", Value: "<new-1@mail>" }],
        TextBody: "Interested in an AI agent",
      }),
    )!;
    const r = await ingestInboundEmail(db, DEFAULT_WORKSPACE_ID, e);
    expect(r).toMatchObject({
      status: "new_lead",
      lead: { source: "email", email: "new@prospect.io", name: "New Prospect" },
    });
  });
});
