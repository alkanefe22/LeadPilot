import { and, eq, gt, lt } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { wallParts, zonedToUtc } from "@/lib/time";
import { getDb } from "../../db/client";
import { bookings } from "../../db/schema";
import type { AvailabilityQuery, CalendarAdapter, Slot } from "./types";

const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;
const STEP_MIN = 30;

/** FNV-1a — deterministic "busy" hours so the demo calendar looks realistic but stable. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isFakeBusy(start: Date, timeZone: string) {
  const p = wallParts(start, timeZone);
  return hash(`${p.year}-${p.month}-${p.day}-${p.hour}`) % 4 === 0;
}

async function confirmedBookings(workspaceId: string, from: Date, to: Date) {
  return getDb()
    .select({ startAt: bookings.startAt, endAt: bookings.endAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.status, "confirmed"),
        lt(bookings.startAt, to),
        gt(bookings.endAt, from),
      ),
    );
}

const overlaps = (a: { start: Date; end: Date }, b: { startAt: Date; endAt: Date }) =>
  a.start < b.endAt && a.end > b.startAt;

function withinBusinessHours(start: Date, end: Date, timeZone: string) {
  const s = wallParts(start, timeZone);
  const e = wallParts(new Date(end.getTime() - 1), timeZone);
  return (
    s.weekday >= 1 &&
    s.weekday <= 5 &&
    s.day === e.day &&
    s.hour >= OPEN_HOUR &&
    (e.hour < CLOSE_HOUR || (e.hour === CLOSE_HOUR && e.minute === 0))
  );
}

/**
 * Demo calendar: weekdays 09:00–17:00 in the workspace timezone, with some hours
 * deterministically "busy" and real bookings (from the DB) removed.
 */
export class MockCalendarAdapter implements CalendarAdapter {
  readonly name = "mock" as const;

  async getAvailability(q: AvailabilityQuery): Promise<Slot[]> {
    const taken = await confirmedBookings(q.workspaceId, q.from, q.to);
    const slots: Slot[] = [];
    const durationMs = q.durationMin * 60_000;
    // Walk day by day in the workspace's wall clock.
    for (let dayOffset = 0; dayOffset < 30 && slots.length < q.limit; dayOffset++) {
      const day = wallParts(new Date(q.from.getTime() + dayOffset * 86_400_000), q.timeZone);
      if (day.weekday === 0 || day.weekday === 6) continue;
      let perDay = 0;
      for (let min = OPEN_HOUR * 60; min + q.durationMin <= CLOSE_HOUR * 60; min += STEP_MIN) {
        const start = zonedToUtc(
          day.year,
          day.month,
          day.day,
          Math.floor(min / 60),
          min % 60,
          q.timeZone,
        );
        const end = new Date(start.getTime() + durationMs);
        if (start < q.from || end > q.to) continue;
        if (isFakeBusy(start, q.timeZone)) continue;
        if (taken.some((b) => overlaps({ start, end }, b))) continue;
        slots.push({ start: start.toISOString(), end: end.toISOString() });
        // Offer a spread across days rather than one packed morning.
        if (++perDay >= 3 || slots.length >= q.limit) break;
      }
    }
    return slots;
  }

  async isAvailable(q: {
    workspaceId: string;
    start: Date;
    end: Date;
    timeZone: string;
    durationMin: number;
  }): Promise<boolean> {
    if (!withinBusinessHours(q.start, q.end, q.timeZone)) return false;
    if (isFakeBusy(q.start, q.timeZone)) return false;
    const taken = await confirmedBookings(q.workspaceId, q.start, q.end);
    return taken.length === 0;
  }

  async book() {
    const id = newId("mockevt", 12);
    return { eventId: id, meetingUrl: `https://meet.example.com/${id.slice(8)}` };
  }

  async cancel() {}
}
