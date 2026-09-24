export type OutgoingEmail = {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  /** RFC 5322 Message-ID we assign, e.g. `<em_x@leadpilot.local>` — used for threading. */
  messageId: string;
  inReplyTo?: string | null;
  /** Stable key so a provider-side retry can never send twice. */
  idempotencyKey?: string;
};

export type SendResult = { providerMessageId: string | null };

export interface EmailAdapter {
  readonly name: "console" | "resend";
  send(email: OutgoingEmail): Promise<SendResult>;
  testConnection(): Promise<{ ok: true; detail: string }>;
}
