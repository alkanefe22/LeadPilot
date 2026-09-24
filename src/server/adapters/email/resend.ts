import { ProviderError, providerFetch, recordHealth } from "../http";
import type { EmailAdapter, OutgoingEmail, SendResult } from "./types";

const API = "https://api.resend.com";

/**
 * Resend transactional email. Sets Reply-To to the lead's `reply+<token>@` address and
 * In-Reply-To/References so replies thread back (see /api/inbound/email), and passes our
 * idempotency key so a retried request can't send twice.
 */
export class ResendEmailAdapter implements EmailAdapter {
  readonly name = "resend" as const;

  constructor(private readonly apiKey: string) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    const headers: Record<string, string> = {};
    if (email.inReplyTo) {
      headers["In-Reply-To"] = email.inReplyTo;
      headers.References = email.inReplyTo;
    }
    const res = await providerFetch<{ id: string }>("resend", `${API}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(email.idempotencyKey ? { "Idempotency-Key": email.idempotencyKey } : {}),
      },
      json: {
        from: email.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      },
    });
    return { providerMessageId: res.id };
  }

  /** Full content of an inbound email (webhooks only carry metadata). */
  async getReceivedEmail(id: string) {
    return providerFetch<{
      from: string;
      to: string[];
      subject: string | null;
      text: string | null;
      html: string | null;
      headers: Record<string, string> | null;
      message_id: string | null;
    }>("resend", `${API}/emails/receiving/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  async testConnection() {
    try {
      await providerFetch("resend", `${API}/domains`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return { ok: true as const, detail: "API key valid (full access)." };
    } catch (err) {
      // Sending-only keys can't list domains but are exactly what production should use.
      if (err instanceof ProviderError && err.status === 401 && /restricted/i.test(err.detail)) {
        await recordHealth("resend", null);
        return { ok: true as const, detail: "API key valid (sending access only)." };
      }
      throw err;
    }
  }
}
