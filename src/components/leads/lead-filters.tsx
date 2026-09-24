"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { STATUS_META } from "./status-badge";

const SOURCE_ITEMS = [
  { value: "all", label: "All sources" },
  { value: "form", label: "Form" },
  { value: "email", label: "Email" },
  { value: "webhook", label: "Webhook" },
  { value: "simulated", label: "Simulated" },
  { value: "seed", label: "Seed" },
];

export function LeadFilters({ counts }: { counts: Partial<Record<string, number>> }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(params.get("q") ?? "");
  const status = params.get("status") ?? "";
  const source = params.get("source") ?? "all";

  function update(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === "all") sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  // Debounced search → URL (the server component re-queries).
  useEffect(() => {
    if (q === (params.get("q") ?? "")) return;
    const t = setTimeout(() => update({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const total = Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
  const tabs = [{ value: "", label: "All", n: total }].concat(
    Object.entries(STATUS_META).map(([value, m]) => ({
      value,
      label: m.label,
      n: counts[value] ?? 0,
    })),
  );

  return (
    <div className={cn("flex flex-col gap-3", pending && "opacity-70 transition-opacity")}>
      <div
        className="-mx-1 flex [scrollbar-width:none] gap-1 overflow-x-auto px-1 pb-1"
        role="tablist"
      >
        {tabs.map((t) => (
          <button
            key={t.value || "all"}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            onClick={() => update({ status: t.value })}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
              status === t.value
                ? "border-primary bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
            <span className="font-mono tabular-nums opacity-70">{t.n}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, company or message…"
            className="pl-8"
            aria-label="Search leads"
          />
          {q ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-1/2 right-1.5 -translate-y-1/2"
              onClick={() => setQ("")}
              aria-label="Clear search"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
        <Select
          items={SOURCE_ITEMS}
          value={source}
          onValueChange={(v) => update({ source: String(v ?? "all") })}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Filter by source">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_ITEMS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
