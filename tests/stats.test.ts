import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { agentRuns, leads } from "@/server/db/schema";
import { DEFAULT_WORKSPACE_ID } from "@/server/db/seed-data";
import { getOverviewStats } from "@/server/services/stats";
import { createLead } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";

describe("overview KPIs", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  it("measures time to first response from the first agent run, not from (seeded) lead creation", async () => {
    const now = Date.now();
    // A seeded lead "received" 3 hours ago, processed by the agent just now in 5s.
    const seeded = await createLead(db, { createdAt: new Date(now - 3 * 3_600_000) });
    await db
      .insert(agentRuns)
      .values({
        leadId: seeded.id,
        trigger: "rerun",
        model: "t",
        status: "completed",
        startedAt: new Date(now - 10_000),
      });
    await db
      .insert(agentRuns)
      .values({
        leadId: seeded.id,
        trigger: "rerun",
        model: "t",
        status: "completed",
        startedAt: new Date(now - 2_000),
      });
    await db
      .update(leads)
      .set({ firstResponseAt: new Date(now - 5_000) })
      .where(eq(leads.id, seeded.id));

    // A live lead: received and answered 3s later (its run started at receipt).
    const live = await createLead(db, { createdAt: new Date(now - 60_000) });
    await db
      .insert(agentRuns)
      .values({
        leadId: live.id,
        trigger: "inbound",
        model: "t",
        status: "completed",
        startedAt: new Date(now - 60_000),
      });
    await db
      .update(leads)
      .set({ firstResponseAt: new Date(now - 57_000) })
      .where(eq(leads.id, live.id));

    // A lead that never got an email doesn't count.
    await createLead(db);

    const s = await getOverviewStats(DEFAULT_WORKSPACE_ID);
    expect(s.respondedLeads).toBe(2);
    expect(s.avgFirstResponseMs).toBeCloseTo((5_000 + 3_000) / 2, -1);
  });
});
