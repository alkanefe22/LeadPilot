import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runStartErrorResponse } from "@/server/agent/errors";
import { RISK_PROMPT_INJECTION } from "@/server/agent/guards";
import { startAgentRun } from "@/server/agent/trigger";
import { jsonError, requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { leads } from "@/server/db/schema";

// Triggers an agent run: give the background work the full function budget.
export const maxDuration = 60;

const body = z.object({ clearFlag: z.boolean().optional() });

/** Re-run the agent on a lead (admin). `clearFlag` clears a prompt-injection flag first. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/leads/[id]/run">) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(400, "Invalid request body.");

  const db = getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) return jsonError(404, "Lead not found.");

  if (parsed.data.clearFlag) {
    // Admin reviewed the content: drop the flag and only re-scan content that arrives later.
    await db
      .update(leads)
      .set({
        riskFlags: lead.riskFlags.filter((f) => f !== RISK_PROMPT_INJECTION),
        riskMatches: [],
        riskReviewedAt: new Date(),
      })
      .where(eq(leads.id, id));
  }

  try {
    const { runId } = await startAgentRun(id, "rerun");
    return NextResponse.json({ runId }, { status: 202 });
  } catch (err) {
    return runStartErrorResponse(err);
  }
}
