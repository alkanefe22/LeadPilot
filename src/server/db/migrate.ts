import "../../../scripts/load-env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  await migrate(drizzle(client), {
    migrationsFolder: path.join(process.cwd(), "src/server/db/migrations"),
  });
  await client.end();
  console.log("✔ Database migrated");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
