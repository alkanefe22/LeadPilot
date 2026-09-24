import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

declare global {
  // Survive Next.js dev hot reloads without leaking connections.
  var __leadpilotDb: Database | undefined;
  var __leadpilotDbOverride: Database | undefined;
}

function createDb(url: string): Database {
  const client = postgres(url, {
    // Neon's pooled endpoint (PgBouncer, transaction mode) doesn't support prepared statements.
    prepare: false,
    // PGlite (pnpm db:local) is single-session: set DATABASE_POOL_MAX=1 for it.
    max: Number(process.env.DATABASE_POOL_MAX) || (process.env.NODE_ENV === "production" ? 5 : 10),
    idle_timeout: 20,
    onnotice: () => {},
  });
  return drizzle(client, { schema }) as unknown as Database;
}

/** Returns the process-wide database. Tests/evals can swap it for PGlite via `setDb`. */
export function getDb(): Database {
  if (globalThis.__leadpilotDbOverride) return globalThis.__leadpilotDbOverride;
  if (!globalThis.__leadpilotDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
    globalThis.__leadpilotDb = createDb(url);
  }
  return globalThis.__leadpilotDb;
}

export function setDb(db: Database | undefined) {
  globalThis.__leadpilotDbOverride = db;
}

export { schema };
