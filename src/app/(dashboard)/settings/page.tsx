import { CheckCircle2Icon, CircleDashedIcon, KeyRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { env, isLlmConfigured } from "@/lib/env";
import { formatUsd } from "@/lib/format";
import { selectAdapters } from "@/server/adapters";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { getDemoBudget } from "@/server/services/demo-budget";
import { currentWorkspaceId, getWorkspace } from "@/server/workspace";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const KIND_LABEL = { calendar: "Calendar", crm: "CRM", email: "Email" } as const;

export default async function SettingsPage() {
  const [viewer, ws] = await Promise.all([getViewer(), getWorkspace()]);
  if (!ws) notFound();
  const e = env();
  const { status } = selectAdapters(e);
  const budget = await getDemoBudget(getDb(), {
    workspaceId: currentWorkspaceId(),
    runLimit: e.DEMO_DAILY_RUN_LIMIT,
    costLimit: e.DEMO_DAILY_COST_LIMIT_USD,
    videoUrl: e.DEMO_VIDEO_URL,
  });
  const model =
    e.DEV_FAKE_LLM && e.NODE_ENV !== "production"
      ? "dev-fake-llm (DEV_FAKE_LLM)"
      : (e.ANTHROPIC_MODEL ?? "not set");

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
            meetingDurationMin: ws.meetingDurationMin,
            timezone: ws.timezone,
            senderName: ws.senderName,
          }}
        />
        <aside className="space-y-4">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Integrations</CardTitle>
              <CardDescription>
                Selected from env vars; missing keys fall back to mocks.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <StatusRow label="LLM" value={model} ok={isLlmConfigured(e)} />
              {status.map((s) => (
                <div key={s.kind}>
                  <StatusRow
                    label={KIND_LABEL[s.kind]}
                    value={`${s.active}${s.requested !== "auto" ? ` (requested: ${s.requested})` : ""}`}
                    ok={!s.note}
                  />
                  {s.note ? (
                    <p className="mt-1 pl-6 text-xs text-muted-foreground">{s.note}</p>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Public demo budget</CardTitle>
              <CardDescription>Simulated runs by visitors, resets 00:00 UTC.</CardDescription>
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
                HMAC secret for POST /api/inbound/webhook (docs & embed snippet in M4).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <code className="block truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                {viewer.isAdmin ? ws.webhookSecret : `${ws.webhookSecret.slice(0, 8)}••••••••••••`}
              </code>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  const Icon = ok ? CheckCircle2Icon : CircleDashedIcon;
  return (
    <div className="flex items-center gap-2">
      <Icon className={ok ? "size-4 text-emerald-500" : "size-4 text-amber-500"} />
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
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
