import { newId } from "@/lib/ids";
import type { EmailAdapter, OutgoingEmail, SendResult } from "./types";

/**
 * Demo email transport: nothing leaves the server. Every email is still persisted to
 * the `emails` table by the email service, which is what the dashboard Outbox shows.
 */
export class ConsoleEmailAdapter implements EmailAdapter {
  readonly name = "console" as const;

  constructor(private readonly log: (line: string) => void = (l) => console.info(l)) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    this.log(`[email:console] ${email.from} → ${email.to} · "${email.subject}"`);
    return { providerMessageId: newId("console", 12) };
  }
}
