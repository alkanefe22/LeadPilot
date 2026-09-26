"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { Loader2Icon, PlugZapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { IntegrationView } from "@/server/services/integrations";

const KIND_LABEL = { calendar: "Calendar", crm: "CRM", email: "Email" } as const;
const NAME: Record<string, string> = {
  google: "Google Calendar",
  mock: "Demo calendar",
  hubspot: "HubSpot",
  internal: "Internal CRM",
  resend: "Resend",
  console: "Console outbox",
};

const BADGE = {
  ok: {
    label: "Connected",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failing: {
    label: "Error",
    className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  unknown: {
    label: "Not tested",
    className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  },
  builtin: {
    label: "Built-in",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
} as const;

type TestResult = { ok: boolean; detail?: string; error?: string };

function IntegrationRow({ i, isAdmin }: { i: IntegrationView; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const badge = BADGE[i.health];

  async function test() {
    setPending(true);
    setResult(null);
    const res = await fetch("/api/adapters/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: i.kind }),
    }).catch(() => null);
    const data = ((await res?.json().catch(() => null)) as TestResult | null) ?? {
      ok: false,
      error: "Network error",
    };
    setResult(data);
    setPending(false);
    router.refresh(); // pick up the updated health badge
  }

  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">{KIND_LABEL[i.kind]}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {NAME[i.active] ?? i.active}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            badge.className,
          )}
        >
          {badge.label}
        </span>
      </div>
      {i.note ? <p className="pl-18 text-xs text-muted-foreground">{i.note}</p> : null}
      {i.health === "failing" && i.lastError ? (
        <p
          role="alert"
          className="ml-18 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1 text-xs break-words text-red-700 dark:text-red-300"
        >
          {i.lastError}
          {i.lastErrorAt ? (
            <span className="block text-[11px] text-red-600/70 dark:text-red-300/70">
              {formatDistanceToNowStrict(new Date(i.lastErrorAt), { addSuffix: true })}
            </span>
          ) : null}
        </p>
      ) : null}
      {i.health === "ok" && i.lastOkAt ? (
        <p className="pl-18 text-[11px] text-muted-foreground">
          last success {formatDistanceToNowStrict(new Date(i.lastOkAt), { addSuffix: true })}
        </p>
      ) : null}
      <div className="flex items-center gap-2 pl-18">
        <Button
          size="xs"
          variant="outline"
          onClick={test}
          disabled={!isAdmin || pending}
          title={isAdmin ? undefined : "Admin login required"}
        >
          {pending ? (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          ) : (
            <PlugZapIcon data-icon="inline-start" />
          )}
          Test connection
        </Button>
        {result ? (
          <span
            role="status"
            className={cn(
              "min-w-0 truncate text-xs",
              result.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
            )}
          >
            {result.ok ? `OK — ${result.detail}` : result.error}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function IntegrationsCard({
  integrations,
  llm,
  isAdmin,
}: {
  integrations: IntegrationView[];
  llm: { label: string; ok: boolean; error?: string | null; badge?: string; note?: string };
  isAdmin: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Integrations</CardTitle>
        <CardDescription>
          Chosen from env vars. Real provider errors are shown here — never silently mocked.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-center gap-2 border-b pb-3">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">LLM</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{llm.label}</span>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
              llm.error
                ? BADGE.failing.className
                : llm.ok
                  ? BADGE.ok.className
                  : BADGE.unknown.className,
            )}
          >
            {llm.error ? "Error" : (llm.badge ?? (llm.ok ? "Configured" : "Missing"))}
          </span>
        </div>
        {llm.note ? <p className="-mt-2 mb-3 text-xs text-muted-foreground">{llm.note}</p> : null}
        {llm.error ? (
          <p
            role="alert"
            className="-mt-2 mb-3 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1 text-xs break-words text-red-700 dark:text-red-300"
          >
            {llm.error}
          </p>
        ) : null}
        <ul className="divide-y">
          {integrations.map((i) => (
            <IntegrationRow key={i.kind} i={i} isAdmin={isAdmin} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
