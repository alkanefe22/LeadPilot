/**
 * PII masking for the read-only public demo. Admins see everything; anonymous
 * visitors see `j***@freightlane.io` and `+1 ••• ••42` everywhere, including inside
 * trace JSON (prompts, tool inputs/outputs).
 */

const EMAIL_RE = /([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})/gi;
// International (+…) or space-separated US-style numbers. Deliberately does NOT match
// dash-only digit runs, so ISO dates/timestamps inside traces survive redaction.
const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\(?\b\d{3}\)?\s\d{3}[\s.-]\d{4}\b/g;

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return email ?? null;
  return email.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

export function maskText(text: string): string {
  return text
    .replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(PHONE_RE, (m) =>
      m.replace(/\D/g, "").length >= 8 ? `${m.slice(0, 3)} ••• ••${m.slice(-2)}` : m,
    );
}

/** Deeply masks every string in a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return maskText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  }
  return value;
}
