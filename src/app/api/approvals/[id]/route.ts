import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdapters } from "@/server/adapters";
import { jsonError, requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { ApprovalError, decideApproval } from "@/server/services/approvals";

const body = z.object({
  decision: z.enum(["approve", "reject"]),
  payload: z.record(z.string(), z.unknown()).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Approve (optionally with an edited payload) or reject a held action. Admin only. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/approvals/[id]">) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Invalid request body.");
  const { id } = await ctx.params;
  try {
    const outcome = await decideApproval(getDb(), getAdapters(), {
      approvalId: id,
      ...parsed.data,
    });
    return NextResponse.json(outcome);
  } catch (err) {
    if (err instanceof ApprovalError) return jsonError(err.status, err.message, err.details);
    throw err;
  }
}
