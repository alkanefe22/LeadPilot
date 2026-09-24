"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Tiny dependency-free JSON syntax highlighter (keys, strings, numbers, literals). */
function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of json.matchAll(TOKEN)) {
    if (m.index > last) out.push(json.slice(last, m.index));
    const [full, str, colon, literal, num] = m;
    if (str && colon) {
      out.push(
        <span key={i++} className="text-sky-700 dark:text-sky-300">
          {str}
        </span>,
        colon,
      );
    } else if (str) {
      out.push(
        <span key={i++} className="text-emerald-700 dark:text-emerald-300">
          {str}
        </span>,
      );
    } else if (literal) {
      out.push(
        <span key={i++} className="text-violet-700 dark:text-violet-300">
          {literal}
        </span>,
      );
    } else if (num) {
      out.push(
        <span key={i++} className="text-amber-700 dark:text-amber-300">
          {num}
        </span>,
      );
    } else {
      out.push(full);
    }
    last = m.index + full.length;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
      aria-label="Copy to clipboard"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function JsonView({
  label,
  value,
  maxHeight = "20rem",
}: {
  label: string;
  value: unknown;
  maxHeight?: string;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between border-b px-3 py-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <CopyButton text={text} />
      </div>
      <pre
        className="overflow-auto p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
        style={{ maxHeight }}
      >
        {typeof value === "string" ? text : highlight(text)}
      </pre>
    </div>
  );
}
