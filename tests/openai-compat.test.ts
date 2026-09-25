import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isLocalBaseUrl, llmLabel, parseEnv, resolveLlmProvider } from "@/lib/env";
import { setProviderBackoff } from "@/server/adapters/http";
import { defaultLimits, runAgent } from "@/server/agent/loop";
import type { Database } from "@/server/db/client";
import { adapterHealth, agentRuns, agentSteps } from "@/server/db/schema";
import { OpenAiCompatClient } from "@/server/llm/openai-compat";
import type { LlmClient } from "@/server/llm/types";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";
import { json, mockFetch, sequence, type Call } from "./helpers/mock-fetch";

const BASE = "http://localhost:11434/v1";
const MODEL = "qwen3.5:9b";
const isChat = (c: Call) => c.url === `${BASE}/chat/completions`;

type ToolCallSpec = { id?: string; name: string; args: unknown };
const reply = (opts: { text?: string; calls?: ToolCallSpec[]; finish?: string }) =>
  json(200, {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: opts.finish ?? (opts.calls?.length ? "tool_calls" : "stop"),
        message: {
          role: "assistant",
          content: opts.text ?? "",
          ...(opts.calls
            ? {
                tool_calls: opts.calls.map((c) => ({
                  ...(c.id ? { id: c.id } : {}),
                  type: "function",
                  function: {
                    name: c.name,
                    arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
                  },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 },
  });

let db: Database;
beforeAll(async () => {
  db = await createTestDb();
  setProviderBackoff(0);
});
afterEach(() => vi.unstubAllGlobals());

const local = () => new OpenAiCompatClient(MODEL, BASE, { billingTier: "local" });
const run = (llm: LlmClient, leadId: string) =>
  runAgent({ leadId, trigger: "inbound", llm, adapters: testAdapters(), db });

type Body = {
  model: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  tool_choice?: unknown;
  tools: { type: string; function: { name: string; parameters: Record<string, unknown> } }[];
  messages: {
    role: string;
    content: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
};

describe("OpenAI-compatible client in the agent loop (fake responses)", () => {
  it("maps tools, tool calls and results; records tokens/latency; costs $0 on localhost", async () => {
    const f = mockFetch(
      sequence(
        isChat,
        () => reply({ calls: [{ id: "call_1", name: "score_lead", args: GOOD_SCORE }] }),
        () =>
          reply({
            text: "Checking slots and updating the CRM.",
            calls: [
              { id: "call_2", name: "check_availability", args: { days_ahead: 5 } },
              { id: "call_3", name: "upsert_crm_contact", args: { status: "qualified" } },
            ],
          }),
        () => reply({ text: "Qualified; slots checked." }),
      ),
    );
    const out = await run(local(), (await createLead(db)).id);
    expect(out).toMatchObject({ status: "completed", summary: "Qualified; slots checked." });

    const r1 = f.bodyOf(0) as Body;
    expect(f.calls[0]!.headers.authorization).toBeUndefined(); // Ollama needs no key
    expect(r1.model).toBe(MODEL);
    expect(r1.max_tokens).toBeGreaterThan(0);
    expect(r1.tool_choice).toBeUndefined(); // not supported by every server; "auto" is default
    expect(r1.messages[0]).toMatchObject({ role: "system" });
    expect(r1.messages[0]!.content).toContain("untrusted data");
    expect(r1.messages[1]).toMatchObject({ role: "user" });
    expect(r1.messages[1]!.content).toContain("<lead_content");
    const book = r1.tools.find((t) => t.function.name === "book_meeting")!;
    expect(book.type).toBe("function");
    expect(book.function.parameters).toMatchObject({ type: "object" });
    expect(book.function.parameters.$schema).toBeUndefined();

    // Turn 2: assistant tool_calls replayed with JSON-string arguments, then a tool message.
    const r2 = f.bodyOf(1) as Body;
    expect(r2.messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", function: { name: "score_lead" } }],
    });
    expect(JSON.parse(r2.messages[2]!.tool_calls![0]!.function.arguments)).toMatchObject({
      score: GOOD_SCORE.score,
    });
    expect(r2.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(JSON.parse(r2.messages[3]!.content!)).toMatchObject({ saved: true });

    // Turn 3: parallel calls → one tool message each, in order, right after the assistant turn.
    const r3 = f.bodyOf(2) as Body;
    expect(r3.messages[4]).toMatchObject({
      role: "assistant",
      content: "Checking slots and updating the CRM.",
    });
    expect(r3.messages.slice(5).map((m) => [m.role, m.tool_call_id])).toEqual([
      ["tool", "call_2"],
      ["tool", "call_3"],
    ]);

    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const llmSteps = steps.filter((s) => s.type === "llm");
    // 3 scripted turns + 1 after the nudge (the scripted run never finishes the procedure).
    expect(llmSteps).toHaveLength(4);
    expect(llmSteps[0]).toMatchObject({ inputTokens: 900, outputTokens: 60, costUsd: 0 });
    expect(llmSteps[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(row).toMatchObject({ billingTier: "local", costUsd: 0, model: MODEL });
  });

  it("returns invalid tool arguments to the model as errors so it can retry", async () => {
    const f = mockFetch(
      sequence(
        isChat,
        // 1) not JSON at all, 2) JSON but fails the Zod schema, 3) corrected call, 4) done
        () => reply({ calls: [{ id: "c1", name: "score_lead", args: "{score: 88, oops" }] }),
        () => reply({ calls: [{ id: "c2", name: "score_lead", args: { score: "high" } }] }),
        () => reply({ calls: [{ id: "c3", name: "score_lead", args: GOOD_SCORE }] }),
        () => reply({ text: "Scored." }),
      ),
    );
    const out = await run(local(), (await createLead(db)).id);
    expect(out.status).toBe("completed");

    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const tools = steps.filter((s) => s.type === "tool");
    expect(tools.map((s) => s.status)).toEqual(["error", "error", "ok"]);
    expect(tools[0]!.output).toMatchObject({
      error: "Invalid input: the arguments are not a valid JSON object.",
      received: "{score: 88, oops",
    });
    expect(tools[1]!.output).toMatchObject({ error: "Invalid input" });

    // The model sees its raw (broken) arguments and an error tool message.
    const r2 = f.bodyOf(1) as Body;
    expect(r2.messages[2]!.tool_calls![0]!.function.arguments).toBe("{score: 88, oops");
    expect(r2.messages[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(JSON.parse(r2.messages[3]!.content!).error).toMatchObject({
      error: expect.stringContaining("not a valid JSON object"),
    });
  });

  it("generates ids for id-less calls and maps finish reasons", async () => {
    const f = mockFetch(
      sequence(
        isChat,
        () => reply({ calls: [{ name: "score_lead", args: GOOD_SCORE }] }),
        () => reply({ text: "cut off", finish: "length" }),
      ),
    );
    const out = await run(local(), (await createLead(db)).id);
    const r2 = f.bodyOf(1) as Body;
    const id = r2.messages[2]!.tool_calls![0]!.id;
    expect(id).toMatch(/^call_gen_/);
    expect(r2.messages[3]!.tool_call_id).toBe(id);
    expect(out).toMatchObject({
      status: "failed",
      error: expect.stringContaining("LLM_MAX_TOKENS"),
    });
  });

  it("sends the bearer key and max_completion_tokens to api.openai.com, priced by override", async () => {
    const f = mockFetch((c) =>
      c.url === "https://api.openai.com/v1/chat/completions" ? reply({ text: "Done." }) : undefined,
    );
    const llm = new OpenAiCompatClient("gpt-test", "https://api.openai.com/v1/", {
      apiKey: "sk-test",
      priceOverride: { input: 1, output: 2 },
    });
    const out = await run(llm, (await createLead(db)).id);
    expect(out.status).toBe("completed");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer sk-test");
    const body = f.bodyOf(0) as Body;
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeUndefined();
    // Text-only answer + the one nudge = 2 calls, each 900 in × $1/M + 60 out × $2/M.
    expect(f.calls).toHaveLength(2);
    expect(out.costUsd).toBeCloseTo(0.00204, 6);
  });

  it("surfaces server errors in the trace and marks the provider failing", async () => {
    mockFetch((c) =>
      isChat(c) ? json(404, { error: { message: 'model "qwen9:1b" not found' } }) : undefined,
    );
    const out = await run(local(), (await createLead(db)).id);
    expect(out).toMatchObject({
      status: "failed",
      error: 'OpenAI-compatible API error (HTTP 404): model "qwen9:1b" not found',
    });
    const [h] = await db
      .select()
      .from(adapterHealth)
      .where(eq(adapterHealth.provider, "openai-compatible"));
    expect(h).toMatchObject({ failing: true });
  });
});

describe("OpenAI-compatible configuration", () => {
  const base = { DATABASE_URL: "x" };

  it("is selected with just a model (key optional), defaulting to local Ollama", () => {
    const e = parseEnv({ ...base, OPENAI_COMPAT_MODEL: MODEL });
    expect(resolveLlmProvider(e)).toBe("openai-compatible");
    expect(e.OPENAI_COMPAT_BASE_URL).toBe("http://localhost:11434/v1");
    expect(llmLabel(e)).toBe(`OpenAI-compatible · ${MODEL} (local, localhost:11434)`);
  });

  it("loses to Anthropic/Gemini by default, wins when LLM_PROVIDER selects it", () => {
    const both = {
      ...base,
      GEMINI_API_KEY: "k",
      GEMINI_MODEL: "gemini-3.6-flash",
      OPENAI_COMPAT_MODEL: MODEL,
    };
    expect(resolveLlmProvider(parseEnv(both))).toBe("gemini");
    expect(resolveLlmProvider(parseEnv({ ...both, LLM_PROVIDER: "openai-compatible" }))).toBe(
      "openai-compatible",
    );
  });

  it("detects local base URLs", () => {
    for (const u of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:11434/v1",
      "http://host.docker.internal:11434/v1",
    ]) {
      expect(isLocalBaseUrl(u)).toBe(true);
    }
    for (const u of ["https://api.groq.com/openai/v1", "https://openrouter.ai/api/v1"]) {
      expect(isLocalBaseUrl(u)).toBe(false);
    }
  });

  it("gives local models the longer LOCAL_RUN_TIME_BUDGET_MS", () => {
    expect(defaultLimits({ billingTier: "local" }).timeBudgetMs).toBe(300_000);
    expect(defaultLimits({ billingTier: "paid" }).timeBudgetMs).toBe(50_000);
  });
});
