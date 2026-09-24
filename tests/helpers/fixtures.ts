import { eq } from "drizzle-orm";
import type { Adapters } from "@/server/adapters";
import { MockCalendarAdapter } from "@/server/adapters/calendar/mock";
import { InternalCrmAdapter } from "@/server/adapters/crm/internal";
import { ConsoleEmailAdapter } from "@/server/adapters/email/console";
import type { Database } from "@/server/db/client";
import { leads, messages, workspaces, type Lead } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID } from "@/server/db/seed-data";

export function testAdapters(): Adapters {
  return {
    calendar: new MockCalendarAdapter(),
    crm: new InternalCrmAdapter(),
    email: new ConsoleEmailAdapter(() => {}),
  };
}

let n = 0;
export async function createLead(db: Database, overrides: Partial<Lead> = {}): Promise<Lead> {
  n++;
  const message =
    overrides.message ??
    "VP Operations at a 100-person logistics company. We want an AI agent for order intake. Budget $20k, start next month.";
  const [lead] = await db
    .insert(leads)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: "form",
      externalId: `test-${n}-${Math.random()}`,
      name: "Sarah Mitchell",
      email: `sarah${n}@freightlane.io`,
      company: "FreightLane",
      ...overrides,
      message,
    })
    .returning();
  await db
    .insert(messages)
    .values({ leadId: lead!.id, direction: "inbound", channel: "form", body: message });
  return lead!;
}

export async function setWorkspace(db: Database, patch: Partial<typeof workspaces.$inferInsert>) {
  await db.update(workspaces).set(patch).where(eq(workspaces.id, DEFAULT_WORKSPACE_ID));
}

export const GOOD_SCORE = {
  score: 88,
  category: "fit",
  reasoning: "VP Ops with a $20k budget and a concrete intake automation need starting next month.",
  budget: "$20k",
  timeline: "next month",
  need: "order intake automation",
  authority: "VP Operations",
  missing: [],
  language: "en",
};
