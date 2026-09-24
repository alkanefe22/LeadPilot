import type { z } from "zod";
import { ProviderError } from "../adapters/http";
import { approvals } from "../db/schema";
import { isFlagged } from "./tools/helpers";
import { findTool } from "./tools";
import { ToolError, type ToolContext, type ToolResult } from "./types";
import { INVALID_TOOL_ARGS } from "../llm/types";

export type ToolExecution = {
  status: "ok" | "error" | "pending_approval";
  output: ToolResult;
  /** Parsed input when validation succeeded (what actually ran / was queued). */
  input: unknown;
};

function formatZodError(err: z.ZodError) {
  return err.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
}

/**
 * Runs one tool call with the full guardrail chain:
 *   unknown tool → Zod validation → policy precheck → approval gate → execution.
 * Every failure becomes a structured error result the model can recover from; nothing throws.
 */
export async function executeToolCall(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const tool = findTool(name);
  if (!tool) {
    return { status: "error", input: rawInput, output: { error: `Unknown tool "${name}"` } };
  }

  const rawArgs = (rawInput as Record<string, unknown> | null)?.[INVALID_TOOL_ARGS];
  if (typeof rawArgs === "string") {
    return {
      status: "error",
      input: rawInput,
      output: {
        error: "Invalid input: the arguments are not a valid JSON object.",
        received: rawArgs.slice(0, 500),
        hint: `Call ${name} again with a JSON object that matches its schema.`,
      },
    };
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      status: "error",
      input: rawInput,
      output: { error: "Invalid input", issues: formatZodError(parsed.error) },
    };
  }
  const input = parsed.data;

  try {
    if (tool.precheck) await tool.precheck(input, ctx);

    // Human-in-the-loop: hold outward actions when the workspace requires approval,
    // and always for leads flagged by the prompt-injection scanner.
    const flagged = isFlagged(ctx.lead);
    if (tool.approvable && !ctx.approved && (ctx.workspace.requireApproval || flagged)) {
      const [row] = await ctx.db
        .insert(approvals)
        .values({
          workspaceId: ctx.workspace.id,
          leadId: ctx.lead.id,
          runId: ctx.runId,
          action: tool.name as "book_meeting" | "send_email" | "ask_followup_question",
          payload: input as Record<string, unknown>,
        })
        .returning({ id: approvals.id });
      ctx.state.approvalsQueued++;
      return {
        status: "pending_approval",
        input,
        output: {
          status: "queued_for_approval",
          approval_id: row!.id,
          reason: flagged ? "lead flagged for manual review" : "workspace requires approval",
        },
      };
    }

    return { status: "ok", input, output: await tool.run(input, ctx) };
  } catch (err) {
    if (err instanceof ProviderError) {
      // A real integration failed: tell the model exactly what happened. No mock fallback.
      return { status: "error", input, output: err.toToolOutput() };
    }
    if (err instanceof ToolError) {
      return { status: "error", input, output: { error: err.message, ...err.details } };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", input, output: { error: `Tool failed: ${message}` } };
  }
}
