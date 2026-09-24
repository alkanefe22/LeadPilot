import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { ConsoleEmailAdapter } from "../adapters/email/console";
import type { EmailAdapter } from "../adapters/email/types";
import type { Database } from "../db/client";
import { isDemoLead } from "./intake";
import { emails, leads, messages, type Lead, type Workspace } from "../db/schema";

export type SendLeadEmailInput = {
  db: Database;
  adapter: EmailAdapter;
  workspace: Workspace;
  lead: Lead;
  subject: string;
  body: string;
  kind: string;
};

export type SendLeadEmailResult =
  | { status: "sent"; emailId: string; messageId: string; provider: string }
  | { status: "duplicate"; emailId: string }
  | { status: "failed"; emailId: string; error: string; cause: unknown };

const consoleAdapter = new ConsoleEmailAdapter();

export function emailIdempotencyKey(leadId: string, subject: string, body: string) {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256")
    .update(`${leadId}\n${norm(subject)}\n${norm(body)}`)
    .digest("hex")
    .slice(0, 40);
}

function senderAddress(workspace: Workspace) {
  return env().EMAIL_FROM ?? `${workspace.senderName} <agent@leadpilot.local>`;
}

/** Replies to this address thread back to the lead (see inbound email handler, M4). */
export function replyToAddress(lead: Lead) {
  const domain = env().INBOUND_EMAIL_DOMAIN;
  return domain ? `reply+${lead.threadToken}@${domain}` : null;
}

/**
 * Sends an email to a lead exactly once. The idempotency key is reserved in the outbox
 * *before* the provider call, so a retried run (or a double-approved action) can never
 * send the same message twice.
 */
export async function sendLeadEmail(input: SendLeadEmailInput): Promise<SendLeadEmailResult> {
  // Demo leads (seeded / simulated) use made-up addresses: never hand them to a real
  // provider, even when Resend is configured. They always go to the console outbox.
  const i =
    isDemoLead(input.lead) && input.adapter.name !== "console"
      ? { ...input, adapter: consoleAdapter }
      : input;
  if (!i.lead.email) throw new Error("Lead has no email address");
  const key = emailIdempotencyKey(i.lead.id, i.subject, i.body);
  const domain = env().INBOUND_EMAIL_DOMAIN ?? "leadpilot.local";
  const messageId = `<${newId("em")}@${domain}>`;

  // Thread onto the latest inbound email we know about.
  const [lastInbound] = await i.db
    .select({ mid: messages.messageIdHeader })
    .from(messages)
    .where(and(eq(messages.leadId, i.lead.id), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const [reserved] = await i.db
    .insert(emails)
    .values({
      workspaceId: i.workspace.id,
      leadId: i.lead.id,
      to: i.lead.email,
      from: senderAddress(i.workspace),
      replyTo: replyToAddress(i.lead),
      subject: i.subject,
      bodyText: i.body,
      kind: i.kind,
      provider: i.adapter.name,
      messageIdHeader: messageId,
      inReplyTo: lastInbound?.mid ?? null,
      status: "queued",
      idempotencyKey: key,
    })
    .onConflictDoNothing({ target: emails.idempotencyKey })
    .returning({ id: emails.id });

  if (!reserved) {
    const [existing] = await i.db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.idempotencyKey, key));
    return { status: "duplicate", emailId: existing!.id };
  }

  try {
    const res = await i.adapter.send({
      from: senderAddress(i.workspace),
      to: i.lead.email,
      replyTo: replyToAddress(i.lead),
      subject: i.subject,
      text: i.body,
      messageId,
      inReplyTo: lastInbound?.mid ?? null,
      idempotencyKey: key,
    });
    const now = new Date();
    await i.db
      .update(emails)
      .set({ status: "sent", providerMessageId: res.providerMessageId })
      .where(eq(emails.id, reserved.id));
    await i.db.insert(messages).values({
      leadId: i.lead.id,
      direction: "outbound",
      channel: "email",
      subject: i.subject,
      body: i.body,
      messageIdHeader: messageId,
      inReplyTo: lastInbound?.mid ?? null,
      createdAt: now,
    });
    // "Time to first response" metric.
    await i.db
      .update(leads)
      .set({ firstResponseAt: now })
      .where(and(eq(leads.id, i.lead.id), isNull(leads.firstResponseAt)));
    return { status: "sent", emailId: reserved.id, messageId, provider: i.adapter.name };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Release the idempotency key so a later retry can actually send.
    await i.db
      .update(emails)
      .set({ status: "failed", error, idempotencyKey: `${key}:failed:${reserved.id}` })
      .where(eq(emails.id, reserved.id));
    return { status: "failed", emailId: reserved.id, error, cause: err };
  }
}
