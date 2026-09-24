/**
 * Prompt-injection defenses. Defense in depth:
 *  1. The prompt fences lead-authored text in <lead_content> and tells the model it's data.
 *  2. `escapeUntrusted` makes it impossible for a lead to close that fence early.
 *  3. `detectPromptInjection` flags suspicious leads; flagged leads can't trigger outward
 *     actions (booking/email) without human approval, and can't be auto-qualified —
 *     so even a model that *does* comply can't do damage on its own.
 */

const PATTERNS: [label: string, re: RegExp][] = [
  [
    "ignore_instructions",
    /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|your|system)\b.{0,20}\b(instructions?|prompts?|rules?|guidelines?)/i,
  ],
  ["role_override", /\b(you are now|act as (an?|the) |pretend to be|from now on you)\b/i],
  ["system_prompt", /\b(system prompt|developer (message|mode)|admin mode|jailbreak|DAN mode)\b/i],
  [
    "self_qualify",
    /\b(mark|set|flag|classify|label)\b.{0,20}\b(me|this lead|this|us)\b.{0,15}\b(as )?(qualified|approved|priority|hot lead)/i,
  ],
  ["forced_score", /\bscore\b.{0,15}\b(of |= ?|: ?|to )?(100|99|98|97|96|95)\b/i],
  ["fake_markup", /<\/?\s*(system|assistant|instructions?|tool_result|lead_content)\b[^>]*>/i],
  ["new_instructions", /\b(new|updated|additional) (instructions?|directives?)\s*:/i],
  [
    "tool_invocation",
    /\b(call|invoke|use|run)\b.{0,10}\b(book_meeting|score_lead|send_email|mark_disqualified|upsert_crm_contact)\b/i,
  ],
];

export type InjectionScan = { suspicious: boolean; matches: string[] };

export function detectPromptInjection(...texts: (string | null | undefined)[]): InjectionScan {
  const joined = texts.filter(Boolean).join("\n");
  const matches = PATTERNS.filter(([, re]) => re.test(joined)).map(([label]) => label);
  return { suspicious: matches.length > 0, matches };
}

const FENCE_TAG = /<\s*\/?\s*lead_content\b[^>]*>/gi;

/** Neutralizes anything that could terminate or forge our untrusted-content fence. */
export function escapeUntrusted(text: string): string {
  return text.replace(FENCE_TAG, "[removed-tag]");
}

export const RISK_PROMPT_INJECTION = "prompt_injection";
