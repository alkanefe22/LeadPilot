import { and, eq, gt, lt } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { wallParts } from "@/lib/time";
import { getDb } from "../../db/client";
import { bookings } from "../../db/schema";
import { generateSlots, overlaps, withinBusinessHours, type Interval } from "./slots";
import type { AvailabilityQuery, CalendarAdapter, Slot } from "./types";

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

/** Confirmed bookings stored in our DB for a workspace, as intervals. */
export async function confirmedBookingIntervals(
  workspaceId: string,
  from: Date,
  to: Date,
): Promise<Interval[]> {
  const rows = await getDb()
    .select({ start: bookings.startAt, end: bookings.endAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.status, "confirmed"),
        lt(bookings.startAt, to),
        gt(bookings.endAt, from),
      ),
    );
  return rows;
}

/**
 * Demo calendar: weekdays 09:00–17:00 in the workspace timezone, with some hours
 * deterministically "busy" and real bookings (from the DB) removed.
 */
export class MockCalendarAdapter implements CalendarAdapter {
  readonly name = "mock" as const;

  async getAvailability(q: AvailabilityQuery): Promise<Slot[]> {
    const taken = await confirmedBookingIntervals(q.workspaceId, q.from, q.to);
    return generateSlots({
      ...q,
      isBlocked: (slot) =>
        isFakeBusy(slot.start, q.timeZone) || taken.some((b) => overlaps(slot, b)),
    });
  }

  async isAvailable(q: {
    workspaceId: string;
    start: Date;
    end: Date;
    timeZone: string;
  }): Promise<boolean> {
    if (!withinBusinessHours(q.start, q.end, q.timeZone)) return false;
    if (isFakeBusy(q.start, q.timeZone)) return false;
    const taken = await confirmedBookingIntervals(q.workspaceId, q.start, q.end);
    return taken.length === 0;
  }

  async book() {
    const id = newId("mockevt", 12);
    return { eventId: id, meetingUrl: `https://meet.example.com/${id.slice(8)}` };
  }

  async cancel() {}

  async testConnection() {
    return { ok: true as const, detail: "Built-in demo calendar (no external service)." };
  }
}
