/**
 * Prompt-injection defenses. Defense in depth:
 *  1. The prompt fences lead-authored text in <lead_content> and tells the model it's data.
 *  2. `escapeUntrusted` makes it impossible for a lead to close that fence early.
 *  3. `detectPromptInjection` flags suspicious leads; flagged leads can't trigger outward
 *     actions (booking/email) without human approval, and can't be auto-qualified —
 *     so even a model that *does* comply can't do damage on its own.
 *
 * The scanner is a heuristic and can have false positives, so a flag is always visible
 * in the dashboard (with the matched patterns) and an admin can clear it and re-run.
 * Patterns target text that *addresses the agent*, not words that merely appear in
 * normal business email ("please ignore my previous email", "our NPS score is 98",
 * "help us write the system prompt for our bot").
 */

export const INJECTION_PATTERNS: { id: string; label: string; re: RegExp }[] = [
  {
    id: "ignore_instructions",
    label: "Asks the AI to ignore its instructions",
    re: /\b(ignore|disregard|forget|override|bypass)\b.{0,30}\b(previous|prior|above|earlier|all|your|system|any)\b.{0,20}\b(instructions?|prompts?|rules?|guidelines?|directives?)\b/i,
  },
  {
    id: "role_override",
    label: "Tries to change the AI's role",
    re: /\b(you are now|from now on,? you|you will now act|pretend (to be|you are)|you're now in)\b/i,
  },
  {
    id: "mode_switch",
    label: "Claims a special mode (admin/developer/jailbreak)",
    re: /\b(admin|developer|debug|god|DAN|jailbreak) mode\b|\bjailbreak\b/i,
  },
  {
    id: "prompt_exfiltration",
    label: "Asks to reveal the system prompt",
    re: /\b(reveal|show|print|repeat|output|leak|tell me)\b.{0,25}\b(system prompt|your (instructions|prompt|rules))\b/i,
  },
  {
    id: "self_qualify",
    label: "Asks to be marked qualified",
    re: /\b(mark|set|flag|classify|label|treat)\b.{0,20}\b(me|this lead|us|our lead)\b.{0,15}\b(as )?(qualified|approved|priority|a hot lead)\b/i,
  },
  {
    id: "forced_score",
    label: "Dictates its own lead score",
    re: /\b(give|set|assign|rate|mark)\b.{0,25}\b(score|rating)\b.{0,15}\b(of |to |= ?|: ?)?(100|9\d)\b|\bscore (me|us|this lead)\b.{0,15}\b(100|9\d)\b/i,
  },
  {
    id: "fake_markup",
    label: "Contains fake system/tool markup",
    re: /<\/?\s*(system|assistant|instructions?|tool_result|tool_use|lead_content|lead_metadata)\b[^>]*>|#{2,}\s*system\s*(notice|message|prompt)/i,
  },
  {
    id: "tool_invocation",
    label: "Tries to invoke the agent's tools",
    re: /\b(call|invoke|use|run|execute)\b.{0,10}\b(book_meeting|score_lead|send_email|mark_disqualified|upsert_crm_contact|check_availability)\b/i,
  },
];

export type InjectionScan = { suspicious: boolean; matches: string[] };

export function detectPromptInjection(...texts: (string | null | undefined)[]): InjectionScan {
  const joined = texts.filter(Boolean).join("\n");
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(joined)).map((p) => p.id);
  return { suspicious: matches.length > 0, matches };
}

export function patternLabel(id: string): string {
  return INJECTION_PATTERNS.find((p) => p.id === id)?.label ?? id;
}

const FENCE_TAG = /<\s*\/?\s*lead_content\b[^>]*>/gi;

/** Neutralizes anything that could terminate or forge our untrusted-content fence. */
export function escapeUntrusted(text: string): string {
  return text.replace(FENCE_TAG, "[removed-tag]");
}

export const RISK_PROMPT_INJECTION = "prompt_injection";
