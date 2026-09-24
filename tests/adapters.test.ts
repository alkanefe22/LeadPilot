import { beforeAll, describe, expect, it } from "vitest";
import { selectAdapters } from "@/server/adapters";
import { MockCalendarAdapter } from "@/server/adapters/calendar/mock";
import { InternalCrmAdapter } from "@/server/adapters/crm/internal";
import { ConsoleEmailAdapter } from "@/server/adapters/email/console";
import type { Database } from "@/server/db/client";
import { bookings, crmContacts } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID } from "@/server/db/seed-data";
import { parseEnv } from "@/lib/env";
import { wallParts } from "@/lib/time";
import { createLead } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

const TZ = "Europe/Istanbul";

describe("adapters", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  describe("mock calendar", () => {
    const cal = new MockCalendarAdapter();
    const from = new Date("2026-03-02T00:00:00Z"); // a Monday
    const to = new Date("2026-03-09T00:00:00Z");

    it("returns weekday business-hour slots in the workspace timezone", async () => {
      const slots = await cal.getAvailability({
        workspaceId: DEFAULT_WORKSPACE_ID,
        from,
        to,
        durationMin: 30,
        timeZone: TZ,
        limit: 10,
      });
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        const p = wallParts(new Date(s.start), TZ);
        expect(p.weekday).toBeGreaterThanOrEqual(1);
        expect(p.weekday).toBeLessThanOrEqual(5);
        expect(p.hour).toBeGreaterThanOrEqual(9);
        expect(p.hour).toBeLessThan(17);
        expect(new Date(s.end).getTime() - new Date(s.start).getTime()).toBe(30 * 60_000);
      }
    });

    it("is deterministic and removes slots taken by confirmed bookings", async () => {
      const q = {
        workspaceId: DEFAULT_WORKSPACE_ID,
        from,
        to,
        durationMin: 30,
        timeZone: TZ,
        limit: 10,
      };
      const before = await cal.getAvailability(q);
      expect(await cal.getAvailability(q)).toEqual(before);
      const lead = await createLead(db);
      const first = before[0]!;
      await db.insert(bookings).values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        leadId: lead.id,
        startAt: new Date(first.start),
        endAt: new Date(first.end),
        title: "x",
        provider: "mock",
      });
      const after = await cal.getAvailability(q);
      expect(after.map((s) => s.start)).not.toContain(first.start);
      expect(
        await cal.isAvailable({
          workspaceId: DEFAULT_WORKSPACE_ID,
          start: new Date(first.start),
          end: new Date(first.end),
          timeZone: TZ,
        }),
      ).toBe(false);
    });

    it("rejects weekend and out-of-hours slots", async () => {
      const sat = new Date("2026-03-07T08:00:00Z"); // Saturday 11:00 Istanbul
      const late = new Date("2026-03-03T16:00:00Z"); // Tuesday 19:00 Istanbul
      for (const start of [sat, late]) {
        const end = new Date(start.getTime() + 30 * 60_000);
        expect(
          await cal.isAvailable({
            workspaceId: DEFAULT_WORKSPACE_ID,
            start,
            end,
            timeZone: TZ,
          }),
        ).toBe(false);
      }
    });
  });

  it("internal CRM creates then updates the same contact and appends notes", async () => {
    const crm = new InternalCrmAdapter();
    const lead = await createLead(db);
    const base = { workspaceId: DEFAULT_WORKSPACE_ID, leadId: lead.id, email: "Crm@Example.com" };
    const a = await crm.upsertContact({ ...base, status: "new", note: "first" });
    const b = await crm.upsertContact({ ...base, status: "booked", score: 90, note: "second" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const rows = await db.select().from(crmContacts);
    const row = rows.find((r) => r.id === a.id)!;
    expect(row.email).toBe("crm@example.com");
    expect(row.fields).toMatchObject({ status: "booked", score: 90 });
    expect(row.notes).toHaveLength(2);
  });

  it("console email adapter logs instead of sending", async () => {
    const lines: string[] = [];
    const res = await new ConsoleEmailAdapter((l) => lines.push(l)).send({
      from: "a@x.io",
      to: "b@y.io",
      subject: "Hello",
      text: "Body",
      messageId: "<m@x>",
    });
    expect(res.providerMessageId).toMatch(/^console_/);
    expect(lines[0]).toContain("b@y.io");
  });

  it("selects demo adapters when no integration keys exist, never throwing", () => {
    const { status } = selectAdapters(parseEnv({ DATABASE_URL: "x", CRM_ADAPTER: "hubspot" }));
    expect(status.map((s) => s.active)).toEqual(["mock", "internal", "console"]);
    expect(status.find((s) => s.kind === "crm")?.note).toBeTruthy();
  });
});
