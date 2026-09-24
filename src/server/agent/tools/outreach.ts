import { z } from "zod";
import { ProviderError } from "../../adapters/http";
import { sendLeadEmail } from "../../services/email";
import { defineTool, ToolError, type ToolContext } from "../types";
import { emailBody, emailSubject, updateLead } from "./helpers";

async function deliver(ctx: ToolContext, subject: string, body: string, kind: string) {
  if (!ctx.lead.email) throw new ToolError("Lead has no email address.");
  const res = await sendLeadEmail({
    db: ctx.db,
    adapter: ctx.adapters.email,
    workspace: ctx.workspace,
    lead: ctx.lead,
    subject,
    body,
    kind,
  });
  if (res.status === "failed") {
    // Keep the structured provider error (status, hint) for the trace.
    if (res.cause instanceof ProviderError) throw res.cause;
    throw new ToolError(`Email provider error: ${res.error}`);
  }
  if (res.status === "sent") ctx.state.outwardActions.push(kind);
  return res;
}

export const askFollowupQuestion = defineTool({
  name: "ask_followup_question",
  description:
    "Email the lead ONE concise message asking only for the missing qualification details (e.g. budget, timeline). Use when the lead looks promising but can't be qualified yet. Their reply will continue this thread.",
  approvable: true,
  input: z.object({
    subject: emailSubject,
    body: emailBody,
    missing_fields: z
      .array(z.enum(["budget", "timeline", "need", "authority", "company", "contact"]))
      .min(1)
      .max(6),
  }),
  async run(input, ctx) {
    const res = await deliver(ctx, input.subject, input.body, "followup");
    if (ctx.lead.status === "new" || ctx.lead.status === "qualified") {
      await updateLead(ctx, { status: "needs_info" });
    }
    return { ...res, asked_for: input.missing_fields, lead_status: ctx.lead.status };
  },
});

export const sendEmail = defineTool({
  name: "send_email",
  description:
    "Send an email to the lead: a booking confirmation (include the local time and meeting link), a polite decline for genuine poor-fit leads, or another reply. Never email spam senders.",
  approvable: true,
  input: z.object({
    purpose: z.enum(["confirmation", "rejection", "reply"]),
    subject: emailSubject,
    body: emailBody,
  }),
  async run(input, ctx) {
    return deliver(ctx, input.subject, input.body, input.purpose);
  },
});
