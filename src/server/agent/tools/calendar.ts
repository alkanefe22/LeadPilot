import { z } from "zod";
import { formatInTz } from "@/lib/time";
import { isUniqueViolation } from "../../db/errors";
import { bookings } from "../../db/schema";
import { isDemoLead } from "../../services/intake";
import { defineTool, ToolError, type ToolContext } from "../types";
import { confirmedBooking, currentQualification, intFrom, updateLead } from "./helpers";

export const checkAvailability = defineTool({
  name: "check_availability",
  description:
    "List open meeting slots on the team calendar (times are returned in ISO-8601 UTC and in the workspace timezone). Only call for qualified leads, before book_meeting.",
  input: z.object({
    days_ahead: intFrom(1, 21).default(7).describe("How many days ahead to search."),
    max_slots: intFrom(1, 12).default(6).describe("Maximum number of slots to return."),
  }),
  async run(input, ctx) {
    const ws = ctx.workspace;
    const from = new Date(ctx.now().getTime() + ws.bookingLeadTimeHours * 3_600_000);
    const to = new Date(from.getTime() + input.days_ahead * 86_400_000);
    const slots = await ctx.adapters.calendar.getAvailability({
      workspaceId: ws.id,
      from,
      to,
      durationMin: ws.meetingDurationMin,
      timeZone: ws.timezone,
      limit: input.max_slots,
    });
    return {
      timezone: ws.timezone,
      duration_min: ws.meetingDurationMin,
      provider: ctx.adapters.calendar.name,
      slots: slots.map((s) => ({
        start: s.start,
        end: s.end,
        local: formatInTz(new Date(s.start), ws.timezone),
      })),
    };
  },
});

async function bookingPrecheck(ctx: ToolContext) {
  if (!ctx.lead.email) throw new ToolError("Lead has no email address; cannot send an invite.");
  if (ctx.approved) return;
  const q = currentQualification(ctx);
  if (!q) throw new ToolError("Policy: call score_lead before booking a meeting.");
  if (q.category !== "fit" || q.score < ctx.workspace.scoreThreshold) {
    throw new ToolError(
      `Policy: only qualified leads can be booked (score ${q.score} < threshold ${ctx.workspace.scoreThreshold} or category "${q.category}").`,
    );
  }
}

export const bookMeeting = defineTool({
  name: "book_meeting",
  description:
    "Book a discovery call with a qualified lead in one of the slots returned by check_availability. Idempotent: if the lead already has a confirmed booking, returns it instead of double-booking.",
  approvable: true,
  input: z.object({
    start: z.iso
      .datetime({ offset: true })
      .describe("Slot start time exactly as returned by check_availability (ISO-8601)."),
    title: z.string().trim().min(3).max(120).optional().describe("Calendar event title."),
    agenda: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe("Short agenda for the invite description."),
  }),
  async precheck(_input, ctx) {
    await bookingPrecheck(ctx);
  },
  async run(input, ctx) {
    await bookingPrecheck(ctx);
    const existing = await confirmedBooking(ctx.db, ctx.lead.id);
    if (existing) {
      return {
        status: "already_booked",
        booking_id: existing.id,
        start: existing.startAt.toISOString(),
        start_local: formatInTz(existing.startAt, ctx.workspace.timezone),
        meeting_url: existing.meetingUrl,
      };
    }
    const ws = ctx.workspace;
    const start = new Date(input.start);
    const end = new Date(start.getTime() + ws.meetingDurationMin * 60_000);
    if (start.getTime() < ctx.now().getTime() + 3_600_000) {
      throw new ToolError("Slot is in the past or less than 1 hour away. Pick another slot.");
    }
    const free = await ctx.adapters.calendar.isAvailable({
      workspaceId: ws.id,
      start,
      end,
      timeZone: ws.timezone,
      durationMin: ws.meetingDurationMin,
    });
    if (!free) {
      throw new ToolError(
        "That slot is not available. Call check_availability and pick a listed slot.",
      );
    }
    const lead = ctx.lead;
    const title =
      input.title ?? `Discovery call — ${lead.company ?? lead.name ?? lead.email} × ${ws.name}`;
    const event = await ctx.adapters.calendar.book({
      workspaceId: ws.id,
      start,
      end,
      timeZone: ws.timezone,
      title,
      description: input.agenda ?? `Discovery call booked by LeadPilot for lead ${lead.id}.`,
      attendee: { email: lead.email!, name: lead.name },
      inviteAttendee: !isDemoLead(lead),
    });
    try {
      const [row] = await ctx.db
        .insert(bookings)
        .values({
          workspaceId: ws.id,
          leadId: lead.id,
          startAt: start,
          endAt: end,
          title,
          provider: ctx.adapters.calendar.name,
          externalEventId: event.eventId,
          meetingUrl: event.meetingUrl,
        })
        .returning();
      await updateLead(ctx, { status: "booked" });
      ctx.state.outwardActions.push("book_meeting");
      return {
        status: "booked",
        booking_id: row!.id,
        start: start.toISOString(),
        end: end.toISOString(),
        start_local: formatInTz(start, ws.timezone),
        meeting_url: event.meetingUrl,
        provider: ctx.adapters.calendar.name,
      };
    } catch (err) {
      // Lost a race with a concurrent booking: roll back the calendar event, report the winner.
      if (isUniqueViolation(err)) {
        await ctx.adapters.calendar.cancel(event.eventId).catch(() => {});
        const winner = await confirmedBooking(ctx.db, ctx.lead.id);
        return {
          status: "already_booked",
          booking_id: winner?.id,
          start: winner?.startAt.toISOString(),
        };
      }
      throw err;
    }
  },
});
