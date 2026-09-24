import { formatDistanceToNowStrict } from "date-fns";
import { and, asc, eq } from "drizzle-orm";
import {
  ArrowLeftIcon,
  BuildingIcon,
  CalendarCheckIcon,
  GlobeIcon,
  MailIcon,
  PhoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClearFlagButton, RerunButton } from "@/components/leads/lead-actions";
import { isInjectionFlagged, patternText, RiskFlagBadge } from "@/components/leads/risk-flag";
import { SourceLabel } from "@/components/leads/source-icon";
import { ScorePill, StatusBadge } from "@/components/leads/status-badge";
import { TracePanel } from "@/components/trace/trace-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { bookings, leads, messages } from "@/server/db/schema";
import { maskEmail, maskText } from "@/server/security/redact";
import { getLeadTrace } from "@/server/services/trace";
import { getWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadDetailPage({ params }: PageProps<"/leads/[id]">) {
  const { id } = await params;
  const db = getDb();
  const viewer = await getViewer();
  const redact = !viewer.isAdmin;
  const [[lead], thread, [booking], trace, workspace] = await Promise.all([
    db.select().from(leads).where(eq(leads.id, id)),
    db.select().from(messages).where(eq(messages.leadId, id)).orderBy(asc(messages.createdAt)),
    db
      .select()
      .from(bookings)
      .where(and(eq(bookings.leadId, id), eq(bookings.status, "confirmed"))),
    getLeadTrace(id, { redact }),
    getWorkspace(),
  ]);
  if (!lead || !trace) notFound();

  const tz = workspace?.timezone ?? "UTC";
  const flagged = isInjectionFlagged(lead.riskFlags);
  const running = trace.runs[0]?.status === "running";
  const q = lead.qualification;
  const show = (v: string | null) => (v && redact ? maskText(v) : v);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> Leads
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">
                {lead.name ?? (redact ? maskEmail(lead.email) : lead.email) ?? "Unknown sender"}
              </h1>
              <StatusBadge status={lead.status} />
              {flagged ? <RiskFlagBadge matches={lead.riskMatches} /> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {lead.company ? <span>{lead.company}</span> : null}
              <SourceLabel source={lead.source} />
              <span>received {formatDistanceToNowStrict(lead.createdAt, { addSuffix: true })}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RerunButton leadId={lead.id} isAdmin={viewer.isAdmin} running={running} />
          </div>
        </div>
      </div>

      {flagged ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-orange-500/40 bg-orange-500/5 p-4 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="flex gap-3">
            <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-orange-600 dark:text-orange-400" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-orange-800 dark:text-orange-200">
                ⚠ Flagged: possible prompt injection
              </p>
              <p className="text-muted-foreground">
                The inbound scanner found text that seems aimed at the AI agent. While flagged, the
                lead can&apos;t be auto-qualified and every outward action waits for human approval.
              </p>
              <ul className="flex flex-wrap gap-1.5 pt-1">
                {(lead.riskMatches.length ? lead.riskMatches : ["prompt_injection"]).map((m) => (
                  <li
                    key={m}
                    className="rounded-md border border-orange-500/30 bg-background px-2 py-0.5 text-xs"
                  >
                    <code className="font-mono">{m}</code> · {patternText(m)}
                  </li>
                ))}
              </ul>
              <p className="pt-1 text-xs text-muted-foreground">
                Heuristics can misfire — if this is a genuine lead, clear the flag.
              </p>
            </div>
          </div>
          <ClearFlagButton leadId={lead.id} isAdmin={viewer.isAdmin} running={running} />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-label="Agent trace" className="min-w-0">
          <TracePanel key={trace.runs[0]?.id ?? "none"} leadId={lead.id} initial={trace} />
        </section>

        <aside className="space-y-4">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <InfoRow icon={MailIcon} value={redact ? maskEmail(lead.email) : lead.email} />
              <InfoRow icon={PhoneIcon} value={show(lead.phone)} />
              <InfoRow icon={BuildingIcon} value={lead.company} />
              <InfoRow icon={GlobeIcon} value={lead.website} />
              {booking ? (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                  <CalendarCheckIcon className="mt-0.5 size-4 text-emerald-600" />
                  <div>
                    <p className="font-medium">{formatInTz(booking.startAt, tz)}</p>
                    <p className="text-xs text-muted-foreground">
                      {booking.provider} calendar · {booking.meetingUrl}
                    </p>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Qualification <ScorePill score={lead.score} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {q ? (
                <>
                  <p className="text-muted-foreground">{q.reasoning}</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    {(["budget", "authority", "need", "timeline"] as const).map((k) => (
                      <div key={k} className="contents">
                        <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                          {k}
                        </dt>
                        <dd className={cn(!q[k] && "text-muted-foreground italic")}>
                          {q[k] ?? "unknown"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <span className="rounded-md border px-1.5 py-0.5">category: {q.category}</span>
                    {q.language ? (
                      <span className="rounded-md border px-1.5 py-0.5">lang: {q.language}</span>
                    ) : null}
                    {q.disqualification ? (
                      <span className="rounded-md border px-1.5 py-0.5">
                        disqualified: {q.disqualification.category}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">Not scored yet.</p>
              )}
            </CardContent>
          </Card>

          <Card size="sm">
            <CardHeader>
              <CardTitle>Conversation</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {thread.map((m) => (
                  <li
                    key={m.id}
                    className={cn(
                      "rounded-lg border p-3 text-sm",
                      m.direction === "outbound"
                        ? "ml-4 border-primary/30 bg-primary/5"
                        : "mr-4 bg-muted/40",
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">
                        {m.direction === "outbound" ? "Agent" : "Lead"} · {m.channel}
                      </span>
                      <time dateTime={m.createdAt.toISOString()}>
                        {formatDistanceToNowStrict(m.createdAt, { addSuffix: true })}
                      </time>
                    </div>
                    {m.subject ? <p className="mb-1 font-medium">{m.subject}</p> : null}
                    <p className="break-words whitespace-pre-wrap">
                      {redact ? maskText(m.body) : m.body}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  value,
}: {
  icon: typeof MailIcon;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className={cn("truncate", !value && "text-muted-foreground italic")}>
        {value ?? "—"}
      </span>
    </div>
  );
}
