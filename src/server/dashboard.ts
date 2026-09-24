import "server-only";
import { demoMode, env, isLlmConfigured } from "@/lib/env";
import type { SimulateState } from "@/components/layout/simulate-button";
import type { Viewer } from "./auth";
import { getDb } from "./db/client";
import { loadRecordings } from "./demo/recordings";
import { getDemoBudget } from "./services/demo-budget";
import { currentWorkspaceId } from "./workspace";

/** Server-side state for the Simulate button (budget applies to public visitors only). */
export async function getSimulateState(viewer: Viewer): Promise<SimulateState> {
  const e = env();
  if (!viewer.isAdmin && viewer.publicDemo && demoMode(e) === "replay") {
    const available = loadRecordings().length > 0;
    return {
      enabled: available,
      limitReached: false,
      videoUrl: e.DEMO_VIDEO_URL ?? null,
      replay: true,
      reason: available ? null : "No recorded runs to replay yet (pnpm demo:record).",
    };
  }
  if (!isLlmConfigured(e)) {
    return {
      enabled: false,
      limitReached: false,
      videoUrl: null,
      reason: "Configure an LLM provider (see .env.example) to enable the agent.",
    };
  }
  if (!viewer.isAdmin && !viewer.publicDemo) {
    return { enabled: false, limitReached: false, videoUrl: null, reason: "Login required." };
  }
  if (viewer.isAdmin)
    return { enabled: true, limitReached: false, videoUrl: e.DEMO_VIDEO_URL ?? null };
  const budget = await getDemoBudget(getDb(), {
    workspaceId: currentWorkspaceId(),
    runLimit: e.DEMO_DAILY_RUN_LIMIT,
    costLimit: e.DEMO_DAILY_COST_LIMIT_USD,
    videoUrl: e.DEMO_VIDEO_URL,
  });
  return {
    enabled: !budget.limitReached,
    limitReached: budget.limitReached,
    videoUrl: budget.videoUrl,
  };
}
