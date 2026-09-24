import { cn } from "@/lib/utils";
import type { LeadStatus } from "@/server/db/schema";

export const STATUS_META: Record<LeadStatus, { label: string; className: string; dot: string }> = {
  new: {
    label: "New",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  needs_info: {
    label: "Needs info",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  qualified: {
    label: "Qualified",
    className: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  booked: {
    label: "Booked",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  disqualified: {
    label: "Disqualified",
    className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
    dot: "bg-zinc-400",
  },
};

export function StatusBadge({ status, className }: { status: LeadStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        meta.className,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-muted-foreground">—</span>;
  const tone =
    score >= 70
      ? "text-emerald-600 dark:text-emerald-400"
      : score >= 40
        ? "text-amber-600 dark:text-amber-400"
        : "text-zinc-500";
  return (
    <div className={cn("flex items-center gap-2", tone)}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-current" style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums">{score}</span>
    </div>
  );
}
