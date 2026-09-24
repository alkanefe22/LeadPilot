import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, passwordMatches, verifySessionToken } from "@/lib/session";
import { runAgent } from "@/server/agent/loop";
import { sweepStaleRuns } from "@/server/agent/runs";
import type { Database } from "@/server/db/client";
import { agentRuns, leads } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID, SEED_LEADS } from "@/server/db/seed-data";
import { rateLimit } from "@/server/security/rate-limit";
import { getDemoBudget } from "@/server/services/demo-budget";
import { createInboundLead, isDemoLead } from "@/server/services/intake";
import { generateLead } from "@/server/services/simulator";
import { FakeLlm } from "./helpers/fake-llm";
import { createLead, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

let db: Database;
beforeAll(async () => {
  db = await createTestDb();
});

describe("intake", () => {
  it("sanitizes fields and flags injection attempts immediately with the matched patterns", async () => {
    const adversarial = SEED_LEADS.find((l) => l.kind === "adversarial")!;
    const lead = await createInboundLead(db, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: "form",
      externalId: "intake-1",
      name: "  <b>Jake</b> ",
      email: "Jake <JAKE@Example.com>",
      message: adversarial.message,
    });
    expect(lead).toMatchObject({
      name: "Jake",
      email: "jake@example.com",
      riskFlags: ["prompt_injection"],
    });
    expect(lead!.riskMatches).toContain("ignore_instructions");
  });

  it("does not flag the benign look-alike leads", async () => {
    for (const [i, l] of SEED_LEADS.filter((s) => s.kind === "lookalike").entries()) {
      const lead = await createInboundLead(db, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        source: l.source,
        externalId: `look-${i}`,
        message: l.message,
      });
      expect(lead!.riskFlags).toEqual([]);
    }
  });

  it("dedupes on (source, externalId)", async () => {
    const input = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: "webhook" as const,
      externalId: "dup-1",
      message: "hello there",
    };
    expect(await createInboundLead(db, input)).not.toBeNull();
    expect(await createInboundLead(db, input)).toBeNull();
  });

  it("recognizes demo leads that must never reach real providers", () => {
    expect(isDemoLead({ source: "simulated", externalId: null, rawPayload: null })).toBe(true);
    expect(isDemoLead({ source: "form", externalId: "seed-3", rawPayload: null })).toBe(true);
    expect(isDemoLead({ source: "webhook", externalId: "n8n-123", rawPayload: {} })).toBe(false);
  });
});

describe("cleared flags", () => {
  it("does not re-flag content an admin already reviewed, but scans new replies", async () => {
    const adversarial = SEED_LEADS.find((l) => l.kind === "adversarial")!;
    const lead = await createLead(db, { message: adversarial.message });
    await db
      .update(leads)
      .set({ riskFlags: [], riskMatches: [], riskReviewedAt: new Date() })
      .where(eq(leads.id, lead.id));
    await runAgent({
      leadId: lead.id,
      trigger: "rerun",
      llm: new FakeLlm([{ text: "ok", stop: "end_turn" }]),
      adapters: testAdapters(),
      db,
    });
    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after!.riskFlags).toEqual([]);
  });
});

describe("demo budget", () => {
  it("counts today's simulate runs and cost against the global limits", async () => {
    const opts = {
      workspaceId: DEFAULT_WORKSPACE_ID,
      runLimit: 2,
      costLimit: 0.05,
      videoUrl: "https://example.com/v",
    };
    const before = await getDemoBudget(db, opts);
    const lead = await createLead(db);
    await db
      .insert(agentRuns)
      .values({
        leadId: lead.id,
        trigger: "simulate",
        model: "t",
        status: "completed",
        costUsd: 0.03,
      });
    const lead2 = await createLead(db);
    await db
      .insert(agentRuns)
      .values({ leadId: lead2.id, trigger: "rerun", model: "t", status: "completed", costUsd: 5 });
    const after = await getDemoBudget(db, opts);
    expect(after.runsToday).toBe(before.runsToday + 1); // rerun doesn't count
    expect(after.costToday).toBeCloseTo(before.costToday + 0.03, 6);
    const lead3 = await createLead(db);
    await db
      .insert(agentRuns)
      .values({
        leadId: lead3.id,
        trigger: "simulate",
        model: "t",
        status: "completed",
        costUsd: 0.03,
      });
    const limited = await getDemoBudget(db, opts);
    expect(limited.limitReached).toBe(true);
    expect(limited.videoUrl).toBe("https://example.com/v");
  });

  it("ignores runs from previous UTC days", async () => {
    const opts = { workspaceId: DEFAULT_WORKSPACE_ID, runLimit: 100, costLimit: 100 };
    const before = await getDemoBudget(db, opts);
    const lead = await createLead(db);
    await db.insert(agentRuns).values({
      leadId: lead.id,
      trigger: "simulate",
      model: "t",
      status: "completed",
      costUsd: 1,
      startedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    await sweepStaleRuns(db);
    expect((await getDemoBudget(db, opts)).runsToday).toBe(before.runsToday);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then blocks until the next window", async () => {
    const t = new Date("2026-01-01T00:00:10Z");
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rateLimit(db, "test:ip", 3, 60, t)).ok);
    expect(results).toEqual([true, true, true, false]);
    expect((await rateLimit(db, "test:ip", 3, 60, new Date("2026-01-01T00:01:05Z"))).ok).toBe(true);
    expect((await rateLimit(db, "other:ip", 3, 60, t)).ok).toBe(true);
  });
});

describe("simulator", () => {
  it("generates varied, realistic leads on reserved .example domains", () => {
    let seed = 42;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const leadsOut = Array.from({ length: 200 }, () => generateLead(rng));
    const profiles = new Set(leadsOut.map((l) => l.profile));
    expect(profiles).toEqual(new Set(["fit", "needs_info", "poor_fit", "spam", "fit_non_english"]));
    for (const l of leadsOut) {
      expect(l.email).toMatch(/^[a-z]+\.[a-z]+@[a-z0-9]+\.example$/);
      expect(l.message.length).toBeGreaterThan(40);
    }
  });
});

describe("admin session", () => {
  it("signs and verifies tokens; rejects tampering and wrong passwords", async () => {
    process.env.ADMIN_PASSWORD = "s3cret-pass";
    process.env.SESSION_SECRET = "x".repeat(40);
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
    expect(await verifySessionToken(`${token.slice(0, -2)}xx`)).toBe(false);
    expect(await verifySessionToken(undefined)).toBe(false);
    expect(await passwordMatches("s3cret-pass")).toBe(true);
    expect(await passwordMatches("s3cret-pas")).toBe(false);
    process.env.SESSION_SECRET = "y".repeat(40); // rotating the secret logs everyone out
    expect(await verifySessionToken(token)).toBe(false);
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
  });
});
