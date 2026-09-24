import { stripHtml } from "../security/sanitize";

/** Provider-neutral inbound email. */
export type InboundEmail = {
  provider: "postmark" | "resend" | "generic";
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  subject: string | null;
  /** Reply text with quoted history removed. */
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** `"Jane Doe" <jane@x.io>` → { name, email } */
export function parseAddress(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1]?.trim() || null, email: m[2]!.trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}

function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    // Postmark: [{ Name, Value }]
    for (const h of headers) {
      if (isObj(h) && typeof h.Name === "string" && typeof h.Value === "string")
        out[h.Name.toLowerCase()] = h.Value;
    }
  } else if (isObj(headers)) {
    for (const [k, v] of Object.entries(headers))
      if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

const splitIds = (v: string | null | undefined) => (v ? (v.match(/<[^>]+>/g) ?? []) : []);

/** Removes quoted history ("> …", "On … wrote:", Gmail/Outlook separators). */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex(
    (l) =>
      /^\s*>/.test(l) ||
      /^On .+wrote:\s*$/i.test(l.trim()) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) ||
      /^_{5,}$/.test(l.trim()) ||
      /^From: .+$/i.test(l.trim()),
  );
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}

/** Accepts Postmark inbound JSON, Resend `email.received` events, or a generic shape. */
export function normalizeInboundEmail(body: unknown): InboundEmail | null {
  if (!isObj(body)) return null;

  // Postmark
  if ("FromFull" in body || "TextBody" in body || "StrippedTextReply" in body) {
    const from = isObj(body.FromFull) ? body.FromFull : {};
    const headers = headerMap(body.Headers);
    const toFull = Array.isArray(body.ToFull) ? body.ToFull : [];
    const to = [
      ...toFull.map((t) => (isObj(t) ? str(t.Email) : null)),
      ...(str(body.OriginalRecipient) ? [str(body.OriginalRecipient)] : []),
      ...(str(body.To)
        ?.split(",")
        .map((s) => parseAddress(s).email) ?? []),
    ].filter((x): x is string => !!x);
    const text =
      str(body.StrippedTextReply) ??
      stripQuotedReply(str(body.TextBody) ?? stripHtml(str(body.HtmlBody) ?? ""));
    return {
      provider: "postmark",
      fromEmail: str(from.Email)?.toLowerCase() ?? parseAddress(str(body.From)).email,
      fromName: str(from.Name) ?? parseAddress(str(body.From)).name,
      to: [...new Set(to.map((t) => t.toLowerCase()))],
      subject: str(body.Subject),
      text,
      messageId: headers["message-id"] ?? (str(body.MessageID) ? `<${str(body.MessageID)}>` : null),
      inReplyTo: splitIds(headers["in-reply-to"])[0] ?? null,
      references: splitIds(headers["references"]),
    };
  }

  // Resend (`{ type: "email.received", data: {...} }`) or generic flat shape.
  const provider = body.type === "email.received" && isObj(body.data) ? "resend" : "generic";
  const d = provider === "resend" ? (body.data as Obj) : body;
  const headers = headerMap(d.headers);
  const fromRaw = str(d.from) ?? (isObj(d.from) ? str((d.from as Obj).email) : null);
  const addr = parseAddress(fromRaw);
  const toRaw = Array.isArray(d.to) ? d.to : str(d.to) ? [d.to] : [];
  const to = toRaw
    .map((t) => (typeof t === "string" ? parseAddress(t).email : isObj(t) ? str(t.email) : null))
    .filter((x): x is string => !!x);
  const rawText = str(d.text) ?? stripHtml(str(d.html) ?? "");
  if (!addr.email && !rawText) return null;
  return {
    provider,
    fromEmail: addr.email,
    fromName: addr.name,
    to: [...new Set(to.map((t) => t.toLowerCase()))],
    subject: str(d.subject),
    text: stripQuotedReply(rawText),
    messageId: str(d.message_id) ?? headers["message-id"] ?? null,
    inReplyTo: str(d.in_reply_to) ?? splitIds(headers["in-reply-to"])[0] ?? null,
    references: splitIds(str(d.references) ?? headers["references"]),
  };
}

/** `reply+<threadToken>@domain` → threadToken */
export function threadTokenFromAddresses(to: string[]): string | null {
  for (const addr of to) {
    const m = /^reply\+([a-z0-9_]+)@/i.exec(addr);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}
