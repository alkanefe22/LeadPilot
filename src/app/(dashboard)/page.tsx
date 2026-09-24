import { formatDistanceToNowStrict } from "date-fns";
import {
  CalendarCheckIcon,
  CoinsIcon,
  InboxIcon,
  PercentIcon,
  TimerIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { STATUS_META } from "@/components/leads/status-badge";
import { LeadsPerDayChart, SpendPerDayChart } from "@/components/overview/charts";
import { RunStatusPill } from "@/components/trace/trace-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration, formatUsd } from "@/lib/format";
import type { AgentRun, LeadStatus } from "@/server/db/schema";
import { getOverviewStats } from "@/server/services/stats";
import { currentWorkspaceId } from "@/server/workspace";

export const dynamic = "force-dynamic";

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </div>
        <div className="font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export default async function OverviewPage() {
  const s = await getOverviewStats(currentWorkspaceId());
  const statuses = Object.keys(STATUS_META) as LeadStatus[];
  const maxStatus = Math.max(1, ...statuses.map((k) => s.statusCounts[k]));

  return (
    <>
      <PageHeader
        title="Overview"
        description="How the AI lead agent is performing — computed live from runs, leads and bookings."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          icon={InboxIcon}
          label="Leads today"
          value={String(s.leadsToday)}
          hint={`${s.totalLeads} total`}
        />
        <Kpi
          icon={PercentIcon}
          label="Qualified"
          value={s.qualifiedPct === null ? "—" : `${Math.round(s.qualifiedPct)}%`}
          hint={`of ${s.scoredLeads} scored leads`}
        />
        <Kpi
          icon={CalendarCheckIcon}
          label="Meetings booked"
          value={String(s.meetingsBooked)}
          hint="confirmed bookings"
        />
        <Kpi
          icon={TimerIcon}
          label="Avg first response"
          value={formatDuration(s.avgFirstResponseMs)}
          hint={
            s.respondedLeads
              ? `agent start → first email · ${s.respondedLeads} leads`
              : "no emails sent yet"
          }
        />
        <Kpi
          icon={CoinsIcon}
          label={s.freeTierRuns ? "Avg cost / lead (est.)" : "Avg cost / lead"}
          value={formatUsd(s.avgCostPerLead, { precise: true })}
          hint={s.freeTierRuns ? "at paid rates · free tier billed $0" : "all runs incl. re-runs"}
        />
        <Kpi
          icon={WalletIcon}
          label={s.freeTierRuns ? "Agent spend (est.)" : "Agent spend"}
          value={formatUsd(s.totalCost)}
          hint={
            s.freeTierRuns
              ? `${s.totalRuns} runs · ${s.freeTierRuns} on free tier ($0 billed)`
              : `${s.totalRuns} runs · avg ${formatDuration(s.avgRunLatencyMs)}`
          }
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Leads per day</CardTitle>
            <CardDescription>Last 14 days (UTC)</CardDescription>
          </CardHeader>
          <CardContent>
            <LeadsPerDayChart data={s.daily} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Agent spend per day</CardTitle>
            <CardDescription>Estimated from token usage</CardDescription>
          </CardHeader>
          <CardContent>
            <SpendPerDayChart data={s.daily} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>Current status of every lead</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {statuses.map((k) => (
                <li key={k} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-sm">
                  <Link
                    href={`/leads?status=${k}`}
                    className="flex items-center gap-2 hover:underline"
                  >
                    <span className={`size-2 rounded-full ${STATUS_META[k].dot}`} />
                    {STATUS_META[k].label}
                  </Link>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-chart-1"
                      style={{ width: `${(s.statusCounts[k] / maxStatus) * 100}%` }}
                    />
                  </div>
                  <span className="text-right font-mono tabular-nums">{s.statusCounts[k]}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent agent runs</CardTitle>
            <CardDescription>Open one to see its full trace</CardDescription>
          </CardHeader>
          <CardContent>
            {s.recentRuns.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No runs yet — hit “Simulate lead”.
              </p>
            ) : (
              <ul className="divide-y">
                {s.recentRuns.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/leads/${r.leadId}`}
                      className="flex items-center gap-3 rounded-md px-1 py-2 text-sm hover:bg-muted/40"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{r.leadName}</span>
                      <RunStatusPill status={r.status as AgentRun["status"]} />
                      <span className="hidden text-xs text-muted-foreground sm:inline">
                        {r.trigger}
                      </span>
                      <span className="w-16 text-right font-mono text-xs tabular-nums">
                        {formatUsd(r.costUsd, { precise: true })}
                      </span>
                      <span className="hidden w-24 text-right text-xs text-muted-foreground md:inline">
                        {formatDistanceToNowStrict(new Date(r.startedAt), { addSuffix: true })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
