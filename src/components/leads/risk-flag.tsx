import { TriangleAlertIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Mirrors INJECTION_PATTERNS labels (kept client-safe; ids are the stable contract). */
const LABELS: Record<string, string> = {
  ignore_instructions: "Asks the AI to ignore its instructions",
  role_override: "Tries to change the AI's role",
  mode_switch: "Claims a special mode (admin/developer/jailbreak)",
  prompt_exfiltration: "Asks to reveal the system prompt",
  self_qualify: "Asks to be marked qualified",
  forced_score: "Dictates its own lead score",
  fake_markup: "Contains fake system/tool markup",
  tool_invocation: "Tries to invoke the agent's tools",
};

export const patternText = (id: string) => LABELS[id] ?? id;

export function isInjectionFlagged(riskFlags: string[] | null | undefined) {
  return !!riskFlags?.includes("prompt_injection");
}

/** Compact "⚠ Flagged" pill with the matched patterns in a tooltip. */
export function RiskFlagBadge({ matches, className }: { matches: string[]; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "relative z-10 inline-flex items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-orange-700 dark:text-orange-300",
              className,
            )}
          />
        }
      >
        <TriangleAlertIcon className="size-3" />
        Flagged
        <span className="sr-only">
          : possible prompt injection ({matches.map(patternText).join("; ")})
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">Possible prompt injection</p>
        <ul className="mt-1 list-disc pl-4">
          {matches.length ? (
            matches.map((m) => <li key={m}>{patternText(m)}</li>)
          ) : (
            <li>Flagged by the scanner</li>
          )}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
