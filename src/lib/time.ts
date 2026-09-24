/**
 * Tiny timezone helpers built on Intl (no tz database dependency).
 * All instants are JS Dates (UTC); "wall time" means the clock in a given IANA zone.
 */

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function wallParts(date: Date, timeZone: string): Parts {
  const get = (type: string, parts: Intl.DateTimeFormatPart[]) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  const parts = formatter(timeZone).formatToParts(date);
  return {
    year: Number(get("year", parts)),
    month: Number(get("month", parts)),
    day: Number(get("day", parts)),
    hour: Number(get("hour", parts)),
    minute: Number(get("minute", parts)),
    weekday: WEEKDAYS[get("weekday", parts)] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at instant `date`, in ms (e.g. +3h for Europe/Istanbul). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = wallParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** The UTC instant at which the wall clock in `timeZone` shows the given date/time. */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass handles DST transitions between the guess and the result.
  return new Date(guess - tzOffsetMs(new Date(first), timeZone));
}

export function formatInTz(date: Date, timeZone: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
