import type { Qualification } from "../../db/schema";
import { providerFetch } from "../http";
import type { CrmAdapter, CrmContactInput, CrmUpsertResult } from "./types";

const API = "https://api.hubapi.com";
/** HubSpot-defined association type: note → contact. */
const NOTE_TO_CONTACT = 202;

/** Our lead status → HubSpot's standard `hs_lead_status` options (no custom properties needed). */
const LEAD_STATUS: Record<string, string> = {
  new: "NEW",
  needs_info: "IN_PROGRESS",
  qualified: "OPEN_DEAL",
  booked: "CONNECTED",
  disqualified: "UNQUALIFIED",
};

type UpsertResponse = { results: { id: string; new?: boolean }[] };

export function splitName(name: string | null | undefined): {
  firstname?: string;
  lastname?: string;
} {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return parts.length === 1
    ? { firstname: parts[0] }
    : { firstname: parts.slice(0, -1).join(" "), lastname: parts.at(-1) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Qualification summary rendered as the note body (HubSpot notes accept simple HTML). */
export function qualificationNote(
  q: Qualification | null | undefined,
  extra?: string | null,
): string {
  const lines: string[] = ["<strong>LeadPilot qualification</strong>"];
  if (q) {
    lines.push(`Score: <strong>${q.score}/100</strong> · category: ${esc(q.category)}`);
    for (const k of ["budget", "authority", "need", "timeline"] as const) {
      lines.push(`${k[0]!.toUpperCase()}${k.slice(1)}: ${q[k] ? esc(q[k]!) : "<em>unknown</em>"}`);
    }
    lines.push(`Reasoning: ${esc(q.reasoning)}`);
    if (q.disqualification)
      lines.push(
        `Disqualified (${esc(q.disqualification.category)}): ${esc(q.disqualification.reason)}`,
      );
  } else {
    lines.push("<em>Not scored yet.</em>");
  }
  if (extra) lines.push(`Agent note: ${esc(extra)}`);
  return lines.join("<br>");
}

/**
 * HubSpot CRM via a Private App access token (scopes: crm.objects.contacts.read/write).
 * Contacts are upserted by email; each call attaches the qualification summary as a note.
 */
export class HubSpotCrmAdapter implements CrmAdapter {
  readonly name = "hubspot" as const;

  constructor(private readonly token: string) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async upsertContact(input: CrmContactInput): Promise<CrmUpsertResult> {
    const properties: Record<string, string> = {
      email: input.email.toLowerCase(),
      ...splitName(input.name),
      ...(input.company ? { company: input.company } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.website ? { website: input.website } : {}),
      ...(LEAD_STATUS[input.status] ? { hs_lead_status: LEAD_STATUS[input.status]! } : {}),
    };
    const upsert = await providerFetch<UpsertResponse>(
      "hubspot",
      `${API}/crm/v3/objects/contacts/batch/upsert`,
      {
        method: "POST",
        headers: this.headers(),
        json: { inputs: [{ idProperty: "email", id: properties.email, properties }] },
      },
    );
    const contact = upsert.results[0];
    if (!contact) throw new Error("HubSpot upsert returned no contact");

    await providerFetch("hubspot", `${API}/crm/v3/objects/notes`, {
      method: "POST",
      headers: this.headers(),
      json: {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: qualificationNote(input.qualification, input.note),
        },
        associations: [
          {
            to: { id: contact.id },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }],
          },
        ],
      },
    });
    return { id: contact.id, created: contact.new ?? false, url: null };
  }

  async testConnection() {
    await providerFetch("hubspot", `${API}/crm/v3/objects/contacts?limit=1&properties=email`, {
      headers: this.headers(),
    });
    return { ok: true as const, detail: "Private App token can read contacts." };
  }
}
