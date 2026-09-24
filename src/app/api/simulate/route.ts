import { NextResponse, type NextRequest } from "next/server";
import { env, isLlmConfigured } from "@/lib/env";
import { newId } from "@/lib/ids";
import { runStartErrorResponse } from "@/server/agent/errors";
import { startAgentRun } from "@/server/agent/trigger";
import { getViewer, jsonError } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { clientIp, rateLimit } from "@/server/security/rate-limit";
import { getDemoBudget } from "@/server/services/demo-budget";
import { createInboundLead } from "@/server/services/intake";
import { generateLead } from "@/server/services/simulator";
import { currentWorkspaceId } from "@/server/workspace";

// Triggers an agent run: give the background work the full function budget.
export const maxDuration = 60;

/**
 * "Simulate lead": creates a random realistic lead and starts the agent on it.
 * Public visitors are limited per IP and by a global daily run/cost budget.
 */
export async function POST(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer.isAdmin && !viewer.publicDemo) return jsonError(401, "Login required.");
  if (!isLlmConfigured()) {
    return jsonError(
      503,
      "The agent isn't configured on this deployment (missing Anthropic key).",
      {
        code: "llm_not_configured",
      },
    );
  }

  const db = getDb();
  const e = env();
  const workspaceId = currentWorkspaceId();

  if (!viewer.isAdmin) {
    const budget = await getDemoBudget(db, {
      workspaceId,
      runLimit: e.DEMO_DAILY_RUN_LIMIT,
      costLimit: e.DEMO_DAILY_COST_LIMIT_USD,
      videoUrl: e.DEMO_VIDEO_URL,
    });
    if (budget.limitReached) {
      return jsonError(429, "Demo limit reached today.", {
        code: "demo_limit",
        videoUrl: budget.videoUrl,
      });
    }
    const ip = clientIp(req.headers);
    const [burst, daily] = await Promise.all([
      rateLimit(db, `simulate:ip:${ip}:10m`, 3, 600),
      rateLimit(db, `simulate:ip:${ip}:1d`, 15, 86_400),
    ]);
    if (!burst.ok || !daily.ok) {
      return jsonError(429, "You're simulating leads quickly — please wait a few minutes.", {
        code: "rate_limited",
        resetAt: (!burst.ok ? burst.resetAt : daily.resetAt).toISOString(),
      });
    }
  }

  const sim = generateLead();
  const lead = await createInboundLead(db, {
    workspaceId,
    source: "simulated",
    externalId: newId("sim"),
    name: sim.name,
    email: sim.email,
    company: sim.company,
    website: sim.website,
    message: sim.message,
    rawPayload: { simulated: true, profile: sim.profile },
  });
  if (!lead) return jsonError(500, "Could not create the simulated lead.");

  try {
    const { runId } = await startAgentRun(lead.id, "simulate");
    return NextResponse.json({ leadId: lead.id, runId }, { status: 202 });
  } catch (err) {
    return runStartErrorResponse(err);
  }
}
