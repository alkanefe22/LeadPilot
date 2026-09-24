import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures (Stripe-style):
 *   X-LeadPilot-Timestamp: <unix seconds>
 *   X-LeadPilot-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 * Signing the timestamp together with the exact raw body prevents both tampering and
 * replaying an old request outside the tolerance window.
 */

export const SIGNATURE_HEADER = "x-leadpilot-signature";
export const TIMESTAMP_HEADER = "x-leadpilot-timestamp";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, timestamp: number | string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySignature(opts: {
  secret: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now?: Date;
  toleranceSeconds?: number;
}): VerifyResult {
  const { secret, rawBody, signature, timestamp } = opts;
  if (!signature || !timestamp)
    return { ok: false, reason: "missing signature or timestamp header" };
  if (!/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: "invalid timestamp" };
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "timestamp outside tolerance window (replay protection)" };
  }
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody));
  const given = Buffer.from(signature.trim());
  // timingSafeEqual needs equal lengths; the length check itself leaks nothing useful.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
