export type Slot = { start: string; end: string };

export type AvailabilityQuery = {
  workspaceId: string;
  from: Date;
  to: Date;
  durationMin: number;
  timeZone: string;
  limit: number;
};

export type BookingRequest = {
  workspaceId: string;
  start: Date;
  end: Date;
  timeZone: string;
  title: string;
  description: string;
  attendee: { email: string; name?: string | null };
  /** False for demo (seeded/simulated) leads: never email invites to made-up addresses. */
  inviteAttendee: boolean;
};

export type BookingResult = { eventId: string; meetingUrl: string | null };

export type ConnectionCheck = { ok: true; detail: string };

export interface CalendarAdapter {
  readonly name: "mock" | "google";
  getAvailability(q: AvailabilityQuery): Promise<Slot[]>;
  /** Re-checks a single slot right before booking (the model may pick a stale one). */
  isAvailable(
    q: Omit<AvailabilityQuery, "from" | "to" | "limit"> & { start: Date; end: Date },
  ): Promise<boolean>;
  book(req: BookingRequest): Promise<BookingResult>;
  cancel(eventId: string): Promise<void>;
  /** Harmless read call; throws ProviderError on failure. */
  testConnection(): Promise<ConnectionCheck>;
}
