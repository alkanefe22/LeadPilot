"use client";

import { ChevronRightIcon, CircleAlertIcon, CirclePauseIcon } from "lucide-react";
import { createElement, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration, formatTokens, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TraceStep } from "@/server/services/trace";
import { describeStep, stepIcon, stepTitle } from "./describe";
import { JsonView } from "./json-view";

const TONE = {
  llm: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  error: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300",
  pending_approval: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
} as const;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">
      <span className="sr-only">{label}</span>
      {value}
    </span>
  );
}

export function StepItem({
  step,
  model,
  maxLatency,
  isLast,
}: {
  step: TraceStep;
  model: string;
  maxLatency: number;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tone = step.type === "llm" ? TONE.llm : TONE[step.status];
  const out = (step.output ?? {}) as { cache_read_tokens?: number; stop_reason?: string };
  const firstPrompt =
    step.type === "llm" && step.idx === 0
      ? (step.input as { system?: string; user?: string } | null)
      : null;

  return (
    <li className="relative flex gap-3 pb-1">
      {/* rail */}
      {!isLast ? (
        <span aria-hidden className="absolute top-9 bottom-0 left-[17px] w-px bg-border" />
      ) : null}
      <span
        className={cn(
          "relative z-10 mt-1 flex size-9 shrink-0 items-center justify-center rounded-full border",
          tone,
        )}
      >
        {createElement(stepIcon(step), { className: "size-4" })}
      </span>

      <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 flex-1">
        <CollapsibleTrigger className="group w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="text-sm font-medium">{stepTitle(step, model)}</span>
            {step.type === "tool" ? (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
                {step.toolName}
              </code>
            ) : null}
            {step.status === "error" ? (
              <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                <CircleAlertIcon className="size-3.5" /> error
              </span>
            ) : null}
            {step.status === "pending_approval" ? (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                <CirclePauseIcon className="size-3.5" /> awaiting approval
              </span>
            ) : null}
            <span className="ml-auto flex flex-wrap items-center gap-1">
              {step.type === "llm" ? (
                <>
                  <Metric label="Input tokens" value={`${formatTokens(step.inputTokens)} in`} />
                  <Metric label="Output tokens" value={`${formatTokens(step.outputTokens)} out`} />
                  <Metric label="Cost" value={formatUsd(step.costUsd, { precise: true })} />
                </>
              ) : null}
              <Metric label="Latency" value={formatDuration(step.latencyMs)} />
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 pl-5.5 text-sm text-muted-foreground">
            {step.type === "llm" && step.text ? (
              <span className="text-foreground/80 italic">“{step.text}” </span>
            ) : null}
            {describeStep(step)}
          </p>
          <div className="mt-1.5 ml-5.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className={cn(
                "h-full rounded-full",
                step.type === "llm" ? "bg-violet-500/60" : "bg-emerald-500/60",
              )}
              style={{ width: `${Math.max(2, (step.latencyMs / Math.max(maxLatency, 1)) * 100)}%` }}
            />
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-3 px-2 pt-2 pb-3">
          {step.type === "llm" ? (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  stop_reason: <code className="font-mono text-foreground">{out.stop_reason}</code>
                </span>
                <span>cache read: {formatTokens(out.cache_read_tokens ?? 0)} tokens</span>
              </div>
              {step.text ? <JsonView label="Assistant message" value={step.text} /> : null}
              {firstPrompt?.system ? (
                <div className="grid gap-3 xl:grid-cols-2">
                  <JsonView
                    label="System prompt (cached)"
                    value={firstPrompt.system}
                    maxHeight="24rem"
                  />
                  <JsonView
                    label="Lead brief (user message)"
                    value={firstPrompt.user ?? ""}
                    maxHeight="24rem"
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              <JsonView label="Input" value={step.input} />
              <JsonView label="Output" value={step.output} />
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
