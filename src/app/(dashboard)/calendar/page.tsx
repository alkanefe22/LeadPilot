import { and, asc, eq, gte } from "drizzle-orm";
import { CalendarDaysIcon, VideoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { wallParts } from "@/lib/time";
import { getDb } from "@/server/db/client";
import { bookings, leads } from "@/server/db/schema";
import { currentWorkspaceId, getWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

/** Wall clock for this request (kept out of the component body for the React purity lint). */
const requestTime = () => Date.now();

export default async function CalendarPage() {
  const workspace = await getWorkspace();
  const tz = workspace?.timezone ?? "UTC";
  const now = requestTime();
  const since = new Date(now - 7 * 86_400_000);
  const rows = await getDb()
    .select({ booking: bookings, leadName: leads.name, company: leads.company })
    .from(bookings)
    .innerJoin(leads, eq(leads.id, bookings.leadId))
    .where(
      and(
        eq(bookings.workspaceId, currentWorkspaceId()),
        eq(bookings.status, "confirmed"),
        gte(bookings.startAt, since),
      ),
    )
    .orderBy(asc(bookings.startAt));

  const dayLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const timeLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const p = wallParts(r.booking.startAt, tz);
    const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return (
    <>
      <PageHeader
        title="Calendar"
        description={`Meetings booked by the agent · times in ${tz} · ${workspace?.meetingDurationMin ?? 30}-minute discovery calls`}
      />
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
          <CalendarDaysIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">No meetings booked yet</p>
          <p className="text-sm text-muted-foreground">
            Qualified leads get booked here automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([key, items]) => (
            <section key={key} aria-label={dayLabel.format(items[0]!.booking.startAt)}>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                {dayLabel.format(items[0]!.booking.startAt)}
              </h2>
              <ul className="space-y-2">
                {items.map(({ booking: b, leadName, company }) => {
                  const past = b.endAt.getTime() < now;
                  return (
                    <li key={b.id} className={past ? "opacity-60" : undefined}>
                      <Link
                        href={`/leads/${b.leadId}`}
                        className="flex items-center gap-4 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40"
                      >
                        <div className="w-20 shrink-0 text-center">
                          <div className="font-mono text-lg font-semibold tabular-nums">
                            {timeLabel.format(b.startAt)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {timeLabel.format(b.endAt)}
                          </div>
                        </div>
                        <div className="h-10 w-1 shrink-0 rounded-full bg-primary" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{b.title}</p>
                          <p className="truncate text-sm text-muted-foreground">
                            {leadName ?? "Lead"}
                            {company ? ` · ${company}` : ""}
                          </p>
                        </div>
                        <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                          <VideoIcon className="size-3.5" /> {b.provider}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
