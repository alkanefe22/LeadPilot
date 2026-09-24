import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env, isLlmConfigured } from "@/lib/env";
import { runAgentInBackground } from "@/server/agent/trigger";
import { jsonError } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "@/server/inbound/hmac";
import { normalizeInboundEmail } from "@/server/inbound/email";
import { ingestInboundEmail } from "@/server/inbound/threading";
import { MAX_WEBHOOK_BYTES } from "@/server/inbound/webhook";
import { clientIp } from "@/server/security/client-ip";
import { rateLimit } from "@/server/security/rate-limit";
import { currentWorkspaceId } from "@/server/workspace";

// Triggers an agent run (in after()): give the background work the full function budget.
export const maxDuration = 60;

const MAX_EMAIL_BYTES = MAX_WEBHOOK_BYTES * 8; // inbound emails can carry HTML bodies

function tokenMatches(given: string | null, secret: string) {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Inbound email webhook (Postmark inbound, Resend `email.received`, or generic JSON).
 * Auth: `?token=INBOUND_EMAIL_SECRET` (what Postmark/Resend URLs support) or the same
 * HMAC headers as /api/inbound/webhook signed with INBOUND_EMAIL_SECRET.
 * Replies continue the lead's thread and re-run the agent with trigger "reply".
 */
export async function POST(req: NextRequest) {
  const secret = env().INBOUND_EMAIL_SECRET;
  if (!secret) return jsonError(503, "Inbound email is not configured (set INBOUND_EMAIL_SECRET).");

  const db = getDb();
  const limited = await rateLimit(db, `email:ip:${clientIp(req.headers)}`, 120, 60);
  if (!limited.ok) return jsonError(429, "Rate limit exceeded.");

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody) > MAX_EMAIL_BYTES) return jsonError(413, "Payload too large.");

  const hmac = verifySignature({
    secret,
    rawBody,
    signature: req.headers.get(SIGNATURE_HEADER),
    timestamp: req.headers.get(TIMESTAMP_HEADER),
  });
  if (!hmac.ok && !tokenMatches(req.nextUrl.searchParams.get("token"), secret)) {
    return jsonError(401, "Unauthorized.");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "Body must be JSON.");
  }
  const email = normalizeInboundEmail(json);
  if (!email?.fromEmail || !email.text)
    return jsonError(422, "Unrecognized or empty email payload.");

  const result = await ingestInboundEmail(db, currentWorkspaceId(), email);
  if (result.status === "duplicate") {
    return NextResponse.json({ status: "duplicate", lead_id: result.leadId });
  }
  const agent = isLlmConfigured() ? "queued" : "not_configured";
  if (agent === "queued") {
    runAgentInBackground(result.lead.id, result.status === "reply" ? "reply" : "inbound");
  }
  return NextResponse.json(
    {
      status: result.status === "reply" ? "threaded" : "accepted",
      lead_id: result.lead.id,
      matched_via: result.status === "reply" ? result.via : null,
      agent,
    },
    { status: 202 },
  );
}
