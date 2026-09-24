import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  passwordMatches,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/session";
import { jsonError } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { clientIp, rateLimit } from "@/server/security/rate-limit";

const body = z.object({ password: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  const limited = await rateLimit(getDb(), `login:${clientIp(req.headers)}`, 5, 300);
  if (!limited.ok) return jsonError(429, "Too many attempts. Try again in a few minutes.");

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !(await passwordMatches(parsed.data.password))) {
    return jsonError(401, "Wrong password.");
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
