"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isValidTimeZone } from "@/lib/time";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { sanitizeLine, sanitizeText } from "@/server/security/sanitize";
import { currentWorkspaceId } from "@/server/workspace";

const settingsSchema = z.object({
  icpText: z.string().max(8000),
  qualificationRules: z.string().max(8000),
  scoreThreshold: z.coerce.number().int().min(1).max(100),
  requireApproval: z.boolean(),
  requireBudgetTimelineToBook: z.boolean(),
  meetingDurationMin: z.coerce
    .number()
    .int()
    .refine((v) => [15, 20, 30, 45, 60].includes(v)),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone"),
  senderName: z.string().min(1).max(80),
});

export type SettingsInput = z.infer<typeof settingsSchema>;
export type SaveResult = { ok: true } | { ok: false; error: string };

export async function saveSettings(input: SettingsInput): Promise<SaveResult> {
  // Server actions are public endpoints: authorize inside, never rely on the UI.
  if (!(await getViewer()).isAdmin) return { ok: false, error: "Admin login required." };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const d = parsed.data;
  await getDb()
    .update(workspaces)
    .set({
      icpText: sanitizeText(d.icpText, 8000),
      qualificationRules: sanitizeText(d.qualificationRules, 8000),
      scoreThreshold: d.scoreThreshold,
      requireApproval: d.requireApproval,
      requireBudgetTimelineToBook: d.requireBudgetTimelineToBook,
      meetingDurationMin: d.meetingDurationMin,
      timezone: d.timezone,
      senderName: sanitizeLine(d.senderName, 80) ?? "LeadPilot",
    })
    .where(eq(workspaces.id, currentWorkspaceId()));
  revalidatePath("/", "layout");
  return { ok: true };
}
