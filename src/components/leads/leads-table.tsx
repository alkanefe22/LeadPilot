import { formatDistanceToNowStrict } from "date-fns";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LeadListRow } from "@/server/services/leads";
import { isInjectionFlagged, RiskFlagBadge } from "./risk-flag";
import { SourceLabel } from "./source-icon";
import { ScorePill, StatusBadge } from "./status-badge";

export function LeadsTable({ rows }: { rows: LeadListRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed py-16 text-center">
        <p className="font-medium">No leads match these filters</p>
        <p className="text-sm text-muted-foreground">Try clearing the search or status filter.</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Lead</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden sm:table-cell">Score</TableHead>
            <TableHead className="hidden lg:table-cell">Message</TableHead>
            <TableHead className="hidden md:table-cell">Source</TableHead>
            <TableHead className="hidden pr-4 text-right sm:table-cell">Received</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((l) => (
            <TableRow key={l.id} className="relative cursor-pointer">
              <TableCell className="max-w-[220px] pl-4">
                {/* The ::after overlay makes the whole row clickable while staying a real link. */}
                <Link href={`/leads/${l.id}`} className="after:absolute after:inset-0">
                  <div className="truncate font-medium">
                    {l.name ?? l.email ?? "Unknown sender"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {l.company ?? l.email ?? "—"}
                  </div>
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={l.status} />
                  {isInjectionFlagged(l.riskFlags) ? (
                    <RiskFlagBadge matches={l.riskMatches} />
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <ScorePill score={l.score} />
              </TableCell>
              <TableCell className="hidden max-w-[360px] lg:table-cell">
                <p className="truncate text-sm text-muted-foreground">{l.message}</p>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <SourceLabel source={l.source} />
              </TableCell>
              <TableCell className="hidden pr-4 text-right text-xs whitespace-nowrap text-muted-foreground sm:table-cell">
                {formatDistanceToNowStrict(l.createdAt, { addSuffix: true })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
