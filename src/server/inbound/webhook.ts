import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { leads, type Lead, type Workspace } from "../db/schema";
import { createInboundLead } from "../services/intake";

export const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * Documented payload for POST /api/inbound/webhook (n8n, Zapier, Make, custom code).
 * Unknown fields are kept in raw_payload but otherwise ignored.
 */
export const webhookPayloadSchema = z
  .object({
    external_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Your system's id for this lead. Retries with the same id are deduplicated."),
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    company: z.string().max(200).optional(),
    phone: z.string().max(60).optional(),
    website: z.string().max(500).optional(),
    message: z.string().max(10_000).optional(),
    // Common aliases used by form tools.
    notes: z.string().max(10_000).optional(),
    body: z.string().max(10_000).optional(),
    source: z
      .string()
      .max(60)
      .optional()
      .describe("Free-form origin label, e.g. typeform, hubspot-form."),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .refine((p) => Boolean((p.message ?? p.notes ?? p.body)?.trim()), {
    message: "message is required",
    path: ["message"],
  });

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export type IngestResult =
  { status: "created"; lead: Lead } | { status: "duplicate"; lead: Pick<Lead, "id"> };

/**
 * Idempotency key: the caller's external_id, or a hash of the exact raw body. Automation
 * tools retry by resending the same request, so identical retries map to the same lead.
 */
export function webhookExternalId(payload: WebhookPayload, rawBody: string): string {
  if (payload.external_id) return `ext:${payload.external_id}`;
  return `sha256:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
}

export async function ingestWebhook(
  db: Database,
  workspace: Pick<Workspace, "id">,
  payload: WebhookPayload,
  rawBody: string,
): Promise<IngestResult> {
  const externalId = webhookExternalId(payload, rawBody);
  const lead = await createInboundLead(db, {
    workspaceId: workspace.id,
    source: "webhook",
    externalId,
    name: payload.name,
    email: payload.email,
    company: payload.company,
    phone: payload.phone,
    website: payload.website,
    message: payload.message ?? payload.notes ?? payload.body,
    rawPayload: payload as Record<string, unknown>,
  });
  if (lead) return { status: "created", lead };
  const [existing] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspace.id),
        eq(leads.source, "webhook"),
        eq(leads.externalId, externalId),
      ),
    );
  return { status: "duplicate", lead: existing! };
}
