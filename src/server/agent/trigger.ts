import "server-only";
import { after } from "next/server";
import type { RunTrigger } from "../db/schema";
import { getLlm } from "../llm/anthropic";
import { LlmNotConfiguredError } from "../llm/types";
import { AgentBusyError, runAgent } from "./loop";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fire-and-forget for inbound channels (webhook, email, form): the HTTP response goes out
 * first (202), the run happens in `after()`. If the lead is already being processed
 * (e.g. a reply lands mid-run), retry briefly instead of dropping the new message.
 */
export function runAgentInBackground(leadId: string, trigger: RunTrigger): void {
  after(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await runAgent({ leadId, trigger });
        return;
      } catch (err) {
        if (err instanceof AgentBusyError && attempt < 3) {
          await sleep(5_000 * attempt);
          continue;
        }
        if (err instanceof LlmNotConfiguredError) {
          console.warn(`[agent] lead ${leadId} stored but not processed: ${err.message}`);
        } else {
          console.error(`[agent] background run failed for lead ${leadId}`, err);
        }
        return;
      }
    }
  });
}
