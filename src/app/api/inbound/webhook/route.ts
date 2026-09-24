import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { isLlmConfigured } from "@/lib/env";
import { runAgentInBackground } from "@/server/agent/trigger";
import { jsonError } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "@/server/inbound/hmac";
import { ingestWebhook, MAX_WEBHOOK_BYTES, webhookPayloadSchema } from "@/server/inbound/webhook";
import { clientIp } from "@/server/security/client-ip";
import { rateLimit } from "@/server/security/rate-limit";
import { currentWorkspaceId } from "@/server/workspace";

// Triggers an agent run (in after()): give the background work the full function budget.
export const maxDuration = 60;

/**
 * Generic inbound webhook for n8n / Zapier / Make / custom code.
 * Auth: HMAC-SHA256 over `${timestamp}.${rawBody}` with the workspace webhook secret.
 * Responds 202 immediately; the agent runs after the response. Retries are idempotent.
 */
export async function POST(req: NextRequest) {
  const db = getDb();
  const limited = await rateLimit(db, `webhook:ip:${clientIp(req.headers)}`, 120, 60);
  if (!limited.ok) return jsonError(429, "Rate limit exceeded.");

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BYTES)
    return jsonError(413, "Payload too large (max 64 KB).");

  const workspaceId = req.nextUrl.searchParams.get("workspace") ?? currentWorkspaceId();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  // Same response for unknown workspace and bad signature: nothing to probe.
  const verified = workspace
    ? verifySignature({
        secret: workspace.webhookSecret,
        rawBody,
        signature: req.headers.get(SIGNATURE_HEADER),
        timestamp: req.headers.get(TIMESTAMP_HEADER),
      })
    : ({ ok: false, reason: "unknown workspace" } as const);
  if (!workspace || !verified.ok) {
    return jsonError(401, "Invalid signature.", {
      detail: verified.ok ? undefined : verified.reason,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "Body must be JSON.");
  }
  const parsed = webhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return jsonError(422, "Invalid payload.", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`),
    });
  }

  const result = await ingestWebhook(db, workspace, parsed.data, rawBody);
  if (result.status === "duplicate") {
    // A retry of something we already accepted: no new lead, no new run.
    return NextResponse.json({ status: "duplicate", lead_id: result.lead.id }, { status: 200 });
  }

  const agent = isLlmConfigured() ? "queued" : "not_configured";
  if (agent === "queued") runAgentInBackground(result.lead.id, "inbound");
  return NextResponse.json(
    {
      status: "accepted",
      lead_id: result.lead.id,
      agent,
      flagged: result.lead.riskFlags.length > 0,
      trace_url: `${req.nextUrl.origin}/leads/${result.lead.id}`,
    },
    { status: 202 },
  );
}
