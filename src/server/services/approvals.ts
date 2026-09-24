import { and, count, eq } from "drizzle-orm";
import { executeToolCall } from "../agent/executor";
import { findTool, TOOL_NAMES } from "../agent/tools";
import type { ToolContext } from "../agent/types";
import type { Adapters } from "../adapters";
import type { Database } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { agentRuns, agentSteps, approvals, leads, workspaces } from "../db/schema";

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type ApprovalDecision = {
  approvalId: string;
  decision: "approve" | "reject";
  /** Admin-edited payload; validated against the tool's Zod schema. */
  payload?: unknown;
  note?: string;
};

export type DecisionOutcome = {
  runId: string;
  status: "executed" | "failed" | "rejected";
  result: Record<string, unknown> | null;
};

/**
 * Human-in-the-loop decision. Every decision becomes its own run (trigger "approval",
 * model "human") in the lead's trace: a "human" step recording who decided what (and any
 * edits), followed — on approval — by the real tool step executed with `approved: true`.
 */
export async function decideApproval(
  db: Database,
  adapters: Adapters,
  d: ApprovalDecision,
): Promise<DecisionOutcome> {
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, d.approvalId));
  if (!approval) throw new ApprovalError("Approval not found.", 404);
  if (approval.status !== "pending") throw new ApprovalError(`Already ${approval.status}.`, 409);

  const tool = findTool(approval.action);
  if (!tool || !TOOL_NAMES.includes(approval.action))
    throw new ApprovalError("Unknown action.", 422);
  const edited = d.decision === "approve" && d.payload !== undefined;
  let payload: unknown = approval.payload;
  if (d.decision === "approve") {
    const parsed = tool.input.safeParse(edited ? d.payload : approval.payload);
    if (!parsed.success) {
      throw new ApprovalError("Edited payload is invalid.", 422, {
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(payload)"}: ${i.message}`),
      });
    }
    payload = parsed.data;
  }

  // Claim atomically: two admins (or a double click) can't both decide.
  const [claimed] = await db
    .update(approvals)
    .set({ status: d.decision === "approve" ? "approved" : "rejected", decidedAt: new Date() })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (!claimed) throw new ApprovalError("Already decided.", 409);

  let runId: string;
  try {
    const [run] = await db
      .insert(agentRuns)
      .values({ leadId: approval.leadId, trigger: "approval", model: "human" })
      .returning({ id: agentRuns.id });
    runId = run!.id;
  } catch (err) {
    await db
      .update(approvals)
      .set({ status: "pending", decidedAt: null })
      .where(eq(approvals.id, approval.id));
    if (isUniqueViolation(err)) {
      throw new ApprovalError(
        "The agent is currently working on this lead — try again in a moment.",
        409,
      );
    }
    throw err;
  }

  const started = Date.now();
  const verb = d.decision === "approve" ? "approved" : "rejected";
  const summary = `Admin ${verb} ${approval.action}${edited ? " (payload edited)" : ""}${d.note ? `: ${d.note}` : ""}`;
  await db.insert(agentSteps).values({
    runId,
    idx: 0,
    type: "human",
    toolName: approval.action,
    text: summary,
    input: {
      approval_id: approval.id,
      decision: d.decision,
      edited,
      proposed_payload: approval.payload,
      ...(edited ? { approved_payload: payload } : {}),
      ...(d.note ? { note: d.note } : {}),
    },
    output: { decision: d.decision, decided_by: "admin" },
  });

  let status: DecisionOutcome["status"] = "rejected";
  let result: Record<string, unknown> | null = null;
  if (d.decision === "approve") {
    const [lead] = await db.select().from(leads).where(eq(leads.id, approval.leadId));
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, approval.workspaceId));
    const ctx: ToolContext = {
      db,
      adapters,
      workspace: workspace!,
      lead: lead!,
      runId,
      trigger: "approval",
      now: () => new Date(),
      state: { qualification: lead!.qualification ?? null, approvalsQueued: 0, outwardActions: [] },
      approved: true,
    };
    const t0 = Date.now();
    const exec = await executeToolCall(approval.action, payload, ctx);
    await db.insert(agentSteps).values({
      runId,
      idx: 1,
      type: "tool",
      toolName: approval.action,
      input: (exec.input ?? payload) as object,
      output: exec.output,
      status: exec.status === "error" ? "error" : "ok",
      latencyMs: Date.now() - t0,
    });
    status = exec.status === "error" ? "failed" : "executed";
    result = exec.output;
  }

  await db
    .update(approvals)
    .set({ status: status === "rejected" ? "rejected" : status, result })
    .where(eq(approvals.id, approval.id));
  await db
    .update(agentRuns)
    .set({
      status: status === "failed" ? "failed" : "completed",
      error: status === "failed" ? String(result?.error ?? "Action failed") : null,
      summary,
      finishedAt: new Date(),
      latencyMs: Date.now() - started,
    })
    .where(eq(agentRuns.id, runId));

  // Once every held action of the original run is decided, that run is no longer "awaiting".
  if (approval.runId) {
    const [left] = await db
      .select({ n: count() })
      .from(approvals)
      .where(and(eq(approvals.runId, approval.runId), eq(approvals.status, "pending")));
    if ((left?.n ?? 0) === 0) {
      await db
        .update(agentRuns)
        .set({ status: "completed" })
        .where(and(eq(agentRuns.id, approval.runId), eq(agentRuns.status, "awaiting_approval")));
    }
  }

  return { runId, status, result };
}
