import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export type Viewer = {
  role: "admin" | "public";
  isAdmin: boolean;
  /** False when ADMIN_PASSWORD is unset: nobody can log in, the app is read-only. */
  authConfigured: boolean;
  publicDemo: boolean;
};

export async function getViewer(): Promise<Viewer> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const isAdmin = await verifySessionToken(token);
  const e = env();
  return {
    role: isAdmin ? "admin" : "public",
    isAdmin,
    authConfigured: Boolean(e.ADMIN_PASSWORD),
    publicDemo: e.PUBLIC_DEMO,
  };
}

export function jsonError(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** For route handlers: returns an error response when the caller isn't the admin. */
export async function requireAdmin(): Promise<NextResponse | null> {
  const viewer = await getViewer();
  return viewer.isAdmin ? null : jsonError(401, "Admin login required for this action.");
}
