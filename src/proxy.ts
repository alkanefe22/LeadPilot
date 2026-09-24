import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Dashboard gate. With PUBLIC_DEMO=true anyone can browse read-only (mutations are
 * checked again in every route handler / server action). With PUBLIC_DEMO=false,
 * dashboard pages require the admin session.
 */
export async function proxy(req: NextRequest) {
  const publicDemo = (process.env.PUBLIC_DEMO ?? "true").toLowerCase() !== "false";
  if (publicDemo) return NextResponse.next();
  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except APIs (they authorize themselves), the public form, login and static files.
  matcher: [
    "/((?!api|f/|login|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|ico|js)$).*)",
  ],
};
