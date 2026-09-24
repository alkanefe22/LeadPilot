import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { STATUS_META } from "@/components/leads/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeadStatus } from "@/server/db/schema";
import { leadStatusCounts } from "@/server/services/leads";
import { currentWorkspaceId } from "@/server/workspace";

export default async function OverviewPage() {
  const counts = await leadStatusCounts(currentWorkspaceId());
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Overview"
        description="How your AI lead agent is performing."
        actions={
          <Button render={<Link href="/leads" />} nativeButton={false}>
            View leads <ArrowRightIcon data-icon="inline-end" />
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Card className="col-span-2 lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Total leads</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-3xl font-semibold tabular-nums">
            {total}
          </CardContent>
        </Card>
        {(Object.keys(STATUS_META) as LeadStatus[]).map((s) => (
          <Card key={s}>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {STATUS_META[s].label}
              </CardTitle>
            </CardHeader>
            <CardContent className="font-mono text-3xl font-semibold tabular-nums">
              {counts[s] ?? 0}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
