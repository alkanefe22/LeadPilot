import "server-only";
import { jsonError } from "../auth";
import { LlmNotConfiguredError } from "../llm/types";
import { AgentBusyError, LeadNotFoundError } from "./loop";

/** Maps "couldn't start a run" errors to HTTP responses for the route handlers. */
export function runStartErrorResponse(err: unknown) {
  if (err instanceof LlmNotConfiguredError)
    return jsonError(503, err.message, { code: "llm_not_configured" });
  if (err instanceof AgentBusyError)
    return jsonError(409, "The agent is already working on this lead.", { code: "busy" });
  if (err instanceof LeadNotFoundError) return jsonError(404, "Lead not found.");
  console.error("[agent] failed to start run", err);
  return jsonError(500, "Could not start the agent run.");
}
