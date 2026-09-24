import type { Qualification } from "../../db/schema";
import type { ConnectionCheck } from "../calendar/types";

export type CrmContactInput = {
  workspaceId: string;
  leadId: string;
  email: string;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  website?: string | null;
  status: string;
  score?: number | null;
  source?: string | null;
  note?: string | null;
  /** The agent's qualification (score, BANT, reasoning) — attached as a CRM note. */
  qualification?: Qualification | null;
};

export type CrmUpsertResult = { id: string; created: boolean; url?: string | null };

/**
 * CRM integration contract. Implemented: internal (own DB) and HubSpot.
 * Airtable is intentionally not implemented yet — adding it means one class with
 * `upsertContact` + `testConnection` and a line in adapters/index.ts.
 */
export interface CrmAdapter {
  readonly name: "internal" | "airtable" | "hubspot";
  upsertContact(input: CrmContactInput): Promise<CrmUpsertResult>;
  testConnection(): Promise<ConnectionCheck>;
}
