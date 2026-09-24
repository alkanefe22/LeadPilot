import { formatDistanceToNowStrict } from "date-fns";
import { and, desc, eq } from "drizzle-orm";
import { CheckCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { TOOL_META } from "@/components/trace/describe";
import { JsonView } from "@/components/trace/json-view";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { approvals, leads } from "@/server/db/schema";
import { redactDeep } from "@/server/security/redact";
import { currentWorkspaceId } from "@/server/workspace";

export const metadata: Metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const viewer = await getViewer();
  const rows = await getDb()
    .select({ approval: approvals, leadName: leads.name, company: leads.company })
    .from(approvals)
    .innerJoin(leads, eq(leads.id, approvals.leadId))
    .where(and(eq(approvals.workspaceId, currentWorkspaceId()), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt));

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Outward actions held for a human: enabled by “Require approval” in Settings, and always for flagged leads."
      />
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
          <CheckCheckIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">Nothing waiting for approval</p>
          <p className="text-sm text-muted-foreground">
            Held bookings and emails will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ approval: a, leadName, company }) => {
            const Icon = TOOL_META[a.action]?.icon ?? CheckCheckIcon;
            return (
              <li key={a.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon className="size-4 text-amber-600" />
                  <span className="font-medium">{TOOL_META[a.action]?.label ?? a.action}</span>
                  <span className="text-sm text-muted-foreground">
                    for{" "}
                    <Link href={`/leads/${a.leadId}`} className="text-foreground hover:underline">
                      {leadName ?? "lead"}
                      {company ? ` (${company})` : ""}
                    </Link>
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDistanceToNowStrict(a.createdAt, { addSuffix: true })}
                  </span>
                </div>
                <div className="mt-3">
                  <JsonView
                    label="Proposed action"
                    value={viewer.isAdmin ? a.payload : redactDeep(a.payload)}
                    maxHeight="14rem"
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Approve / edit / reject controls arrive in the next milestone (M4).
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
