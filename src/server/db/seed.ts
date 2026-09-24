import "../../../scripts/load-env";
import { getDb } from "./client";
import { ensureDefaultWorkspace, resetDatabase, seedLeads } from "./seed-lib";

async function main() {
  const db = getDb();
  if (process.argv.includes("--reset")) {
    await resetDatabase(db);
    console.log("✔ Database reset");
  }
  const ws = await ensureDefaultWorkspace(db, process.env.WEBHOOK_SECRET || undefined);
  const ids = await seedLeads(db, ws);
  console.log(`✔ Workspace "${ws}" ready, ${ids.length} demo leads inserted`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
