/**
 * Input sanitization for untrusted inbound text (forms, webhooks, emails).
 * We store plain text only; React escapes on render, but stripping markup here
 * keeps prompts clean and prevents HTML from ever reaching outgoing emails.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SCRIPT_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const TAGS = /<\/?[a-z][^>]*>/gi;
const BR_P = /<(br|\/p|\/div|\/li)\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function stripHtml(input: string): string {
  return input
    .replace(SCRIPT_STYLE, "")
    .replace(BR_P, "\n")
    .replace(TAGS, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

export function sanitizeText(input: unknown, maxLength = 5000): string {
  if (typeof input !== "string") return "";
  const cleaned = stripHtml(input)
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** Single-line field (name, company…): collapses whitespace. Returns null when empty. */
export function sanitizeLine(input: unknown, maxLength = 200): string | null {
  const v = sanitizeText(input, maxLength).replace(/\s+/g, " ").trim();
  return v.length ? v : null;
}

const EMAIL_RE = /^[^\s@<>()[\]\,;:"]+@[^\s@<>()[\]\,;:"]+\.[a-z]{2,}$/i;

export function sanitizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // Accept `Name <user@x.com>` forms.
  const match = input.match(/<([^>]+)>/);
  const candidate = (match?.[1] ?? input).trim().toLowerCase();
  return EMAIL_RE.test(candidate) && candidate.length <= 254 ? candidate : null;
}

export function sanitizeUrl(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  try {
    const url = new URL(input.trim().startsWith("http") ? input.trim() : `https://${input.trim()}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
