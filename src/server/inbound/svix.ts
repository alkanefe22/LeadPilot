import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Svix webhook verification (used by Resend):
 *   headers: svix-id, svix-timestamp, svix-signature ("v1,<base64> v1,<base64>…")
 *   signed content: `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 keyed with the base64
 *   part of the `whsec_…` secret; timestamps older/newer than 5 minutes are rejected.
 */
export function verifySvix(opts: {
  secret: string;
  rawBody: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  const { id, timestamp, signature } = opts;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > (opts.toleranceSeconds ?? 300)) return false;

  const key = Buffer.from(opts.secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${opts.rawBody}`).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Test/helper: produce a valid svix-signature header value. */
export function signSvix(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
}
