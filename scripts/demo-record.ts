/**
 * Records REAL agent runs for the public demo's replay mode.
 *
 *   pnpm demo:record 1 5 16      run the agent on fresh copies of seed leads 1, 5 and 16
 *
 * Each run uses the configured model (a local model via Ollama works — $0). Finished runs are
 * snapshotted into demo/recordings.json (one per seed; re-recording replaces it). Commit that
 * file and deploy: public visitors then watch these replays instead of triggering model calls.
 * The development fake LLM is refused — its runs must never be presented as real.
 */
import "./load-env";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isLlmConfigured, llmLabel } from "../src/lib/env";
import {
  FAKE_LLM_MODEL,
  NotReplayableError,
  parseRecordings,
  upsertRecording,
} from "../src/lib/replay";
import { newId } from "../src/lib/ids";
import { defaultLimits, runAgent } from "../src/server/agent/loop";
import { getDb } from "../src/server/db/client";
import { DEFAULT_WORKSPACE_ID, SEED_LEADS } from "../src/server/db/seed-data";
import { buildRecording } from "../src/server/demo/recordings";
import { getLlm } from "../src/server/llm/anthropic";
import { LlmNotConfiguredError } from "../src/server/llm/types";
import { createInboundLead } from "../src/server/services/intake";

const FILE = path.resolve(__dirname, "../demo/recordings.json");
const CLI_TIME_BUDGET_MS = 180_000;

async function main() {
  const seeds = process.argv.slice(2).map(Number);
  if (!seeds.length || seeds.some((n) => !Number.isInteger(n) || n < 1 || n > SEED_LEADS.length)) {
    throw new Error(`Usage: pnpm demo:record <seed...>  (numbers 1–${SEED_LEADS.length})`);
  }
  if (!isLlmConfigured()) throw new LlmNotConfiguredError();
  const llm = getLlm();
  if (llm.model === FAKE_LLM_MODEL) {
    throw new Error(
      "Refusing to record with DEV_FAKE_LLM: replays are shown as real runs. Configure a real model.",
    );
  }
  const provider = llmLabel();
  const timeBudgetMs = Math.max(CLI_TIME_BUDGET_MS, defaultLimits(llm).timeBudgetMs);
  const db = getDb();
  let recordings = parseRecordings(JSON.parse(readFileSync(FILE, "utf8")));
  console.log(`Recording ${seeds.length} run(s) with ${provider}\n`);

  let saved = 0;
  for (const n of seeds) {
    const seed = SEED_LEADS[n - 1]!;
    // A fresh copy so the recording is a clean first run (not a re-run of an already booked lead).
    const lead = await createInboundLead(db, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      source: "simulated",
      externalId: newId("rec"),
      name: seed.name,
      email: seed.email,
      company: seed.company,
      phone: seed.phone,
      website: seed.website,
      message: seed.message,
      rawPayload: { simulated: true, recordingOf: `seed-${n}` },
    });
    if (!lead) throw new Error(`could not create a copy of seed ${n}`);
    process.stdout.write(`seed ${n} (${seed.name ?? seed.email}) … `);
    const out = await runAgent({
      leadId: lead.id,
      trigger: "simulate",
      llm,
      limits: { timeBudgetMs },
    });
    try {
      const rec = await buildRecording(db, out.runId, { id: `seed-${n}`, provider });
      recordings = upsertRecording(recordings, rec);
      saved++;
      console.log(
        `${out.status} · ${out.steps} steps · ${(out.latencyMs / 1000).toFixed(1)}s → saved as "seed-${n}"`,
      );
    } catch (err) {
      if (!(err instanceof NotReplayableError)) throw err;
      console.log(`not saved: ${err.message}`);
    }
  }

  writeFileSync(FILE, `${JSON.stringify(recordings, null, 2)}\n`);
  console.log(
    `\n${saved}/${seeds.length} saved · demo/recordings.json now has ${recordings.length} recording(s). Commit it to deploy.`,
  );
  if (saved < seeds.length) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => process.exit());
