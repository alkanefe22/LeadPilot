import type { z } from "zod";
import type { Adapters } from "../adapters";
import type { Database } from "../db/client";
import type { Lead, Qualification, RunTrigger, Workspace } from "../db/schema";

/** Mutable per-run facts that policies depend on (not trusted from the model). */
export type RunState = {
  qualification: Qualification | null;
  approvalsQueued: number;
  outwardActions: string[];
};

export type ToolContext = {
  db: Database;
  adapters: Adapters;
  workspace: Workspace;
  /** Fresh copy; tools that mutate the lead must reload or update it. */
  lead: Lead;
  runId: string;
  trigger: RunTrigger;
  now: () => Date;
  state: RunState;
  /** True when a human approved this exact action — policy prechecks are skipped. */
  approved: boolean;
};

export type ToolResult = Record<string, unknown>;

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Outward-facing actions that the "require approval" setting holds for a human. */
  approvable?: boolean;
  /** Policy checks that must pass before the action is executed *or* queued for approval. */
  precheck?(input: z.infer<S>, ctx: ToolContext): Promise<void>;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** Thrown by tools for expected, model-recoverable failures (returned as is_error). */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}
