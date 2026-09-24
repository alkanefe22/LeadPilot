import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { setDb, type Database } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import { ensureDefaultWorkspace } from "@/server/db/seed-lib";

/** Fresh in-memory Postgres (PGlite) with all migrations applied, installed as the app DB. */
export async function createTestDb(): Promise<Database> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await migrate(drizzle(client), {
    migrationsFolder: path.resolve(__dirname, "../../src/server/db/migrations"),
  });
  await ensureDefaultWorkspace(db, "whsec_test");
  setDb(db);
  return db;
}
