import { z } from "zod";
import { leadStatus } from "../../db/schema";
import { defineTool, ToolError } from "../types";

export const upsertCrmContact = defineTool({
  name: "upsert_crm_contact",
  description:
    "Create or update the lead as a contact in the CRM with its current status, score and a short note about what happened. Contact fields are taken from the lead record, not from you.",
  input: z.object({
    status: z.enum(leadStatus.enumValues).describe("Lifecycle status to record in the CRM."),
    note: z.string().trim().max(1000).optional().describe("One-line summary of this interaction."),
  }),
  async run(input, ctx) {
    const l = ctx.lead;
    if (!l.email)
      throw new ToolError("Lead has no email address; CRM contacts are keyed by email.");
    // Identity fields come from our record, never from the model, so lead-authored
    // text can't smuggle arbitrary values into the CRM.
    const res = await ctx.adapters.crm.upsertContact({
      workspaceId: ctx.workspace.id,
      leadId: l.id,
      email: l.email,
      name: l.name,
      company: l.company,
      phone: l.phone,
      website: l.website,
      source: l.source,
      status: input.status,
      score: l.score,
      note: input.note ?? null,
      qualification: ctx.state.qualification ?? l.qualification,
    });
    return {
      crm: ctx.adapters.crm.name,
      contact_id: res.id,
      created: res.created,
      url: res.url ?? null,
    };
  },
});
