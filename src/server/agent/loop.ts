import type Anthropic from "@anthropic-ai/sdk";
import { asc, count, eq } from "drizzle-orm";
import { env } from "@/lib/env";
import { getAdapters, type Adapters } from "../adapters";
import { getDb, type Database } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import {
  agentRuns,
  agentSteps,
  emails,
  leads,
  messages,
  workspaces,
  type AgentStep,
  type RunTrigger,
} from "../db/schema";
import { getLlm } from "../llm/anthropic";
import { costOf, priceFor, totalInputTokens } from "../llm/pricing";
import type { LlmClient } from "../llm/types";
import { executeToolCall } from "./executor";
import { detectPromptInjection, RISK_PROMPT_INJECTION } from "./guards";
import { buildLeadBrief, buildSystemPrompt } from "./prompt";
import { sweepStaleRuns } from "./runs";
import { anthropicTools } from "./tools";
import { confirmedBooking } from "./tools/helpers";
import type { RunState, ToolContext } from "./types";

export type RunLimits = {
  maxSteps: number;
  maxCostUsd: number;
  maxTokens: number;
  timeBudgetMs: number;
};

export type RunAgentOptions = {
  leadId: string;
  trigger: RunTrigger;
  llm?: LlmClient;
  adapters?: Adapters;
  db?: Database;
  limits?: Partial<RunLimits>;
  now?: () => Date;
  /** Called after each persisted step — used by the CLI to print a live trace. */
  onStep?: (step: AgentStep) => void;
  /** Called once the run row exists (the API returns this id immediately). */
  onRunCreated?: (runId: string) => void;
};

export type RunOutcome = {
  runId: string;
  status: "completed" | "failed" | "max_steps" | "awaiting_approval";
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  summary: string | null;
  error: string | null;
};

export class AgentBusyError extends Error {
  constructor(leadId: string) {
    super(`An agent run is already in progress for lead ${leadId}`);
    this.name = "AgentBusyError";
  }
}

export class LeadNotFoundError extends Error {
  constructor(leadId: string) {
    super(`Lead ${leadId} not found`);
    this.name = "LeadNotFoundError";
  }
}

export function defaultLimits(): RunLimits {
  const e = env();
  return {
    maxSteps: e.MAX_AGENT_STEPS,
    maxCostUsd: e.MAX_COST_PER_RUN_USD,
    maxTokens: e.LLM_MAX_TOKENS,
    timeBudgetMs: e.RUN_TIME_BUDGET_MS,
  };
}

const textOf = (content: Anthropic.ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

/**
 * The agent loop. A manual tool-use loop (rather than the SDK tool runner) because
 * every model call and every tool call is persisted as a trace step with tokens,
 * latency and cost — and guardrails (step cap, cost cap, time budget) run between them.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunOutcome> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? (() => new Date());
  const limits = { ...defaultLimits(), ...opts.limits };
  const llm = opts.llm ?? getLlm();
  const adapters = opts.adapters ?? getAdapters();
  const price = priceFor(llm.model, llm.priceOverride);

  await sweepStaleRuns(db);

  let [lead] = await db.select().from(leads).where(eq(leads.id, opts.leadId)).limit(1);
  if (!lead) throw new LeadNotFoundError(opts.leadId);
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, lead.workspaceId))
    .limit(1);
  if (!workspace) throw new Error(`Workspace ${lead.workspaceId} not found`);

  const [thread, [sent], booking] = await Promise.all([
    db.select().from(messages).where(eq(messages.leadId, lead.id)).orderBy(asc(messages.createdAt)),
    db.select({ n: count() }).from(emails).where(eq(emails.leadId, lead.id)),
    confirmedBooking(db, lead.id),
  ]);

  // Inbound scan: flag leads whose text addresses the agent. Sticky once set; after an
  // admin clears a flag, only content that arrived later is scanned again.
  const reviewedAt = lead.riskReviewedAt;
  const scan = detectPromptInjection(
    ...(reviewedAt ? [] : [lead.message]),
    ...thread
      .filter((m) => m.direction === "inbound" && (!reviewedAt || m.createdAt > reviewedAt))
      .map((m) => m.body),
  );
  if (scan.suspicious && !lead.riskFlags.includes(RISK_PROMPT_INJECTION)) {
    [lead] = await db
      .update(leads)
      .set({
        riskFlags: [...lead.riskFlags, RISK_PROMPT_INJECTION],
        riskMatches: scan.matches,
      })
      .where(eq(leads.id, lead.id))
      .returning();
  }

  let runId: string;
  try {
    const [run] = await db
      .insert(agentRuns)
      .values({
        leadId: lead!.id,
        trigger: opts.trigger,
        model: llm.model,
        billingTier: llm.billingTier ?? null,
        startedAt: now(),
      })
      .returning({ id: agentRuns.id });
    runId = run!.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AgentBusyError(lead!.id);
    throw err;
  }
  opts.onRunCreated?.(runId);

  const startedAt = Date.now();
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let stepIdx = 0;
  let summary: string | null = null;

  const state: RunState = { qualification: null, approvalsQueued: 0, outwardActions: [] };
  const ctx: ToolContext = {
    db,
    adapters,
    workspace,
    lead: lead!,
    runId,
    trigger: opts.trigger,
    now,
    state,
    approved: false,
  };

  const recordStep = async (step: Omit<typeof agentSteps.$inferInsert, "runId" | "idx">) => {
    const [row] = await db
      .insert(agentSteps)
      .values({ ...step, runId, idx: stepIdx++ })
      .returning();
    await db
      .update(agentRuns)
      .set({
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
        latencyMs: Date.now() - startedAt,
      })
      .where(eq(agentRuns.id, runId));
    // Postgres jsonb reorders keys; hand listeners the original objects for readability.
    opts.onStep?.({ ...row!, input: step.input ?? null, output: step.output ?? null });
  };

  const finish = async (status: RunOutcome["status"], error: string | null = null) => {
    const latencyMs = Date.now() - startedAt;
    await db
      .update(agentRuns)
      .set({ status, error, summary, finishedAt: now(), latencyMs, ...totals })
      .where(eq(agentRuns.id, runId));
    return {
      runId,
      status,
      steps: stepIdx,
      ...totals,
      latencyMs,
      summary,
      error,
    } satisfies RunOutcome;
  };

  const system = buildSystemPrompt(workspace);
  const brief = buildLeadBrief({
    lead: lead!,
    workspace,
    thread,
    booking,
    emailsSent: sent?.n ?? 0,
    trigger: opts.trigger,
    now: now(),
  });
  const history: Anthropic.MessageParam[] = [{ role: "user", content: brief }];
  const tools = anthropicTools();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limits.timeBudgetMs);

  try {
    for (let turn = 0; turn < limits.maxSteps; turn++) {
      if (deadline.signal.aborted) throw new Error("time budget exhausted");
      const t0 = Date.now();
      const res = await llm.create({
        system,
        messages: history,
        tools,
        maxTokens: limits.maxTokens,
        signal: deadline.signal,
      });
      const stepCost = costOf(res.usage, price);
      totals.inputTokens += totalInputTokens(res.usage);
      totals.outputTokens += res.usage.output_tokens;
      totals.costUsd = Math.round((totals.costUsd + stepCost) * 1e6) / 1e6;

      const toolUses = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const text = textOf(res.content);
      if (text) summary = text;

      await recordStep({
        type: "llm",
        text: text || null,
        // The first step stores the exact prompt so the trace shows what the model saw.
        input: turn === 0 ? { system, user: brief } : { messages: history.length },
        output: {
          stop_reason: res.stop_reason,
          tool_calls: toolUses.map((t) => t.name),
          cache_read_tokens: res.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: res.usage.cache_creation_input_tokens ?? 0,
        },
        inputTokens: totalInputTokens(res.usage),
        outputTokens: res.usage.output_tokens,
        costUsd: stepCost,
        latencyMs: Date.now() - t0,
      });

      if (totals.costUsd > limits.maxCostUsd) {
        return await finish(
          "failed",
          `Cost limit exceeded: $${totals.costUsd.toFixed(4)} > MAX_COST_PER_RUN_USD $${limits.maxCostUsd.toFixed(2)}. Stopped before running further tools.`,
        );
      }

      switch (res.stop_reason) {
        case "end_turn":
        case "stop_sequence":
          return await finish(state.approvalsQueued > 0 ? "awaiting_approval" : "completed");
        case "refusal":
          return await finish("failed", "The model declined to process this lead (refusal).");
        case "max_tokens":
          return await finish(
            "failed",
            `Model output hit LLM_MAX_TOKENS (${limits.maxTokens}) before finishing its turn.`,
          );
        case "pause_turn":
          history.push({ role: "assistant", content: res.content });
          continue;
        case "tool_use":
          break;
        default:
          return await finish("failed", `Unexpected stop reason: ${String(res.stop_reason)}`);
      }

      history.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      // Sequential on purpose: order matters (score → availability → book → confirm).
      for (const call of toolUses) {
        const t1 = Date.now();
        const exec = await executeToolCall(call.name, call.input, ctx);
        await recordStep({
          type: "tool",
          toolName: call.name,
          toolUseId: call.id,
          input: (exec.input ?? call.input) as object,
          output: exec.output,
          status: exec.status,
          latencyMs: Date.now() - t1,
        });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(exec.output),
          ...(exec.status === "error" ? { is_error: true } : {}),
        });
      }
      // All results for one assistant turn go back in a single user message.
      history.push({ role: "user", content: results });
    }
    return await finish(
      "max_steps",
      `Reached MAX_AGENT_STEPS (${limits.maxSteps}) without finishing.`,
    );
  } catch (err) {
    const message = deadline.signal.aborted
      ? `Run exceeded its time budget of ${Math.round(limits.timeBudgetMs / 1000)}s.`
      : err instanceof Error
        ? err.message
        : String(err);
    return await finish("failed", message);
  } finally {
    clearTimeout(timer);
  }
}
