import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { LeadFilters } from "@/components/leads/lead-filters";
import { LeadsTable } from "@/components/leads/leads-table";
import { leadStatusCounts, listLeads } from "@/server/services/leads";
import { currentWorkspaceId } from "@/server/workspace";

export const metadata: Metadata = { title: "Leads" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const sp = await searchParams;
  const workspaceId = currentWorkspaceId();
  const [{ rows, total }, counts] = await Promise.all([
    listLeads({
      workspaceId,
      q: first(sp.q),
      status: first(sp.status),
      source: first(sp.source),
      limit: 100,
    }),
    leadStatusCounts(workspaceId),
  ]);

  return (
    <>
      <PageHeader
        title="Leads"
        description={`${total} lead${total === 1 ? "" : "s"} · every inbound request the agent has seen`}
      />
      <div className="flex flex-col gap-4">
        <Suspense>
          <LeadFilters counts={counts} />
        </Suspense>
        <LeadsTable rows={rows} />
      </div>
    </>
  );
}
