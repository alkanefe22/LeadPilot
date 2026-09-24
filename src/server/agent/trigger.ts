import "server-only";
import { after } from "next/server";
import type { RunTrigger } from "../db/schema";
import { getLlm } from "../llm/anthropic";
import { runAgent } from "./loop";

/**
 * Starts an agent run from a route handler and returns as soon as the run row exists,
 * so the UI can navigate to the trace and watch it fill in. The rest of the run keeps
 * going via `after()` (Vercel `waitUntil`) within the route's maxDuration; the stale-run
 * sweeper catches runs whose function was killed anyway.
 *
 * Throws (before any run exists) for LlmNotConfiguredError / AgentBusyError / LeadNotFoundError.
 */
export function startAgentRun(leadId: string, trigger: RunTrigger): Promise<{ runId: string }> {
  const llm = getLlm();
  return new Promise((resolve, reject) => {
    const run = runAgent({
      leadId,
      trigger,
      llm,
      onRunCreated: (runId) => resolve({ runId }),
    }).catch((err: unknown) => {
      // Errors after the run row exists are already persisted on the run by the loop.
      reject(err);
    });
    after(() => run);
  });
}
