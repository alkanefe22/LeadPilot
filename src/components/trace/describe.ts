import {
  BanIcon,
  BotIcon,
  CalendarCheckIcon,
  CalendarSearchIcon,
  ContactIcon,
  FileSearchIcon,
  GaugeIcon,
  MailIcon,
  MailQuestionIcon,
  UserCheckIcon,
  UserXIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { ApprovalState, TraceStep } from "@/server/services/trace";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);

export const TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  get_lead: { label: "Get lead", icon: FileSearchIcon },
  score_lead: { label: "Score lead", icon: GaugeIcon },
  ask_followup_question: { label: "Ask follow-up", icon: MailQuestionIcon },
  check_availability: { label: "Check availability", icon: CalendarSearchIcon },
  book_meeting: { label: "Book meeting", icon: CalendarCheckIcon },
  upsert_crm_contact: { label: "Update CRM", icon: ContactIcon },
  send_email: { label: "Send email", icon: MailIcon },
  mark_disqualified: { label: "Disqualify", icon: BanIcon },
};

const isRejected = (step: TraceStep) => obj(step.output).decision === "reject";

export function stepIcon(step: TraceStep): LucideIcon {
  if (step.type === "llm") return BotIcon;
  if (step.type === "human") return isRejected(step) ? UserXIcon : UserCheckIcon;
  return TOOL_META[step.toolName ?? ""]?.icon ?? WrenchIcon;
}

export function stepTitle(step: TraceStep, model: string): string {
  if (step.type === "llm") return model === "dev-fake-llm" ? "Agent (dev fake LLM)" : "Claude";
  if (step.type === "human") return isRejected(step) ? "Admin rejected" : "Admin approved";
  return TOOL_META[step.toolName ?? ""]?.label ?? step.toolName ?? "Tool";
}

/** One human sentence describing what a step did — the timeline's scannable layer. */
export function describeStep(
  step: TraceStep,
  approvals: Record<string, ApprovalState> = {},
): string {
  const input = obj(step.input);
  const out = obj(step.output);
  if (step.type === "human") {
    const action = TOOL_META[step.toolName ?? ""]?.label ?? step.toolName;
    const verb = isRejected(step) ? "Rejected" : "Approved";
    return `${verb} “${action}”${input.edited ? " with an edited payload" : " as proposed"}${input.note ? ` — ${str(input.note)}` : ""}`;
  }
  if (step.type === "llm") {
    const calls = (out.tool_calls as string[] | undefined) ?? [];
    if (calls.length) {
      const names = calls.map((c) => TOOL_META[c]?.label ?? c).join(", ");
      return `Decided to call ${names}`;
    }
    if (out.stop_reason === "end_turn") return "Finished the run";
    return `Stopped: ${str(out.stop_reason)}`;
  }
  if (step.status === "pending_approval") {
    const decision = approvals[str(out.approval_id)];
    if (decision?.status === "executed")
      return "Held for approval → approved by admin and executed";
    if (decision?.status === "failed") return "Held for approval → approved, but execution failed";
    if (decision?.status === "rejected") return "Held for approval → rejected by admin, never sent";
    return "Held for human approval — nothing was sent yet";
  }
  if (step.status === "error") return str(out.error) || "Tool error";

  switch (step.toolName) {
    case "score_lead": {
      const capped = out.policy_note ? " · capped (flagged lead)" : "";
      return `Score ${str(out.score)}/100 · ${str(input.category)} · ${out.qualifies ? "qualifies" : "does not qualify"} (threshold ${str(out.threshold)})${capped}`;
    }
    case "check_availability": {
      const slots = (out.slots as Obj[] | undefined) ?? [];
      return slots.length
        ? `${slots.length} open slots · first ${str(slots[0]?.local)}`
        : "No open slots found";
    }
    case "book_meeting":
      return out.status === "already_booked"
        ? `Already booked for ${str(out.start_local ?? out.start)} — no double booking`
        : `Booked ${str(out.start_local)} (${str(out.provider)})`;
    case "send_email":
    case "ask_followup_question": {
      const status = str(out.status);
      const what =
        step.toolName === "ask_followup_question" ? "Follow-up" : str(input.purpose) || "Email";
      return `${what[0]!.toUpperCase()}${what.slice(1)} “${str(input.subject)}” · ${status === "duplicate" ? "already sent (idempotent)" : status}`;
    }
    case "upsert_crm_contact":
      return `${out.created ? "Created" : "Updated"} contact in ${str(out.crm)} CRM · ${str(input.status)}`;
    case "mark_disqualified":
      return `Disqualified (${str(input.category)}): ${str(input.reason)}`;
    case "get_lead":
      return `Fetched lead state · ${((out.thread_untrusted as unknown[]) ?? []).length} messages`;
    default:
      return "Tool executed";
  }
}
