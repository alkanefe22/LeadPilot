import "server-only";
import { env, type Env } from "@/lib/env";
import { GoogleCalendarAdapter } from "./calendar/google";
import { MockCalendarAdapter } from "./calendar/mock";
import type { CalendarAdapter } from "./calendar/types";
import { HubSpotCrmAdapter } from "./crm/hubspot";
import { InternalCrmAdapter } from "./crm/internal";
import type { CrmAdapter } from "./crm/types";
import { ConsoleEmailAdapter } from "./email/console";
import { ResendEmailAdapter } from "./email/resend";
import type { EmailAdapter } from "./email/types";

export type Adapters = { calendar: CalendarAdapter; crm: CrmAdapter; email: EmailAdapter };
export type AdapterKind = keyof Adapters;

export type AdapterStatus = {
  kind: AdapterKind;
  active: string;
  requested: string;
  /** Configuration-time note (e.g. why we're on the built-in adapter). */
  note: string | null;
  /** True when a real external provider is active. */
  external: boolean;
};

type Choice<T> = { adapter: T; status: AdapterStatus };

/**
 * Adapter selection happens once, from env vars, at configuration time:
 *   "auto"      → the real integration when all of its keys exist, otherwise the built-in one.
 *   explicit    → that integration; if its keys are missing we fall back *with a visible note*.
 * There is NO runtime fallback: once a real provider is selected, its failures surface as
 * tool errors in the trace and a red badge in Settings (see adapters/http.ts).
 */
export function selectAdapters(e: Env = env()): { adapters: Adapters; status: AdapterStatus[] } {
  const calendar = pickCalendar(e);
  const crm = pickCrm(e);
  const email = pickEmail(e);
  return {
    adapters: { calendar: calendar.adapter, crm: crm.adapter, email: email.adapter },
    status: [calendar.status, crm.status, email.status],
  };
}

const missing = (vars: Record<string, string | undefined>) =>
  Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => k);

function pickCalendar(e: Env): Choice<CalendarAdapter> {
  const requested = e.CALENDAR_ADAPTER;
  const need = missing({
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: e.GOOGLE_REFRESH_TOKEN,
  });
  if (requested !== "mock" && need.length === 0) {
    return {
      adapter: new GoogleCalendarAdapter({
        clientId: e.GOOGLE_CLIENT_ID!,
        clientSecret: e.GOOGLE_CLIENT_SECRET!,
        refreshToken: e.GOOGLE_REFRESH_TOKEN!,
        calendarId: e.GOOGLE_CALENDAR_ID ?? "primary",
      }),
      status: { kind: "calendar", active: "google", requested, note: null, external: true },
    };
  }
  return {
    adapter: new MockCalendarAdapter(),
    status: {
      kind: "calendar",
      active: "mock",
      requested,
      note:
        requested === "google"
          ? `Google Calendar requested but ${need.join(", ")} missing — using the demo calendar.`
          : null,
      external: false,
    },
  };
}

function pickCrm(e: Env): Choice<CrmAdapter> {
  const requested = e.CRM_ADAPTER;
  const wantsHubspot = requested === "hubspot" || requested === "auto";
  if (wantsHubspot && e.HUBSPOT_ACCESS_TOKEN) {
    return {
      adapter: new HubSpotCrmAdapter(e.HUBSPOT_ACCESS_TOKEN),
      status: { kind: "crm", active: "hubspot", requested, note: null, external: true },
    };
  }
  const note =
    requested === "hubspot"
      ? "HubSpot requested but HUBSPOT_ACCESS_TOKEN missing — using the internal CRM."
      : requested === "airtable"
        ? "Airtable isn't implemented yet (the CrmAdapter interface makes it easy to add) — using the internal CRM."
        : null;
  return {
    adapter: new InternalCrmAdapter(),
    status: { kind: "crm", active: "internal", requested, note, external: false },
  };
}

function pickEmail(e: Env): Choice<EmailAdapter> {
  const requested = e.EMAIL_ADAPTER;
  const need = missing({ RESEND_API_KEY: e.RESEND_API_KEY, EMAIL_FROM: e.EMAIL_FROM });
  if (requested !== "console" && need.length === 0) {
    return {
      adapter: new ResendEmailAdapter(e.RESEND_API_KEY!),
      status: { kind: "email", active: "resend", requested, note: null, external: true },
    };
  }
  return {
    adapter: new ConsoleEmailAdapter(),
    status: {
      kind: "email",
      active: "console",
      requested,
      note:
        requested === "resend"
          ? `Resend requested but ${need.join(", ")} missing — using the console outbox.`
          : null,
      external: false,
    },
  };
}

let cached: Adapters | undefined;
export function getAdapters(): Adapters {
  cached ??= selectAdapters().adapters;
  return cached;
}
