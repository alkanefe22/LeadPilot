import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/db/client";
import { leads, messages } from "@/server/db/schema";
import { seedLeads } from "@/server/db/seed-lib";
import { createTestDb } from "./helpers/db";

describe("database schema + seed", () => {
  let db: Database;
  beforeAll(async () => {
    db = await createTestDb();
  });

  it("seeds 15 leads with an inbound message each, idempotently", async () => {
    const first = await seedLeads(db);
    const second = await seedLeads(db);
    expect(first).toHaveLength(15);
    expect(second).toHaveLength(0);
    const all = await db.select().from(leads);
    expect(all).toHaveLength(15);
    expect(all.every((l) => l.status === "new" && l.id.startsWith("lead_"))).toBe(true);
    const msgs = await db.select().from(messages).where(eq(messages.leadId, all[0]!.id));
    expect(msgs).toHaveLength(1);
  });
});
