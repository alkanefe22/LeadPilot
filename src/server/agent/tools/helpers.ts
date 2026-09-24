import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client";
import { bookings, leads, type Lead, type Qualification } from "../../db/schema";
import { RISK_PROMPT_INJECTION } from "../guards";
import type { ToolContext } from "../types";

export async function updateLead(ctx: ToolContext, patch: Partial<Lead>) {
  const [row] = await ctx.db.update(leads).set(patch).where(eq(leads.id, ctx.lead.id)).returning();
  if (row) ctx.lead = row;
  return ctx.lead;
}

export async function confirmedBooking(db: Database, leadId: string) {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.leadId, leadId), eq(bookings.status, "confirmed")))
    .orderBy(desc(bookings.createdAt))
    .limit(1);
  return row ?? null;
}

export const isFlagged = (lead: Lead) => lead.riskFlags.includes(RISK_PROMPT_INJECTION);

/** The qualification this run produced, or the one stored from a previous run. */
export function currentQualification(ctx: ToolContext): Qualification | null {
  return ctx.state.qualification ?? ctx.lead.qualification ?? null;
}

// Models occasionally send numbers as strings ("85"); accept those, reject everything else.
export const intFrom = (min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
    z.number().int().min(min).max(max),
  );

export const nullableText = (max: number, description: string) =>
  z
    .string()
    .max(max)
    .nullable()
    .describe(description)
    .transform((v) => (v && v.trim() ? v.trim() : null));

export const emailSubject = z.string().trim().min(3).max(160).describe("Email subject line");
export const emailBody = z
  .string()
  .trim()
  .min(20)
  .max(4000)
  .describe(
    "Plain-text email body in the lead's language. No markdown. Sign with the sender name.",
  );
