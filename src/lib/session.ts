import { jwtVerify, SignJWT } from "jose";

/**
 * Stateless admin session: an HS256 JWT in an httpOnly cookie. No `server-only` import
 * because proxy.ts (request interception) also verifies it. Reads process.env directly.
 */

export const SESSION_COOKIE = "lp_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/** SESSION_SECRET, or a key derived from ADMIN_PASSWORD. Null when auth is not configured. */
export async function sessionKey(): Promise<Uint8Array | null> {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return new TextEncoder().encode(secret);
  const password = process.env.ADMIN_PASSWORD?.trim();
  // Changing the password therefore also invalidates every existing session.
  return password ? sha256(`leadpilot-session:${password}`) : null;
}

export async function createSessionToken(): Promise<string> {
  const key = await sessionKey();
  if (!key) throw new Error("ADMIN_PASSWORD is not configured");
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const key = await sessionKey();
  if (!key) return false;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload.role === "admin";
  } catch {
    return false;
  }
}

/** Constant-time password check (hash both sides so lengths always match). */
export async function passwordMatches(candidate: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD?.trim();
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
