/**
 * Run the agent on one lead from the terminal and print a readable, live trace.
 *
 *   pnpm agent:run <leadId>          run on a specific lead
 *   pnpm agent:run --seed 16         run on the 16th demo lead (1-based, see seed-data.ts)
 *   pnpm agent:run --list            list leads with their ids
 */
import "./load-env";
import { asc, count, eq } from "drizzle-orm";
import { runAgent, type RunOutcome } from "../src/server/agent/loop";
import { getDb } from "../src/server/db/client";
import { agentRuns, leads, type AgentStep } from "../src/server/db/schema";
import { SEED_LEADS } from "../src/server/db/seed-data";
import { isLlmConfigured, llmLabel } from "../src/lib/env";
import { LlmNotConfiguredError } from "../src/server/llm/types";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2);
const bold = c(1);
const red = c(31);
const green = c(32);
const yellow = c(33);
const blue = c(34);
const magenta = c(35);
const cyan = c(36);

const usd = (n: number) => `$${n.toFixed(4)}`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const num = (n: number) => n.toLocaleString("en-US");

function short(value: unknown, max = 140): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function printStep(step: AgentStep) {
  const n = dim(`#${String(step.idx + 1).padStart(2, "0")}`);
  if (step.type === "llm") {
    const out = (step.output ?? {}) as {
      stop_reason?: string;
      tool_calls?: string[];
      cache_read_tokens?: number;
    };
    const next = out.tool_calls?.length
      ? `→ ${out.tool_calls.join(", ")}`
      : `→ ${out.stop_reason ?? "?"}`;
    const cache = out.cache_read_tokens ? dim(` (${num(out.cache_read_tokens)} cached)`) : "";
    console.log(
      `${n} ${magenta("LLM ")}  ${bold(next.padEnd(38))} ${dim(`${num(step.inputTokens)} in · ${num(step.outputTokens)} out`)}${cache} ${yellow(usd(step.costUsd))} ${dim(ms(step.latencyMs))}`,
    );
    if (step.text) {
      for (const line of step.text.split("\n").filter(Boolean).slice(0, 4)) {
        console.log(`       ${dim("│")} ${dim(short(line, 110))}`);
      }
    }
    return;
  }
  const icon =
    step.status === "ok" ? green("✔") : step.status === "pending_approval" ? yellow("⏸") : red("✘");
  const label = step.status === "pending_approval" ? yellow(" queued for approval") : "";
  console.log(
    `${n} ${cyan("TOOL")}  ${icon} ${bold(step.toolName ?? "?")}${label} ${dim(ms(step.latencyMs))}`,
  );
  console.log(`       ${dim("in ")} ${short(step.input)}`);
  const outColor = step.status === "error" ? red : blue;
  console.log(`       ${dim("out")} ${outColor(short(step.output))}`);
}

function printOutcome(o: RunOutcome) {
  const color = o.status === "completed" ? green : o.status === "awaiting_approval" ? yellow : red;
  console.log(dim("─".repeat(80)));
  console.log(
    `${color(bold(o.status.toUpperCase()))}  ${o.steps} steps · ${num(o.inputTokens)} in / ${num(o.outputTokens)} out tokens · ${yellow(usd(o.costUsd))} · ${ms(o.latencyMs)}`,
  );
  if (o.error) console.log(red(`error: ${o.error}`));
  if (o.summary) console.log(`\n${bold("Agent summary:")} ${o.summary}`);
  console.log(dim(`\nrun id: ${o.runId}`));
}

async function listLeads() {
  const db = getDb();
  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      email: leads.email,
      status: leads.status,
      score: leads.score,
      externalId: leads.externalId,
    })
    .from(leads)
    .orderBy(asc(leads.createdAt));
  for (const r of rows) {
    const seed = r.externalId?.startsWith("seed-")
      ? dim(`[--seed ${r.externalId.slice(5)}]`.padEnd(12))
      : " ".repeat(12);
    console.log(
      `${r.id}  ${seed} ${r.status.padEnd(12)} ${String(r.score ?? "—").padStart(3)}  ${r.name ?? r.email}`,
    );
  }
}

async function resolveLeadId(args: string[]): Promise<string> {
  const seedFlag = args.indexOf("--seed");
  if (seedFlag >= 0) {
    const n = Number(args[seedFlag + 1]);
    if (!Number.isInteger(n) || n < 1 || n > SEED_LEADS.length) {
      throw new Error(`--seed expects a number between 1 and ${SEED_LEADS.length}`);
    }
    const [row] = await getDb()
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.externalId, `seed-${n}`));
    if (!row) throw new Error(`Seed lead ${n} not found — run pnpm db:seed first.`);
    return row.id;
  }
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new Error("Usage: pnpm agent:run <leadId> | --seed <n> | --list");
  return id;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) return listLeads();

  if (!isLlmConfigured()) throw new LlmNotConfiguredError();
  const db = getDb();
  const leadId = await resolveLeadId(args);
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  const [prev] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(eq(agentRuns.leadId, leadId));
  const trigger = (prev?.n ?? 0) > 0 ? "rerun" : "inbound";

  console.log(`${bold("▶ LeadPilot agent")} ${dim(`· ${trigger}`)}`);
  console.log(
    `  lead   ${bold(lead.name ?? lead.email ?? lead.id)} ${dim(`<${lead.email ?? "no email"}> · ${lead.company ?? "—"} · ${lead.id}`)}`,
  );
  console.log(`  model  ${llmLabel()}`);
  console.log(`  says   ${dim(short(lead.message, 160))}`);
  console.log(dim("─".repeat(80)));

  const outcome = await runAgent({ leadId, trigger, onStep: printStep });
  printOutcome(outcome);
  const [after] = await db
    .select({ status: leads.status, score: leads.score })
    .from(leads)
    .where(eq(leads.id, leadId));
  console.log(dim(`lead is now: ${after?.status} · score ${after?.score ?? "—"}`));
  process.exitCode = outcome.status === "failed" ? 1 : 0;
}

main()
  .catch((err: unknown) => {
    if (err instanceof LlmNotConfiguredError) {
      console.error(red(err.message));
      console.error(
        dim(
          "Example (free tier):\n  GEMINI_API_KEY=...\n  GEMINI_MODEL=gemini-3.8-flash\nor:\n  ANTHROPIC_API_KEY=sk-ant-...\n  ANTHROPIC_MODEL=claude-sonnet-5",
        ),
      );
    } else {
      console.error(red(err instanceof Error ? err.message : String(err)));
    }
    process.exitCode = 1;
  })
  .finally(() => process.exit());
