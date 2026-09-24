import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env, isLlmConfigured } from "@/lib/env";
import { ResendEmailAdapter } from "@/server/adapters/email/resend";
import { ProviderError } from "@/server/adapters/http";
import { runAgentInBackground } from "@/server/agent/trigger";
import { jsonError } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "@/server/inbound/hmac";
import { normalizeInboundEmail } from "@/server/inbound/email";
import { verifySvix } from "@/server/inbound/svix";
import { ingestInboundEmail } from "@/server/inbound/threading";
import { MAX_WEBHOOK_BYTES } from "@/server/inbound/webhook";
import { clientIp } from "@/server/security/client-ip";
import { rateLimit } from "@/server/security/rate-limit";
import { currentWorkspaceId } from "@/server/workspace";

// Triggers an agent run (in after()): give the background work the full function budget.
export const maxDuration = 60;

const MAX_EMAIL_BYTES = MAX_WEBHOOK_BYTES * 8; // inbound emails can carry HTML bodies

function tokenMatches(given: string | null, secret: string | undefined) {
  if (!given || !secret) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Inbound email webhook. Accepts:
 *  - Resend `email.received` (Svix-signed with RESEND_WEBHOOK_SECRET; the body is fetched
 *    from the Resend API because webhooks only carry metadata),
 *  - Postmark inbound JSON or a generic shape, authenticated with `?token=INBOUND_EMAIL_SECRET`
 *    or the LeadPilot HMAC headers signed with INBOUND_EMAIL_SECRET.
 * Replies continue the lead's thread and re-run the agent with trigger "reply".
 */
export async function POST(req: NextRequest) {
  const e = env();
  if (!e.INBOUND_EMAIL_SECRET && !e.RESEND_WEBHOOK_SECRET) {
    return jsonError(
      503,
      "Inbound email is not configured (set RESEND_WEBHOOK_SECRET or INBOUND_EMAIL_SECRET).",
    );
  }

  const db = getDb();
  const limited = await rateLimit(db, `email:ip:${clientIp(req.headers)}`, 120, 60);
  if (!limited.ok) return jsonError(429, "Rate limit exceeded.");

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody) > MAX_EMAIL_BYTES) return jsonError(413, "Payload too large.");

  const viaSvix =
    !!e.RESEND_WEBHOOK_SECRET &&
    verifySvix({
      secret: e.RESEND_WEBHOOK_SECRET,
      rawBody,
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    });
  const viaSecret =
    !!e.INBOUND_EMAIL_SECRET &&
    (verifySignature({
      secret: e.INBOUND_EMAIL_SECRET,
      rawBody,
      signature: req.headers.get(SIGNATURE_HEADER),
      timestamp: req.headers.get(TIMESTAMP_HEADER),
    }).ok ||
      tokenMatches(req.nextUrl.searchParams.get("token"), e.INBOUND_EMAIL_SECRET));
  if (!viaSvix && !viaSecret) return jsonError(401, "Unauthorized.");

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return jsonError(400, "Body must be JSON.");
  }

  // Resend webhooks carry metadata only: fetch the full message (text/html/headers).
  const event = json as { type?: string; data?: { email_id?: string } };
  if (event.type === "email.received" && event.data?.email_id) {
    if (!e.RESEND_API_KEY)
      return jsonError(503, "RESEND_API_KEY is required to read received emails.");
    try {
      const full = await new ResendEmailAdapter(e.RESEND_API_KEY).getReceivedEmail(
        event.data.email_id,
      );
      json = { type: "email.received", data: { ...event.data, ...full } };
    } catch (err) {
      const message =
        err instanceof ProviderError ? err.message : "Could not fetch the email from Resend.";
      // 502 → Resend retries the webhook later.
      return jsonError(502, message);
    }
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
