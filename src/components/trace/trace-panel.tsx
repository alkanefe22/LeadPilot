"use client";

import { formatDistanceToNowStrict } from "date-fns";
import {
  ActivityIcon,
  BotIcon,
  CircleAlertIcon,
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  Loader2Icon,
  ListTreeIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, formatTokens, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LeadTrace, RunSummary } from "@/server/services/trace";
import { StepItem } from "./step-item";

const RUN_STATUS: Record<RunSummary["status"], { label: string; className: string }> = {
  running: {
    label: "Running",
    className: "bg-sky-500/10 text-sky-700 border-sky-500/30 dark:text-sky-300",
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    className: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300",
  },
  max_steps: {
    label: "Step limit",
    className: "bg-orange-500/10 text-orange-700 border-orange-500/30 dark:text-orange-300",
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/10 text-red-700 border-red-500/30 dark:text-red-300",
  },
};

export function RunStatusPill({ status }: { status: RunSummary["status"] }) {
  const s = RUN_STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        s.className,
      )}
    >
      {status === "running" ? <Loader2Icon className="size-3 animate-spin" /> : null}
      {s.label}
    </span>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof CoinsIcon;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-background/60 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="truncate text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** Ticks while a run is in flight so the duration counter feels live. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function TracePanel({ leadId, initial }: { leadId: string; initial: LeadTrace }) {
  const router = useRouter();
  const [trace, setTrace] = useState(initial);
  const [selected, setSelected] = useState<string | null>(initial.selectedRunId);
  const run = trace.runs.find((r) => r.id === selected) ?? trace.runs[0] ?? null;
  const running = run?.status === "running";
  const wasRunning = useRef(running);
  const now = useNow(running);

  // Poll while the selected run is in flight; refresh server data when it lands.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const tick = async () => {
      const res = await fetch(`/api/leads/${leadId}/trace${selected ? `?run=${selected}` : ""}`, {
        cache: "no-store",
      }).catch(() => null);
      if (!cancelled && res?.ok) setTrace((await res.json()) as LeadTrace);
    };
    const t = setInterval(tick, 1000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [leadId, selected, running]);

  useEffect(() => {
    if (wasRunning.current && !running) router.refresh();
    wasRunning.current = running;
  }, [running, router]);

  async function selectRun(id: string) {
    setSelected(id);
    const res = await fetch(`/api/leads/${leadId}/trace?run=${id}`, { cache: "no-store" }).catch(
      () => null,
    );
    if (res?.ok) setTrace((await res.json()) as LeadTrace);
  }

  const steps = useMemo(
    () => (trace.selectedRunId === run?.id ? trace.steps : []),
    [trace.selectedRunId, trace.steps, run?.id],
  );
  const maxLatency = useMemo(() => Math.max(1, ...steps.map((s) => s.latencyMs)), [steps]);
  const llmSteps = steps.filter((s) => s.type === "llm").length;
  const toolSteps = steps.length - llmSteps;

  if (!run) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
        <ListTreeIcon className="size-8 text-muted-foreground" />
        <p className="font-medium">No agent runs yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Run the agent on this lead to see every model call and tool call it makes, with tokens,
          cost and latency.
        </p>
      </div>
    );
  }

  const duration = running ? now - new Date(run.startedAt).getTime() : run.latencyMs;

  return (
    <div className="space-y-4">
      {trace.runs.length > 1 ? (
        <div
          className="-mx-1 flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-1 pb-1"
          role="tablist"
          aria-label="Agent runs"
        >
          {trace.runs.map((r, i) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={r.id === run.id}
              onClick={() => selectRun(r.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
                r.id === run.id ? "border-primary bg-primary/5" : "hover:bg-muted",
              )}
            >
              <span className="font-medium">Run {trace.runs.length - i}</span>
              <span className="text-muted-foreground">{r.trigger}</span>
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  r.status === "completed"
                    ? "bg-emerald-500"
                    : r.status === "running"
                      ? "bg-sky-500"
                      : r.status === "awaiting_approval"
                        ? "bg-amber-500"
                        : "bg-red-500",
                )}
              />
              <span className="font-mono text-muted-foreground tabular-nums">
                {formatUsd(r.costUsd)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Run summary header */}
      <div className="rounded-xl border bg-gradient-to-b from-primary/5 to-transparent p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">Agent trace</h3>
          <RunStatusPill status={run.status} />
          <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {run.model}
          </span>
          <span className="text-xs text-muted-foreground">
            {run.trigger} · started{" "}
            {formatDistanceToNowStrict(new Date(run.startedAt), { addSuffix: true })}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            icon={CoinsIcon}
            label={run.billingTier === "free" ? "Est. cost (paid rates)" : "Total cost"}
            value={formatUsd(run.costUsd, { precise: true })}
            hint={
              run.billingTier === "free"
                ? "free tier — $0 actually billed"
                : run.billingTier === "local"
                  ? "local model — nothing billed"
                  : "estimated from token usage"
            }
          />
          <Stat
            icon={ClockIcon}
            label="Total time"
            value={formatDuration(duration)}
            hint={running ? "live" : "wall clock"}
          />
          <Stat
            icon={CpuIcon}
            label="Tokens"
            value={`${formatTokens(run.inputTokens)} / ${formatTokens(run.outputTokens)}`}
            hint="input / output"
          />
          <Stat
            icon={ActivityIcon}
            label="Steps"
            value={String(steps.length)}
            hint={`${llmSteps} model · ${toolSteps} tool`}
          />
        </div>
        {run.error ? (
          <div
            role="alert"
            className="mt-3 flex gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>{run.error}</span>
          </div>
        ) : null}
        {run.summary && !running ? (
          <div className="mt-3 flex gap-2 rounded-lg bg-background/70 p-3 text-sm">
            <BotIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="text-pretty">{run.summary}</p>
          </div>
        ) : null}
      </div>

      {/* Timeline */}
      <ol className="space-y-1" aria-label="Agent steps" aria-live={running ? "polite" : undefined}>
        {steps.map((s, i) => (
          <StepItem
            key={s.id}
            step={s}
            model={run.model}
            maxLatency={maxLatency}
            freeTier={run.billingTier === "free"}
            isLast={i === steps.length - 1 && !running}
            approvals={trace.approvals}
          />
        ))}
        {running ? (
          <li className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-primary/50 text-primary">
              <Loader2Icon className="size-4 animate-spin" />
            </span>
            <span className="animate-pulse text-sm text-muted-foreground">
              {steps.at(-1)?.type === "llm" ? "Running tools…" : "Agent is thinking…"}
            </span>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
