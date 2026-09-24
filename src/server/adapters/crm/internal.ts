import { sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { crmContacts } from "../../db/schema";
import type { CrmAdapter, CrmContactInput, CrmUpsertResult } from "./types";

/** Built-in CRM: a contacts table in our own Postgres, keyed by (workspace, email). */
export class InternalCrmAdapter implements CrmAdapter {
  readonly name = "internal" as const;

  async upsertContact(input: CrmContactInput): Promise<CrmUpsertResult> {
    const fields = {
      name: input.name ?? null,
      company: input.company ?? null,
      phone: input.phone ?? null,
      status: input.status,
      score: input.score ?? null,
      source: input.source ?? null,
    };
    const note = input.note ? [`${new Date().toISOString()} — ${input.note}`] : [];
    const [row] = await getDb()
      .insert(crmContacts)
      .values({
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        email: input.email.toLowerCase(),
        fields,
        notes: note,
      })
      .onConflictDoUpdate({
        target: [crmContacts.workspaceId, crmContacts.email],
        set: {
          leadId: input.leadId,
          fields: sql`${crmContacts.fields} || ${JSON.stringify(fields)}::jsonb`,
          notes: sql`${crmContacts.notes} || ${JSON.stringify(note)}::jsonb`,
          updatedAt: new Date(),
        },
      })
      // xmax = 0 ⇔ the row was inserted rather than updated.
      .returning({ id: crmContacts.id, created: sql<boolean>`(xmax = 0)` });
    return { id: row!.id, created: Boolean(row!.created) };
  }
}
