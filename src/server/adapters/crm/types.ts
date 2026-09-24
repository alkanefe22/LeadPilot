export type CrmContactInput = {
  workspaceId: string;
  leadId: string;
  email: string;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  status: string;
  score?: number | null;
  source?: string | null;
  note?: string | null;
};

export type CrmUpsertResult = { id: string; created: boolean; url?: string | null };

export interface CrmAdapter {
  readonly name: "internal" | "airtable" | "hubspot";
  upsertContact(input: CrmContactInput): Promise<CrmUpsertResult>;
}
