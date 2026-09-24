import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseEnv } from "@/lib/env";
import { selectAdapters } from "@/server/adapters";
import { GoogleCalendarAdapter, toLocalIso } from "@/server/adapters/calendar/google";
import { MockCalendarAdapter } from "@/server/adapters/calendar/mock";
import { generateSlots, withinBusinessHours } from "@/server/adapters/calendar/slots";
import { HubSpotCrmAdapter, qualificationNote, splitName } from "@/server/adapters/crm/hubspot";
import { InternalCrmAdapter } from "@/server/adapters/crm/internal";
import { ConsoleEmailAdapter } from "@/server/adapters/email/console";
import { ResendEmailAdapter } from "@/server/adapters/email/resend";
import { ProviderError, providerFetch, setProviderBackoff } from "@/server/adapters/http";
import { runAgent } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { adapterHealth, agentSteps } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID } from "@/server/db/seed-data";
import { signSvix, verifySvix } from "@/server/inbound/svix";
import { FakeLlm } from "./helpers/fake-llm";
import { createLead, GOOD_SCORE } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";
import { json, mockFetch, sequence } from "./helpers/mock-fetch";

let db: Database;
beforeAll(async () => {
  db = await createTestDb();
  setProviderBackoff(0);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const health = async (provider: string) =>
  (await db.select().from(adapterHealth).where(eq(adapterHealth.provider, provider)))[0];

describe("providerFetch: retries and errors", () => {
  it("retries once on 429 and succeeds", async () => {
    const f = mockFetch(
      sequence(
        () => true,
        () => json(429, { message: "slow down" }),
        () => json(200, { ok: 1 }),
      ),
    );
    await expect(providerFetch("resend", "https://api.resend.com/x")).resolves.toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(2);
    expect((await health("resend"))?.failing).toBe(false);
  });

  it("gives up after one retry on 5xx with a clear, retryable error and records health", async () => {
    const f = mockFetch(() => json(503, { error: { message: "backend unavailable" } }));
    const err = await providerFetch("hubspot", "https://api.hubapi.com/x").catch((e: unknown) => e);
    expect(f.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      status: 503,
      retryable: true,
      message: "HubSpot error (HTTP 503): backend unavailable",
    });
    expect(await health("hubspot")).toMatchObject({
      failing: true,
      lastError: "HubSpot error (HTTP 503): backend unavailable",
    });
  });

  it("does not retry auth errors", async () => {
    const f = mockFetch(() => json(401, { message: "Invalid token" }));
    await expect(providerFetch("google", "https://x.googleapis.com/y")).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
    expect(f.calls).toHaveLength(1);
  });

  it("retries network errors once", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return json(200, { ok: true });
    });
    await expect(providerFetch("google", "https://x")).resolves.toEqual({ ok: true });
  });
});

describe("Google Calendar adapter (contract)", () => {
  const cfg = {
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "rtok",
    calendarId: "team@example.com",
  };
  const token = (c: { url: string }) =>
    c.url === "https://oauth2.googleapis.com/token"
      ? json(200, { access_token: "atok", expires_in: 3600 })
      : undefined;

  it("exchanges the refresh token once, then queries free/busy in the workspace timezone", async () => {
    const f = mockFetch(token, (c) =>
      c.url.endsWith("/freeBusy")
        ? json(200, {
            calendars: {
              "team@example.com": {
                busy: [{ start: "2026-03-02T06:00:00Z", end: "2026-03-02T07:00:00Z" }],
              }, // 09:00–10:00 Istanbul
            },
          })
        : undefined,
    );
    const g = new GoogleCalendarAdapter(cfg);
    const q = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      from: new Date("2026-03-02T00:00:00Z"),
      to: new Date("2026-03-03T00:00:00Z"),
      durationMin: 30,
      timeZone: "Europe/Istanbul",
      limit: 3,
    };
    const slots = await g.getAvailability(q);
    await g.getAvailability(q);

    const tokenCalls = f.calls.filter((c) => c.url.includes("oauth2"));
    expect(tokenCalls).toHaveLength(1); // cached
    expect(new URLSearchParams(tokenCalls[0]!.body!).get("grant_type")).toBe("refresh_token");
    const fb = f.calls.find((c) => c.url.endsWith("/freeBusy"))!;
    expect(fb.headers.authorization).toBe("Bearer atok");
    expect(JSON.parse(fb.body!)).toMatchObject({
      timeZone: "Europe/Istanbul",
      items: [{ id: "team@example.com" }],
    });
    // Busy 09:00–10:00 local → first free slot is 10:00 local (07:00Z).
    expect(slots[0]!.start).toBe("2026-03-02T07:00:00.000Z");
  });

  it("books with local wall time + IANA zone, a Google Meet request, and invites real leads", async () => {
    const f = mockFetch(token, (c) =>
      c.url.includes("/events?")
        ? json(200, { id: "evt_1", hangoutLink: "https://meet.google.com/abc-defg-hij" })
        : undefined,
    );
    const res = await new GoogleCalendarAdapter(cfg).book({
      workspaceId: DEFAULT_WORKSPACE_ID,
      start: new Date("2026-03-30T07:00:00Z"),
      end: new Date("2026-03-30T07:30:00Z"),
      timeZone: "Europe/Berlin",
      title: "Discovery call",
      description: "agenda",
      attendee: { email: "maya@acme.io", name: "Maya" },
      inviteAttendee: true,
    });
    expect(res).toEqual({ eventId: "evt_1", meetingUrl: "https://meet.google.com/abc-defg-hij" });
    const call = f.calls.find((c) => c.url.includes("/events?"))!;
    expect(call.url).toContain("/calendars/team%40example.com/events?");
    expect(call.url).toContain("conferenceDataVersion=1");
    expect(call.url).toContain("sendUpdates=all");
    const body = JSON.parse(call.body!);
    expect(body.start).toEqual({ dateTime: "2026-03-30T09:00:00", timeZone: "Europe/Berlin" }); // CEST
    expect(body.attendees).toEqual([{ email: "maya@acme.io", displayName: "Maya" }]);
    expect(body.conferenceData.createRequest.conferenceSolutionKey).toEqual({
      type: "hangoutsMeet",
    });
  });

  it("never invites demo leads", async () => {
    const f = mockFetch(token, (c) =>
      c.url.includes("/events?") ? json(200, { id: "e" }) : undefined,
    );
    await new GoogleCalendarAdapter(cfg).book({
      workspaceId: DEFAULT_WORKSPACE_ID,
      start: new Date("2026-03-30T07:00:00Z"),
      end: new Date("2026-03-30T07:30:00Z"),
      timeZone: "UTC",
      title: "t",
      description: "d",
      attendee: { email: "fake@acme.example" },
      inviteAttendee: false,
    });
    const call = f.calls.find((c) => c.url.includes("/events?"))!;
    expect(call.url).toContain("sendUpdates=none");
    expect(JSON.parse(call.body!).attendees).toBeUndefined();
  });

  it("surfaces free/busy calendar errors and a harmless read for Test connection", async () => {
    mockFetch(token, (c) =>
      c.url.endsWith("/freeBusy")
        ? json(200, { calendars: { "team@example.com": { errors: [{ reason: "notFound" }] } } })
        : c.url.endsWith("/calendars/team%40example.com")
          ? json(200, { summary: "Sales", timeZone: "Europe/Istanbul" })
          : undefined,
    );
    const g = new GoogleCalendarAdapter(cfg);
    await expect(
      g.isAvailable({
        start: new Date("2026-03-02T07:00:00Z"),
        end: new Date("2026-03-02T07:30:00Z"),
        timeZone: "Europe/Istanbul",
      }),
    ).rejects.toThrow(/notFound/);
    await expect(g.testConnection()).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining("Sales"),
    });
  });
});

describe("timezones and DST", () => {
  const nineAm = (from: string, to: string, timeZone: string) =>
    generateSlots({
      from: new Date(from),
      to: new Date(to),
      durationMin: 30,
      timeZone,
      limit: 1,
      isBlocked: () => false,
    })[0]!.start;

  it("keeps 09:00 local across the EU spring-forward (Europe/Berlin, 29 Mar 2026)", () => {
    expect(nineAm("2026-03-27T00:00:00Z", "2026-03-28T00:00:00Z", "Europe/Berlin")).toBe(
      "2026-03-27T08:00:00.000Z",
    ); // CET +1
    expect(nineAm("2026-03-30T00:00:00Z", "2026-03-31T00:00:00Z", "Europe/Berlin")).toBe(
      "2026-03-30T07:00:00.000Z",
    ); // CEST +2
  });

  it("keeps 09:00 local across the US fall-back (America/New_York, 1 Nov 2026)", () => {
    expect(nineAm("2026-10-30T00:00:00Z", "2026-10-31T00:00:00Z", "America/New_York")).toBe(
      "2026-10-30T13:00:00.000Z",
    ); // EDT −4
    expect(nineAm("2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z", "America/New_York")).toBe(
      "2026-11-02T14:00:00.000Z",
    ); // EST −5
  });

  it("handles half-hour offsets and skips weekends", () => {
    expect(nineAm("2026-03-02T00:00:00Z", "2026-03-03T00:00:00Z", "Asia/Kolkata")).toBe(
      "2026-03-02T03:30:00.000Z",
    );
    // Sat 28 Mar → first slot is Monday.
    expect(nineAm("2026-03-28T00:00:00Z", "2026-04-01T00:00:00Z", "Europe/Berlin")).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });

  it("formats Google wall times per zone and enforces business hours locally", () => {
    expect(toLocalIso(new Date("2026-11-02T14:00:00Z"), "America/New_York")).toBe(
      "2026-11-02T09:00:00",
    );
    expect(toLocalIso(new Date("2026-10-30T13:00:00Z"), "America/New_York")).toBe(
      "2026-10-30T09:00:00",
    );
    const fivePm = new Date("2026-03-30T15:00:00Z"); // 17:00 CEST
    expect(
      withinBusinessHours(fivePm, new Date(fivePm.getTime() + 30 * 60_000), "Europe/Berlin"),
    ).toBe(false);
    const fourThirty = new Date("2026-03-30T14:30:00Z"); // 16:30 CEST → ends 17:00
    expect(
      withinBusinessHours(
        fourThirty,
        new Date(fourThirty.getTime() + 30 * 60_000),
        "Europe/Berlin",
      ),
    ).toBe(true);
  });
});

describe("HubSpot adapter (contract)", () => {
  const q = {
    score: 86,
    category: "fit" as const,
    reasoning: "VP Ops <b>with</b> budget",
    budget: "$20k",
    timeline: "Q3",
    need: "intake",
    authority: null,
    missing: [],
  };

  it("upserts by email with standard properties, then attaches the qualification as a note", async () => {
    const f = mockFetch((c) =>
      c.url.endsWith("/contacts/batch/upsert")
        ? json(200, { results: [{ id: "901", new: true }] })
        : c.url.endsWith("/objects/notes")
          ? json(201, { id: "n1" })
          : undefined,
    );
    const res = await new HubSpotCrmAdapter("pat-123").upsertContact({
      workspaceId: DEFAULT_WORKSPACE_ID,
      leadId: "lead_1",
      email: "Maya.Chen@Acme.io",
      name: "Maya Van Chen",
      company: "Acme",
      status: "booked",
      note: "Booked Tuesday",
      qualification: q,
    });
    expect(res).toEqual({ id: "901", created: true, url: null });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer pat-123");
    expect(f.bodyOf(0)).toEqual({
      inputs: [
        {
          idProperty: "email",
          id: "maya.chen@acme.io",
          properties: {
            email: "maya.chen@acme.io",
            firstname: "Maya Van",
            lastname: "Chen",
            company: "Acme",
            hs_lead_status: "CONNECTED",
          },
        },
      ],
    });
    const note = f.bodyOf(1) as { properties: { hs_note_body: string }; associations: unknown[] };
    expect(note.associations).toEqual([
      {
        to: { id: "901" },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
      },
    ]);
    expect(note.properties.hs_note_body).toContain("Score: <strong>86/100</strong>");
    expect(note.properties.hs_note_body).toContain("Authority: <em>unknown</em>");
    expect(note.properties.hs_note_body).toContain("VP Ops &lt;b&gt;with&lt;/b&gt; budget"); // escaped
  });

  it("stops on auth errors without writing a note", async () => {
    const f = mockFetch(() => json(401, { message: "Authentication credentials not found." }));
    await expect(
      new HubSpotCrmAdapter("bad").upsertContact({
        workspaceId: "w",
        leadId: "l",
        email: "a@b.io",
        status: "new",
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("HubSpot error (HTTP 401)"),
    });
    expect(f.calls).toHaveLength(1);
  });

  it("helpers: name splitting and note without qualification", () => {
    expect(splitName("Cher")).toEqual({ firstname: "Cher" });
    expect(splitName(null)).toEqual({});
    expect(qualificationNote(null, "x")).toContain("Not scored yet");
  });
});

describe("Resend adapter (contract)", () => {
  it("sends with reply-to, threading headers and an idempotency key", async () => {
    const f = mockFetch((c) =>
      c.url === "https://api.resend.com/emails" ? json(200, { id: "re_1" }) : undefined,
    );
    const res = await new ResendEmailAdapter("re_key").send({
      from: "Northwind <hi@northwind.io>",
      to: "maya@acme.io",
      replyTo: "reply+t_abc@in.northwind.io",
      subject: "Hello",
      text: "Body",
      messageId: "<em_1@x>",
      inReplyTo: "<orig@mail>",
      idempotencyKey: "key-123",
    });
    expect(res).toEqual({ providerMessageId: "re_1" });
    expect(f.calls[0]!.headers).toMatchObject({
      authorization: "Bearer re_key",
      "idempotency-key": "key-123",
    });
    expect(f.bodyOf(0)).toEqual({
      from: "Northwind <hi@northwind.io>",
      to: ["maya@acme.io"],
      subject: "Hello",
      text: "Body",
      reply_to: "reply+t_abc@in.northwind.io",
      headers: { "In-Reply-To": "<orig@mail>", References: "<orig@mail>" },
    });
  });

  it("fetches received emails by id and accepts sending-only keys in Test connection", async () => {
    const f = mockFetch((c) =>
      c.url.endsWith("/emails/receiving/abc")
        ? json(200, {
            from: "a@b.io",
            to: [],
            subject: "s",
            text: "t",
            html: null,
            headers: {},
            message_id: "<m>",
          })
        : c.url.endsWith("/domains")
          ? json(401, {
              name: "restricted_api_key",
              message: "This API key is restricted to only send emails",
            })
          : undefined,
    );
    const r = new ResendEmailAdapter("re_key");
    await expect(r.getReceivedEmail("abc")).resolves.toMatchObject({ text: "t" });
    await expect(r.testConnection()).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining("sending"),
    });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect((await health("resend"))?.failing).toBe(false);
  });
});

describe("Svix (Resend webhooks)", () => {
  const secret = `whsec_${Buffer.from("super-secret-key").toString("base64")}`;
  const now = new Date("2026-05-01T12:00:00Z");
  const ts = String(now.getTime() / 1000);
  it("verifies valid signatures and rejects tampering / stale timestamps", () => {
    const body = '{"type":"email.received"}';
    const sig = signSvix(secret, "msg_1", ts, body);
    expect(
      verifySvix({
        secret,
        rawBody: body,
        id: "msg_1",
        timestamp: ts,
        signature: `v1,bogus ${sig}`,
        now,
      }),
    ).toBe(true);
    expect(
      verifySvix({ secret, rawBody: `${body} `, id: "msg_1", timestamp: ts, signature: sig, now }),
    ).toBe(false);
    expect(
      verifySvix({ secret, rawBody: body, id: "msg_2", timestamp: ts, signature: sig, now }),
    ).toBe(false);
    expect(
      verifySvix({
        secret,
        rawBody: body,
        id: "msg_1",
        timestamp: ts,
        signature: sig,
        now: new Date(now.getTime() + 600_000),
      }),
    ).toBe(false);
  });
});

describe("adapter selection and fallback", () => {
  const base = { DATABASE_URL: "x" };
  const kinds = (env: Record<string, string>) =>
    selectAdapters(parseEnv({ ...base, ...env })).status;

  it("uses built-in adapters when no integration keys exist", () => {
    expect(kinds({}).map((s) => [s.active, s.external, s.note])).toEqual([
      ["mock", false, null],
      ["internal", false, null],
      ["console", false, null],
    ]);
  });

  it("auto-selects real providers when all their keys exist", () => {
    const s = kinds({
      GOOGLE_CLIENT_ID: "a",
      GOOGLE_CLIENT_SECRET: "b",
      GOOGLE_REFRESH_TOKEN: "c",
      HUBSPOT_ACCESS_TOKEN: "pat",
      RESEND_API_KEY: "re",
      EMAIL_FROM: "Me <me@x.io>",
    });
    expect(s.map((x) => x.active)).toEqual(["google", "hubspot", "resend"]);
    expect(s.every((x) => x.external)).toBe(true);
  });

  it("explicitly requested providers with missing keys fall back with a note naming what's missing", () => {
    const s = kinds({
      CALENDAR_ADAPTER: "google",
      GOOGLE_CLIENT_ID: "a",
      CRM_ADAPTER: "hubspot",
      EMAIL_ADAPTER: "resend",
      RESEND_API_KEY: "re",
    });
    expect(s.map((x) => x.active)).toEqual(["mock", "internal", "console"]);
    expect(s[0]!.note).toContain("GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN");
    expect(s[1]!.note).toContain("HUBSPOT_ACCESS_TOKEN");
    expect(s[2]!.note).toContain("EMAIL_FROM");
  });

  it("honors explicit mock/console choices even when keys exist, and explains Airtable", () => {
    const s = kinds({
      CALENDAR_ADAPTER: "mock",
      GOOGLE_CLIENT_ID: "a",
      GOOGLE_CLIENT_SECRET: "b",
      GOOGLE_REFRESH_TOKEN: "c",
      CRM_ADAPTER: "airtable",
    });
    expect(s[0]!.active).toBe("mock");
    expect(s[1]).toMatchObject({
      active: "internal",
      note: expect.stringContaining("easy to add"),
    });
  });

  it("built-in adapters pass Test connection without network", async () => {
    const f = mockFetch();
    for (const a of [
      new MockCalendarAdapter(),
      new InternalCrmAdapter(),
      new ConsoleEmailAdapter(() => {}),
    ]) {
      await expect(a.testConnection()).resolves.toMatchObject({ ok: true });
    }
    expect(f.calls).toHaveLength(0);
  });
});

describe("runtime failures are errors, never silent mocks", () => {
  it("records a Google 401 as a tool error in the trace and marks the adapter failing", async () => {
    mockFetch((c) =>
      c.url.includes("oauth2")
        ? json(400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          })
        : undefined,
    );
    const lead = await createLead(db);
    const out = await runAgent({
      leadId: lead.id,
      trigger: "inbound",
      db,
      adapters: {
        calendar: new GoogleCalendarAdapter({
          clientId: "a",
          clientSecret: "b",
          refreshToken: "expired",
          calendarId: "primary",
        }),
        crm: new InternalCrmAdapter(),
        email: new ConsoleEmailAdapter(() => {}),
      },
      llm: new FakeLlm([
        { tools: [{ name: "score_lead", input: GOOD_SCORE }] },
        { tools: [{ name: "check_availability", input: {} }] },
        { text: "Calendar unavailable; leaving for a human.", stop: "end_turn" },
      ]),
    });
    expect(out.status).toBe("completed");
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const cal = steps.find((s) => s.toolName === "check_availability")!;
    expect(cal.status).toBe("error");
    expect(cal.output).toMatchObject({
      error: "Google Calendar error (HTTP 400): invalid_grant: Token has been expired or revoked.",
      provider: "google",
      http_status: 400,
    });
    expect(await health("google")).toMatchObject({
      failing: true,
      lastError: expect.stringContaining("expired or revoked"),
    });
  });
});
