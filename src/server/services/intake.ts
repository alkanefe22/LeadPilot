import type { Database } from "../db/client";
import { leads, messages, type Lead, type LeadSource } from "../db/schema";
import { detectPromptInjection, RISK_PROMPT_INJECTION } from "../agent/guards";
import { sanitizeEmail, sanitizeLine, sanitizeText, sanitizeUrl } from "../security/sanitize";

export type InboundLeadInput = {
  workspaceId: string;
  source: LeadSource;
  externalId?: string | null;
  name?: unknown;
  email?: unknown;
  company?: unknown;
  phone?: unknown;
  website?: unknown;
  message: unknown;
  subject?: unknown;
  messageIdHeader?: string | null;
  rawPayload?: Record<string, unknown> | null;
  createdAt?: Date;
};

/**
 * Single entry point for new leads (form, webhook, email, simulator, seed):
 * sanitizes every field, runs the prompt-injection scanner so a flag is visible
 * in the dashboard immediately, and stores the first inbound thread message.
 * Returns null when the same (source, externalId) was already received (dedupe).
 */
export async function createInboundLead(db: Database, i: InboundLeadInput): Promise<Lead | null> {
  const message = sanitizeText(i.message, 10_000);
  const name = sanitizeLine(i.name);
  const company = sanitizeLine(i.company);
  const subject = sanitizeLine(i.subject, 300);
  const scan = detectPromptInjection(name, company, subject, message);
  const createdAt = i.createdAt ?? new Date();

  const [lead] = await db
    .insert(leads)
    .values({
      workspaceId: i.workspaceId,
      source: i.source,
      externalId: i.externalId ?? null,
      name,
      email: sanitizeEmail(i.email),
      company,
      phone: sanitizeLine(i.phone, 40),
      website: sanitizeUrl(i.website),
      message,
      rawPayload: i.rawPayload ?? null,
      riskFlags: scan.suspicious ? [RISK_PROMPT_INJECTION] : [],
      riskMatches: scan.matches,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!lead) return null;

  await db.insert(messages).values({
    leadId: lead.id,
    direction: "inbound",
    channel: i.source,
    subject,
    body: message,
    messageIdHeader: i.messageIdHeader ?? null,
    createdAt,
  });
  return lead;
}

/** Seeded and simulated leads carry made-up contact details and must never reach real providers. */
export function isDemoLead(lead: Pick<Lead, "source" | "externalId" | "rawPayload">): boolean {
  return (
    lead.source === "simulated" ||
    lead.source === "seed" ||
    lead.externalId?.startsWith("seed-") === true ||
    lead.rawPayload?.seed === true
  );
}
