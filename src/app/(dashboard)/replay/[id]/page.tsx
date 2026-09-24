import { ArrowLeftIcon, BuildingIcon, MailIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ScorePill, StatusBadge } from "@/components/leads/status-badge";
import { ReplayPanel } from "@/components/trace/replay-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LeadStatus } from "@/server/db/schema";
import { getViewer } from "@/server/auth";
import { getRecording } from "@/server/demo/recordings";
import { redactDeep } from "@/server/security/redact";

export const metadata: Metadata = { title: "Replay" };

/** Public demo: a recorded real run played back in the trace timeline (no model calls). */
export default async function ReplayPage({ params }: PageProps<"/replay/[id]">) {
  const { id } = await params;
  const viewer = await getViewer();
  const found = getRecording(id);
  if (!found) notFound();
  const rec = viewer.isAdmin ? found : redactDeep(found);
  const q = rec.outcome.qualification as { reasoning?: string } | null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> Leads
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {rec.lead.name ?? rec.lead.email ?? "Unknown sender"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A simulated lead handled by the agent in a recorded run. Public visitors watch replays
            of real runs, so this demo costs nothing and makes no model calls.
          </p>
        </div>
      </div>

      <ReplayPanel
        recording={rec}
        lead={
          <Card size="sm">
            <CardHeader>
              <CardTitle>Lead</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                <MailIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{rec.lead.email ?? "—"}</span>
              </p>
              <p className="flex items-center gap-2">
                <BuildingIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{rec.lead.company ?? "—"}</span>
              </p>
              <p className="rounded-lg border bg-muted/40 p-3 break-words whitespace-pre-wrap">
                {rec.lead.message}
              </p>
            </CardContent>
          </Card>
        }
        outcome={
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Outcome <ScorePill score={rec.outcome.score} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <StatusBadge status={rec.outcome.status as LeadStatus} />
              {q?.reasoning ? <p className="text-muted-foreground">{q.reasoning}</p> : null}
              <p className="text-xs text-muted-foreground">Recorded with {rec.provider}.</p>
            </CardContent>
          </Card>
        }
      />
    </div>
  );
}
