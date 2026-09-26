import { KeyRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { IntegrationsCard } from "@/components/settings/integrations-card";
import { SettingsForm } from "@/components/settings/settings-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { demoMode, env, isLlmConfigured, llmLabel } from "@/lib/env";
import { formatUsd } from "@/lib/format";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { loadRecordings } from "@/server/demo/recordings";
import { getDemoBudget } from "@/server/services/demo-budget";
import { getIntegrations, getLlmHealth } from "@/server/services/integrations";
import { currentWorkspaceId, getWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [viewer, ws] = await Promise.all([getViewer(), getWorkspace()]);
  if (!ws) notFound();
  const e = env();
  const integrations = await getIntegrations();
  const budget = await getDemoBudget(getDb(), {
    workspaceId: currentWorkspaceId(),
    runLimit: e.DEMO_DAILY_RUN_LIMIT,
    costLimit: e.DEMO_DAILY_COST_LIMIT_USD,
    videoUrl: e.DEMO_VIDEO_URL,
  });
  const model = llmLabel(e);
  const llmHealth = await getLlmHealth();
  // A public demo in replay mode needs no model at all: say so instead of showing "Missing".
  const replay = e.PUBLIC_DEMO && demoMode(e) === "replay";
  const recordedModels = [...new Set(loadRecordings().map((r) => r.run.model))];
  const llm =
    replay && !isLlmConfigured(e)
      ? {
          label: `replay of recorded runs${recordedModels.length ? ` (${recordedModels.join(", ")})` : ""}`,
          ok: true,
          badge: "Replay",
          note: "Public visitors watch recorded real runs, so no model is called on this deployment.",
        }
      : { label: model, ok: isLlmConfigured(e), error: llmHealth };

  return (
    <>
      <PageHeader
        title="Settings"
        description={`${ws.name} · everything the agent's system prompt is built from`}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <SettingsForm
          isAdmin={viewer.isAdmin}
          initial={{
            icpText: ws.icpText,
            qualificationRules: ws.qualificationRules,
            scoreThreshold: ws.scoreThreshold,
            requireApproval: ws.requireApproval,
            requireBudgetTimelineToBook: ws.requireBudgetTimelineToBook,
            meetingDurationMin: ws.meetingDurationMin,
            timezone: ws.timezone,
            senderName: ws.senderName,
          }}
        />
        <aside className="space-y-4">
          <IntegrationsCard integrations={integrations} llm={llm} isAdmin={viewer.isAdmin} />
          <Card size="sm">
            <CardHeader>
              <CardTitle>Public demo budget</CardTitle>
              <CardDescription>
                {replay
                  ? "Replay mode: visitors watch recorded runs, which cost nothing. This budget only applies to live runs (DEMO_MODE=live)."
                  : "Simulated runs by visitors, resets 00:00 UTC."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Meter
                label="Runs today"
                value={budget.runsToday}
                max={budget.runLimit}
                format={String}
              />
              <Meter
                label="Spend today"
                value={budget.costToday}
                max={budget.costLimit}
                format={(n) => formatUsd(n)}
              />
              {budget.limitReached ? (
                <p className="text-xs text-amber-600">
                  Limit reached — visitors see the video link instead.
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRoundIcon className="size-4" /> Webhook secret
              </CardTitle>
              <CardDescription>
                For n8n / Zapier / Make — see examples/curl-webhook.sh.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="space-y-1">
                <p className="text-muted-foreground">Endpoint</p>
                <code className="block rounded-md bg-muted px-2 py-1.5 font-mono break-all">
                  POST {e.APP_URL}/api/inbound/webhook?workspace={ws.id}
                </code>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Secret</p>
                <code className="block truncate rounded-md bg-muted px-2 py-1.5 font-mono">
                  {viewer.isAdmin
                    ? ws.webhookSecret
                    : `${ws.webhookSecret.slice(0, 8)}••••••••••••`}
                </code>
              </div>
              <p className="text-muted-foreground">
                Headers: <code className="font-mono">X-LeadPilot-Timestamp</code> (unix seconds) and{" "}
                <code className="font-mono">
                  X-LeadPilot-Signature: sha256=HMAC(secret, &quot;ts.body&quot;)
                </code>
                . Responds 202 with the lead id; retries with the same{" "}
                <code className="font-mono">external_id</code> (or identical body) are deduplicated.
              </p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Embeddable form</CardTitle>
              <CardDescription>
                Public page:{" "}
                <a
                  href={`/f/${ws.id}`}
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  /f/{ws.id}
                </a>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">
                {`<div data-leadpilot-form="${ws.id}"></div>\n<script src="${e.APP_URL}/embed.js" async></script>`}
              </pre>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Meter({
  label,
  value,
  max,
  format,
}: {
  label: string;
  value: number;
  max: number;
  format: (n: number) => string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">
          {format(value)} / {format(max)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-chart-1" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
