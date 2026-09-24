import { wallParts, zonedToUtc } from "@/lib/time";
import type { Slot } from "./types";

export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 17;
export const STEP_MIN = 30;
const MAX_PER_DAY = 3;

export type Interval = { start: Date; end: Date };

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && a.end > b.start;

/** Weekday, 09:00–17:00 in the workspace timezone, not crossing midnight. */
export function withinBusinessHours(start: Date, end: Date, timeZone: string) {
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
 * Business-hour slots in the workspace's wall clock, converted to UTC per day so DST
 * transitions are handled (09:00 local stays 09:00 local on both sides of a switch).
 * Offers at most 3 slots per day so suggestions spread across the week.
 */
export function generateSlots(q: {
  from: Date;
  to: Date;
  durationMin: number;
  timeZone: string;
  limit: number;
  isBlocked: (slot: Interval) => boolean;
}): Slot[] {
  const slots: Slot[] = [];
  const durationMs = q.durationMin * 60_000;
  for (let dayOffset = 0; dayOffset < 45 && slots.length < q.limit; dayOffset++) {
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
      if (slots.some((s) => s.start === start.toISOString())) continue;
      if (q.isBlocked({ start, end })) continue;
      slots.push({ start: start.toISOString(), end: end.toISOString() });
      if (++perDay >= MAX_PER_DAY || slots.length >= q.limit) break;
    }
  }
  return slots;
}
