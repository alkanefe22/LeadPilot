import { formatDistanceToNowStrict } from "date-fns";
import { desc, eq } from "drizzle-orm";
import { InboxIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";
import { getViewer } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { emails, leads } from "@/server/db/schema";
import { maskEmail, maskText } from "@/server/security/redact";
import { currentWorkspaceId } from "@/server/workspace";

export const metadata: Metadata = { title: "Outbox" };
export const dynamic = "force-dynamic";

const KIND_STYLE: Record<string, string> = {
  confirmation: "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
  followup: "border-amber-500/30 text-amber-700 dark:text-amber-300",
  rejection: "border-zinc-500/30 text-zinc-600 dark:text-zinc-400",
};

export default async function OutboxPage() {
  const viewer = await getViewer();
  const redact = !viewer.isAdmin;
  const rows = await getDb()
    .select({ email: emails, leadName: leads.name })
    .from(emails)
    .leftJoin(leads, eq(leads.id, emails.leadId))
    .where(eq(emails.workspaceId, currentWorkspaceId()))
    .orderBy(desc(emails.createdAt))
    .limit(100);

  return (
    <>
      <PageHeader
        title="Outbox"
        description="Every email the agent sent. With the console adapter nothing leaves the server — this is the demo inbox."
      />
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
          <InboxIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">No emails yet</p>
          <p className="text-sm text-muted-foreground">
            Follow-ups, confirmations and polite declines will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ email: e, leadName }) => (
            <li key={e.id}>
              <details className="group rounded-xl border bg-card open:shadow-sm">
                <summary className="flex cursor-pointer list-none flex-col gap-1 p-4 sm:flex-row sm:items-center sm:gap-3 [&::-webkit-details-marker]:hidden">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-xs capitalize",
                        KIND_STYLE[e.kind] ?? "border-border",
                      )}
                    >
                      {e.kind}
                    </span>
                    <span className="truncate font-medium">{e.subject}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="truncate">
                      to {leadName ?? (redact ? maskEmail(e.to) : e.to)}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5",
                        e.status === "failed" ? "bg-red-500/10 text-red-600" : "bg-muted",
                      )}
                    >
                      {e.status} · {e.provider}
                    </span>
                    <time dateTime={e.createdAt.toISOString()}>
                      {formatDistanceToNowStrict(e.createdAt, { addSuffix: true })}
                    </time>
                  </div>
                </summary>
                <div className="space-y-3 border-t px-4 py-3 text-sm">
                  <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <dt>From</dt>
                    <dd className="truncate">{e.from}</dd>
                    <dt>To</dt>
                    <dd className="truncate">{redact ? maskEmail(e.to) : e.to}</dd>
                    {e.replyTo ? (
                      <>
                        <dt>Reply-To</dt>
                        <dd className="truncate font-mono">
                          {redact ? maskEmail(e.replyTo) : e.replyTo}
                        </dd>
                      </>
                    ) : null}
                    <dt>Message-ID</dt>
                    <dd className="truncate font-mono">{e.messageIdHeader}</dd>
                  </dl>
                  <p className="break-words whitespace-pre-wrap">
                    {redact ? maskText(e.bodyText) : e.bodyText}
                  </p>
                  {e.error ? <p className="text-xs text-red-600">{e.error}</p> : null}
                  {e.leadId ? (
                    <Link
                      href={`/leads/${e.leadId}`}
                      className="inline-block text-xs text-primary hover:underline"
                    >
                      Open lead & trace →
                    </Link>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
