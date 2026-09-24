import "server-only";
import { env, type Env } from "@/lib/env";
import { MockCalendarAdapter } from "./calendar/mock";
import type { CalendarAdapter } from "./calendar/types";
import { InternalCrmAdapter } from "./crm/internal";
import type { CrmAdapter } from "./crm/types";
import { ConsoleEmailAdapter } from "./email/console";
import type { EmailAdapter } from "./email/types";

export type Adapters = { calendar: CalendarAdapter; crm: CrmAdapter; email: EmailAdapter };

export type AdapterStatus = {
  kind: "calendar" | "crm" | "email";
  active: string;
  requested: string;
  /** Why we're on a fallback, if we are. */
  note: string | null;
};

type Choice<T> = { adapter: T; status: AdapterStatus };

/**
 * Adapter selection. "auto" → the real integration when its keys exist, otherwise the
 * built-in mock. An explicitly requested integration with missing keys also falls back
 * (with a note shown in Settings) — misconfiguration must never take the agent down.
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

function pickCalendar(e: Env): Choice<CalendarAdapter> {
  const requested = e.CALENDAR_ADAPTER;
  const note =
    requested === "google"
      ? "Google Calendar adapter ships in M5 — using the mock calendar."
      : null;
  return {
    adapter: new MockCalendarAdapter(),
    status: { kind: "calendar", active: "mock", requested, note },
  };
}

function pickCrm(e: Env): Choice<CrmAdapter> {
  const requested = e.CRM_ADAPTER;
  const note =
    requested === "airtable" || requested === "hubspot"
      ? `${requested} adapter ships in M5 — using the internal CRM.`
      : null;
  return {
    adapter: new InternalCrmAdapter(),
    status: { kind: "crm", active: "internal", requested, note },
  };
}

function pickEmail(e: Env): Choice<EmailAdapter> {
  const requested = e.EMAIL_ADAPTER;
  const note =
    requested === "resend" ? "Resend adapter ships in M5 — using the console outbox." : null;
  return {
    adapter: new ConsoleEmailAdapter(),
    status: { kind: "email", active: "console", requested, note },
  };
}

let cached: Adapters | undefined;
export function getAdapters(): Adapters {
  cached ??= selectAdapters().adapters;
  return cached;
}
