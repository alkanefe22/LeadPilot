"use client";

import { Loader2Icon, RotateCwIcon, ShieldOffIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type Props = { leadId: string; isAdmin: boolean; running: boolean };

async function startRun(leadId: string, clearFlag: boolean) {
  const res = await fetch(`/api/leads/${leadId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clearFlag }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not start the agent.");
}

function useRun(leadId: string) {
  const router = useRouter();
  const [pending, setPending] = useState<"rerun" | "clear" | null>(null);
  const run = async (clearFlag: boolean) => {
    setPending(clearFlag ? "clear" : "rerun");
    try {
      await startRun(leadId, clearFlag);
      toast.success(clearFlag ? "Flag cleared — agent re-running" : "Agent re-running");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(null);
    }
  };
  return { pending, run };
}

const adminOnly = "Admin login required";

export function RerunButton({ leadId, isAdmin, running }: Props) {
  const { pending, run } = useRun(leadId);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => run(false)}
      disabled={!isAdmin || running || pending !== null}
      title={
        !isAdmin ? adminOnly : running ? "A run is in progress" : "Run the agent again on this lead"
      }
    >
      {pending === "rerun" ? (
        <Loader2Icon className="animate-spin" data-icon="inline-start" />
      ) : (
        <RotateCwIcon data-icon="inline-start" />
      )}
      Re-run agent
    </Button>
  );
}

export function ClearFlagButton({ leadId, isAdmin, running }: Props) {
  const { pending, run } = useRun(leadId);
  return (
    <Button
      size="sm"
      variant="outline"
      className="border-orange-500/40 hover:bg-orange-500/10"
      onClick={() => run(true)}
      disabled={!isAdmin || running || pending !== null}
      title={
        !isAdmin
          ? adminOnly
          : "I reviewed this lead: it's genuine. Clear the flag and re-run the agent."
      }
    >
      {pending === "clear" ? (
        <Loader2Icon className="animate-spin" data-icon="inline-start" />
      ) : (
        <ShieldOffIcon data-icon="inline-start" />
      )}
      Clear flag &amp; re-run
    </Button>
  );
}
