import { formatDistanceToNowStrict } from "date-fns";
import { and, desc, eq, ne } from "drizzle-orm";
import { CheckCheckIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createElement } from "react";
import { ApprovalActions } from "@/components/approvals/approval-card";
import { PageHeader } from "@/components/layout/page-header";
import { TOOL_META } from "@/components/trace/describe";
import { cn } from "@/lib/utils";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { approvals, leads } from "@/server/db/schema";
import { redactDeep } from "@/server/security/redact";
import { currentWorkspaceId } from "@/server/workspace";

export const metadata: Metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

const DECIDED_STYLE: Record<string, string> = {
  executed: "text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  rejected: "text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  failed: "text-red-700 dark:text-red-300 border-red-500/30",
  approved: "text-sky-700 dark:text-sky-300 border-sky-500/30",
};

export default async function ApprovalsPage() {
  const viewer = await getViewer();
  const db = getDb();
  const ws = currentWorkspaceId();
  const select = {
    approval: approvals,
    leadName: leads.name,
    company: leads.company,
    riskFlags: leads.riskFlags,
  };
  const [pending, decided] = await Promise.all([
    db
      .select(select)
      .from(approvals)
      .innerJoin(leads, eq(leads.id, approvals.leadId))
      .where(and(eq(approvals.workspaceId, ws), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt)),
    db
      .select(select)
      .from(approvals)
      .innerJoin(leads, eq(leads.id, approvals.leadId))
      .where(and(eq(approvals.workspaceId, ws), ne(approvals.status, "pending")))
      .orderBy(desc(approvals.decidedAt))
      .limit(20),
  ]);
  const safe = (p: Record<string, unknown>) => (viewer.isAdmin ? p : redactDeep(p));

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Outward actions held for a human — when “Require approval” is on, and always for flagged leads."
      />
      {pending.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <CheckCheckIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">Nothing waiting for approval</p>
          <p className="text-sm text-muted-foreground">
            Held bookings and emails will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {pending.map(({ approval: a, leadName, company, riskFlags }) => (
            <li key={a.id} className="rounded-xl border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {createElement(TOOL_META[a.action]?.icon ?? CheckCheckIcon, {
                  className: "size-4 text-amber-600",
                })}
                <span className="font-medium">{TOOL_META[a.action]?.label ?? a.action}</span>
                <span className="text-sm text-muted-foreground">
                  for{" "}
                  <Link href={`/leads/${a.leadId}`} className="text-foreground hover:underline">
                    {leadName ?? "lead"}
                    {company ? ` (${company})` : ""}
                  </Link>
                </span>
                {riskFlags.includes("prompt_injection") ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/40 px-2 py-0.5 text-xs text-orange-700 dark:text-orange-300">
                    <TriangleAlertIcon className="size-3" /> flagged lead
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatDistanceToNowStrict(a.createdAt, { addSuffix: true })}
                </span>
              </div>
              <ApprovalActions
                id={a.id}
                leadId={a.leadId}
                payload={safe(a.payload)}
                isAdmin={viewer.isAdmin}
              />
            </li>
          ))}
        </ul>
      )}

      {decided.length ? (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Recent decisions</h2>
          <ul className="divide-y rounded-xl border bg-card">
            {decided.map(({ approval: a, leadName }) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs capitalize",
                    DECIDED_STYLE[a.status],
                  )}
                >
                  {a.status}
                </span>
                <span className="font-medium">{TOOL_META[a.action]?.label ?? a.action}</span>
                <Link href={`/leads/${a.leadId}`} className="text-muted-foreground hover:underline">
                  {leadName ?? "lead"}
                </Link>
                <span className="ml-auto text-xs text-muted-foreground">
                  {a.decidedAt ? formatDistanceToNowStrict(a.decidedAt, { addSuffix: true }) : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
