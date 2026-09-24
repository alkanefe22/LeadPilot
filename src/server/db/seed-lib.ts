import { sql } from "drizzle-orm";
import { newId } from "../../lib/ids";
import type { Database } from "./client";
import { leads, messages, workspaces } from "./schema";
import { DEFAULT_ICP, DEFAULT_RULES, DEFAULT_WORKSPACE_ID, SEED_LEADS } from "./seed-data";

export async function resetDatabase(db: Database) {
  await db.execute(
    sql`TRUNCATE TABLE agent_steps, agent_runs, approvals, bookings, emails, crm_contacts, messages, leads, rate_limits, workspaces RESTART IDENTITY CASCADE`,
  );
}

export async function ensureDefaultWorkspace(db: Database, webhookSecret?: string) {
  await db
    .insert(workspaces)
    .values({
      id: DEFAULT_WORKSPACE_ID,
      name: "Northwind Automation",
      slug: "northwind",
      icpText: DEFAULT_ICP,
      qualificationRules: DEFAULT_RULES,
      scoreThreshold: 70,
      requireApproval: false,
      webhookSecret: webhookSecret ?? newId("whsec", 32),
      timezone: "Europe/Istanbul",
      meetingDurationMin: 30,
      senderName: "Northwind Automation",
    })
    .onConflictDoNothing();
  return DEFAULT_WORKSPACE_ID;
}

/** Inserts the 15 demo leads (idempotent thanks to external_id dedupe). Returns inserted ids. */
export async function seedLeads(db: Database, workspaceId = DEFAULT_WORKSPACE_ID) {
  const now = Date.now();
  const ids: string[] = [];
  for (const [i, l] of SEED_LEADS.entries()) {
    const createdAt = new Date(now - l.hoursAgo * 3_600_000);
    const [row] = await db
      .insert(leads)
      .values({
        workspaceId,
        source: l.source,
        externalId: `seed-${i + 1}`,
        name: l.name,
        email: l.email,
        company: l.company,
        phone: l.phone ?? null,
        website: l.website ?? null,
        message: l.message,
        rawPayload: { seed: true, index: i + 1 },
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: leads.id });
    if (!row) continue;
    ids.push(row.id);
    await db.insert(messages).values({
      leadId: row.id,
      direction: "inbound",
      channel: l.source,
      subject: l.source === "email" ? `Inquiry from ${l.name ?? l.email}` : null,
      body: l.message,
      createdAt,
    });
  }
  return ids;
}
