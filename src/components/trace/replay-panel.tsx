"use client";

import { format } from "date-fns";
import { FilmIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { replayRun, replaySchedule, type Recording } from "@/lib/replay";
import { TraceTimeline } from "./trace-panel";

const WAIT_CAP_MS = 3000;

/**
 * Plays back a recorded real run step by step with its original relative timing (each wait
 * capped at 3s). Purely client-side: nothing here talks to a model or the database.
 */
export function ReplayPanel({
  recording,
  lead,
  outcome,
}: {
  recording: Recording;
  /** Sidebar card with the inbound lead (shown from the start). */
  lead: ReactNode;
  /** Sidebar card with the result — revealed only when the replay reaches the end. */
  outcome: ReactNode;
}) {
  const [revealed, setRevealed] = useState(0);
  const [round, setRound] = useState(0);
  const schedule = useMemo(() => replaySchedule(recording.steps, WAIT_CAP_MS), [recording]);

  useEffect(() => {
    const timers = schedule.map((at, i) => setTimeout(() => setRevealed(i + 1), at + 400));
    return () => timers.forEach(clearTimeout);
  }, [schedule, round]);

  const { run, steps } = replayRun(recording, revealed);
  const done = revealed >= recording.steps.length;
  const recordedOn = format(new Date(recording.recordedAt), "d MMM yyyy");

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Agent trace (replay)" className="min-w-0 space-y-3">
        <TraceTimeline
          runs={[run]}
          run={run}
          steps={steps}
          approvals={{}}
          durationMs={run.latencyMs}
          durationHint={done ? "original run" : "original timing (waits ≤ 3s)"}
          badge={
            <span
              className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300"
              title={`Recorded with ${recording.provider}. Public visitors watch recorded runs — no model calls are made.`}
            >
              <FilmIcon className="size-3" />
              Replay of a real run · model {recording.run.model} · {recordedOn}
            </span>
          }
        />
        {done ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRevealed(0);
                setRound((r) => r + 1);
              }}
            >
              <RotateCcwIcon data-icon="inline-start" />
              Replay again
            </Button>
          </div>
        ) : null}
      </section>
      <aside className="space-y-4">
        {lead}
        {done ? outcome : null}
      </aside>
    </div>
  );
}
