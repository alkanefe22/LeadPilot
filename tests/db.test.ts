import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { leads, messages } from "@/server/db/schema";
import { SEED_LEADS } from "@/server/db/seed-data";
import { seedLeads } from "@/server/db/seed-lib";
import { createTestDb } from "./helpers/db";

describe("database schema + seed", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  it("seeds every demo lead with an inbound message each, idempotently", async () => {
    const first = await seedLeads(db);
    const second = await seedLeads(db);
    expect(first).toHaveLength(SEED_LEADS.length);
    expect(second).toHaveLength(0);
    const all = await db.select().from(leads);
    expect(all).toHaveLength(SEED_LEADS.length);
    expect(all.every((l) => l.status === "new" && l.id.startsWith("lead_"))).toBe(true);
    const msgs = await db.select().from(messages).where(eq(messages.leadId, all[0]!.id));
    expect(msgs).toHaveLength(1);
  });
});
