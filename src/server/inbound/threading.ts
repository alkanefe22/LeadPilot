import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { emails, leads, messages, type Lead } from "../db/schema";
import { createInboundLead } from "../services/intake";
import { sanitizeLine, sanitizeText } from "../security/sanitize";
import type { InboundEmail } from "./email";
import { threadTokenFromAddresses } from "./email";

export type ThreadMatch = { lead: Lead; via: "reply_token" | "in_reply_to" | "sender" };

const SENDER_MATCH_WINDOW_MS = 30 * 86_400_000;

/**
 * Which lead does this email belong to? In order of confidence:
 *  1. the plus-address token in `reply+<token>@…` (we set it as Reply-To),
 *  2. In-Reply-To / References pointing at a Message-ID we sent or received,
 *  3. the same sender emailed by the agent in the last 30 days.
 */
export async function matchThread(
  db: Database,
  workspaceId: string,
  email: InboundEmail,
): Promise<ThreadMatch | null> {
  const token = threadTokenFromAddresses(email.to);
  if (token) {
    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), eq(leads.threadToken, token)));
    if (lead) return { lead, via: "reply_token" };
  }

  const ids = [email.inReplyTo, ...email.references].filter((x): x is string => !!x);
  if (ids.length) {
    const [viaOutbox] = await db
      .select({ leadId: emails.leadId })
      .from(emails)
      .where(and(eq(emails.workspaceId, workspaceId), inArray(emails.messageIdHeader, ids)))
      .limit(1);
    const [viaThread] = viaOutbox?.leadId
      ? [{ leadId: viaOutbox.leadId }]
      : await db
          .select({ leadId: messages.leadId })
          .from(messages)
          .innerJoin(leads, eq(leads.id, messages.leadId))
          .where(and(eq(leads.workspaceId, workspaceId), inArray(messages.messageIdHeader, ids)))
          .limit(1);
    if (viaThread?.leadId) {
      const [lead] = await db.select().from(leads).where(eq(leads.id, viaThread.leadId));
      if (lead) return { lead, via: "in_reply_to" };
    }
  }

  if (email.fromEmail) {
    const [recent] = await db
      .select({ leadId: emails.leadId })
      .from(emails)
      .where(
        and(
          eq(emails.workspaceId, workspaceId),
          eq(emails.to, email.fromEmail),
          gte(emails.createdAt, new Date(Date.now() - SENDER_MATCH_WINDOW_MS)),
        ),
      )
      .orderBy(desc(emails.createdAt))
      .limit(1);
    if (recent?.leadId) {
      const [lead] = await db.select().from(leads).where(eq(leads.id, recent.leadId));
      if (lead) return { lead, via: "sender" };
    }
  }
  return null;
}

export type EmailIngestResult =
  | { status: "reply"; lead: Lead; via: ThreadMatch["via"] }
  | { status: "new_lead"; lead: Lead }
  | { status: "duplicate"; leadId: string | null };

/**
 * Appends a reply to its lead's thread (the caller then runs the agent with trigger
 * "reply"), or creates a new lead. Provider retries are deduplicated by Message-ID.
 */
export async function ingestInboundEmail(
  db: Database,
  workspaceId: string,
  email: InboundEmail,
): Promise<EmailIngestResult> {
  if (email.messageId) {
    const [seen] = await db
      .select({ leadId: messages.leadId })
      .from(messages)
      .where(eq(messages.messageIdHeader, email.messageId));
    if (seen) return { status: "duplicate", leadId: seen.leadId };
  }

  const match = await matchThread(db, workspaceId, email);
  if (match) {
    try {
      await db.insert(messages).values({
        leadId: match.lead.id,
        direction: "inbound",
        channel: "email",
        subject: sanitizeLine(email.subject, 300),
        body: sanitizeText(email.text, 10_000),
        messageIdHeader: email.messageId,
        inReplyTo: email.inReplyTo,
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { status: "duplicate", leadId: match.lead.id };
      throw err;
    }
    return { status: "reply", lead: match.lead, via: match.via };
  }

  const lead = await createInboundLead(db, {
    workspaceId,
    source: "email",
    externalId: email.messageId,
    name: email.fromName,
    email: email.fromEmail,
    subject: email.subject,
    message: email.text,
    messageIdHeader: email.messageId,
    rawPayload: { provider: email.provider, subject: email.subject },
  });
  return lead ? { status: "new_lead", lead } : { status: "duplicate", leadId: null };
}
