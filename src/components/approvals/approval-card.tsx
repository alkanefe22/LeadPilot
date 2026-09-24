"use client";

import { CheckIcon, Loader2Icon, PencilIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { JsonView } from "@/components/trace/json-view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  id: string;
  leadId: string;
  payload: Record<string, unknown>;
  isAdmin: boolean;
};

export function ApprovalActions({ id, leadId, payload, isAdmin }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(payload, null, 2));
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  async function decide(decision: "approve" | "reject") {
    setIssues([]);
    let edited: unknown;
    if (decision === "approve" && editing) {
      try {
        edited = JSON.parse(draft);
      } catch {
        setIssues(["Payload is not valid JSON."]);
        return;
      }
    }
    setPending(decision);
    const res = await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision,
        ...(edited !== undefined ? { payload: edited } : {}),
        ...(note.trim() ? { note } : {}),
      }),
    }).catch(() => null);
    setPending(null);
    const data = (await res?.json().catch(() => ({}))) as
      { error?: string; issues?: string[]; status?: string } | undefined;
    if (!res?.ok) {
      setIssues(data?.issues ?? []);
      toast.error(data?.error ?? "Could not record the decision.");
      return;
    }
    toast.success(
      decision === "reject"
        ? "Rejected — nothing was sent."
        : data?.status === "failed"
          ? "Approved, but the action failed — see the trace."
          : "Approved and executed.",
      { action: { label: "View trace", onClick: () => router.push(`/leads/${leadId}`) } },
    );
    router.refresh();
  }

  if (!isAdmin) {
    return <p className="text-xs text-muted-foreground">Admin login required to decide.</p>;
  }

  return (
    <div className="space-y-3">
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            aria-label="Edit payload (JSON)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(16, draft.split("\n").length + 1)}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Validated against the tool&apos;s schema before it runs.
          </p>
        </div>
      ) : (
        <JsonView label="Proposed action" value={payload} maxHeight="14rem" />
      )}
      {issues.length ? (
        <ul role="alert" className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      <input
        aria-label="Optional note"
        placeholder="Optional note for the trace (e.g. “moved to Thursday”)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        className="h-8 w-full rounded-lg border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => decide("approve")} disabled={pending !== null}>
          {pending === "approve" ? (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          ) : (
            <CheckIcon data-icon="inline-start" />
          )}
          {editing ? "Approve edited" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing((e) => !e)}
          disabled={pending !== null}
        >
          <PencilIcon data-icon="inline-start" />
          {editing ? "Cancel edit" : "Edit"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => decide("reject")}
          disabled={pending !== null}
        >
          {pending === "reject" ? (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          ) : (
            <XIcon data-icon="inline-start" />
          )}
          Reject
        </Button>
        <Link href={`/leads/${leadId}`} className="ml-auto text-xs text-primary hover:underline">
          Open trace →
        </Link>
      </div>
    </div>
  );
}
