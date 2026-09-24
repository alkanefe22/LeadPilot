import { newId } from "@/lib/ids";
import { ProviderError, providerFetch } from "../http";
import { confirmedBookingIntervals } from "./mock";
import { generateSlots, overlaps, withinBusinessHours, type Interval } from "./slots";
import type { AvailabilityQuery, BookingRequest, CalendarAdapter, Slot } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

export type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
};

type FreeBusyResponse = {
  calendars: Record<
    string,
    { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }
  >;
};

type EventResponse = {
  id: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
};

/**
 * Google Calendar via REST (no googleapis SDK). Auth: OAuth refresh token → short-lived
 * access token, cached until shortly before expiry. Availability = workspace business
 * hours minus Google free/busy minus our own confirmed bookings, all computed in the
 * workspace timezone. Bookings get a Google Meet link.
 */
export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly name = "google" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: GoogleCalendarConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await providerFetch<{ access_token: string; expires_in: number }>(
      "google",
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          refresh_token: this.cfg.refreshToken,
        }).toString(),
      },
    );
    this.token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return res.access_token;
  }

  private async api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const token = await this.accessToken();
    return providerFetch<T>("google", `${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  }

  private calendarPath() {
    return `/calendars/${encodeURIComponent(this.cfg.calendarId)}`;
  }

  async busyIntervals(from: Date, to: Date, timeZone: string): Promise<Interval[]> {
    const res = await this.api<FreeBusyResponse>("/freeBusy", {
      method: "POST",
      json: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        timeZone,
        items: [{ id: this.cfg.calendarId }],
      },
    });
    const cal = res.calendars[this.cfg.calendarId];
    if (!cal)
      throw new ProviderError(
        "google",
        null,
        `calendar "${this.cfg.calendarId}" missing from free/busy response`,
        false,
      );
    if (cal.errors?.length) {
      throw new ProviderError(
        "google",
        null,
        `free/busy error: ${cal.errors.map((e) => e.reason).join(", ")}`,
        false,
      );
    }
    return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async getAvailability(q: AvailabilityQuery): Promise<Slot[]> {
    const [busy, taken] = await Promise.all([
      this.busyIntervals(q.from, q.to, q.timeZone),
      confirmedBookingIntervals(q.workspaceId, q.from, q.to),
    ]);
    const blocked = [...busy, ...taken];
    return generateSlots({ ...q, isBlocked: (slot) => blocked.some((b) => overlaps(slot, b)) });
  }

  async isAvailable(q: { start: Date; end: Date; timeZone: string }): Promise<boolean> {
    if (!withinBusinessHours(q.start, q.end, q.timeZone)) return false;
    const busy = await this.busyIntervals(q.start, q.end, q.timeZone);
    return !busy.some((b) => overlaps({ start: q.start, end: q.end }, b));
  }

  async book(req: BookingRequest) {
    const params = new URLSearchParams({
      conferenceDataVersion: "1",
      // Demo leads have made-up addresses: no attendee, no invite emails.
      sendUpdates: req.inviteAttendee ? "all" : "none",
    });
    const event = await this.api<EventResponse>(`${this.calendarPath()}/events?${params}`, {
      method: "POST",
      json: {
        summary: req.title,
        description: req.description,
        // Local wall time + IANA zone: Google renders it correctly for every attendee.
        start: { dateTime: toLocalIso(req.start, req.timeZone), timeZone: req.timeZone },
        end: { dateTime: toLocalIso(req.end, req.timeZone), timeZone: req.timeZone },
        ...(req.inviteAttendee
          ? {
              attendees: [
                { email: req.attendee.email, displayName: req.attendee.name ?? undefined },
              ],
            }
          : {}),
        conferenceData: {
          createRequest: {
            requestId: newId("meet", 20),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
        reminders: { useDefault: true },
      },
    });
    const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
    return { eventId: event.id, meetingUrl: event.hangoutLink ?? video ?? null };
  }

  async cancel(eventId: string) {
    await this.api(
      `${this.calendarPath()}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      {
        method: "DELETE",
      },
    );
  }

  async testConnection() {
    const cal = await this.api<{ summary?: string; timeZone?: string }>(this.calendarPath());
    return {
      ok: true as const,
      detail: `Connected to “${cal.summary ?? this.cfg.calendarId}” (${cal.timeZone ?? "?"})`,
    };
  }
}

/** UTC instant → "YYYY-MM-DDTHH:mm:ss" wall time in `timeZone` (no offset; paired with timeZone). */
export function toLocalIso(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
