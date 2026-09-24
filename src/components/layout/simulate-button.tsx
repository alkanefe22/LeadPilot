"use client";

import { FilmIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SimulateState = {
  enabled: boolean;
  limitReached: boolean;
  videoUrl: string | null;
  reason?: string | null;
};

/**
 * Creates a random realistic lead and jumps to its trace so the visitor can
 * watch the agent work live. Handles the daily demo budget and rate limits.
 */
export function SimulateButton({ state, className }: { state: SimulateState; className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [limit, setLimit] = useState<{ videoUrl: string | null } | null>(
    state.limitReached ? { videoUrl: state.videoUrl } : null,
  );

  if (limit) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
        {limit.videoUrl ? (
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<a href={limit.videoUrl} target="_blank" rel="noreferrer" />}
          >
            <FilmIcon data-icon="inline-start" />
            <span className="hidden sm:inline">Demo limit reached today — watch the video</span>
            <span className="sm:hidden">Watch the video</span>
          </Button>
        ) : (
          <span>Demo limit reached today</span>
        )}
      </div>
    );
  }

  async function simulate() {
    setPending(true);
    try {
      const res = await fetch("/api/simulate", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        leadId?: string;
        error?: string;
        code?: string;
        videoUrl?: string | null;
      };
      if (res.ok && data.leadId) {
        toast.success("New lead received — watch the agent work");
        router.push(`/leads/${data.leadId}`);
        return;
      }
      if (data.code === "demo_limit") {
        setLimit({ videoUrl: data.videoUrl ?? state.videoUrl });
        toast.info("Demo limit reached today — watch the video instead.");
        return;
      }
      toast.error(data.error ?? "Could not simulate a lead.");
    } catch {
      toast.error("Network error — please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      size="sm"
      onClick={simulate}
      disabled={pending || !state.enabled}
      title={state.enabled ? undefined : (state.reason ?? undefined)}
      aria-label="Simulate lead"
      className={className}
    >
      {pending ? (
        <Loader2Icon className="animate-spin" data-icon="inline-start" />
      ) : (
        <SparklesIcon data-icon="inline-start" />
      )}
      Simulate<span className="hidden sm:inline"> lead</span>
    </Button>
  );
}
