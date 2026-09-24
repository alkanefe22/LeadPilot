import { NextResponse, type NextRequest } from "next/server";
import { getViewer, jsonError } from "@/server/auth";
import { getLeadTrace } from "@/server/services/trace";

export const dynamic = "force-dynamic";

/** Poll target for the live trace timeline. Public viewers get PII-masked data. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/leads/[id]/trace">) {
  const viewer = await getViewer();
  if (!viewer.isAdmin && !viewer.publicDemo) return jsonError(401, "Login required.");
  const { id } = await ctx.params;
  const trace = await getLeadTrace(id, {
    runId: req.nextUrl.searchParams.get("run"),
    redact: !viewer.isAdmin,
  });
  if (!trace) return jsonError(404, "Lead not found.");
  return NextResponse.json(trace, { headers: { "Cache-Control": "no-store" } });
}
