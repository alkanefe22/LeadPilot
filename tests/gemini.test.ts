import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { llmLabel, parseEnv, resolveLlmProvider } from "@/lib/env";
import { setProviderBackoff } from "@/server/adapters/http";
import { runAgent } from "@/server/agent/loop";
import { anthropicTools } from "@/server/agent/tools";
import type { Database } from "@/server/db/client";
import { adapterHealth, agentRuns, agentSteps } from "@/server/db/schema";
import { GeminiClient, toGeminiSchema } from "@/server/llm/gemini";
import { costOf, priceFor } from "@/server/llm/pricing";
import { ThrottledLlm } from "@/server/llm/throttle";
import type { LlmClient } from "@/server/llm/types";
import { createLead, GOOD_SCORE, testAdapters } from "./helpers/fixtures";
import { createTestDb } from "./helpers/db";
import { json, mockFetch, sequence, type Call } from "./helpers/mock-fetch";

const MODEL = "gemini-3.8-flash";
const URL_ = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const isGen = (c: Call) => c.url === URL_;

const reply = (parts: unknown[], extra: Record<string, unknown> = {}) =>
  json(200, {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1200,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 40,
      cachedContentTokenCount: 200,
    },
    ...extra,
  });

let db: Database;
beforeAll(async () => {
  db = await createTestDb();
  setProviderBackoff(0);
});
afterEach(() => vi.unstubAllGlobals());

const client = (opts = {}) =>
  new GeminiClient(MODEL, "AIza-test", { billingTier: "free", maxRetryDelayMs: 0, ...opts });
const run = (llm: LlmClient, leadId: string) =>
  runAgent({ leadId, trigger: "inbound", llm, adapters: testAdapters(), db });

describe("tool schema mapping", () => {
  it("keeps the supported JSON Schema subset and drops pattern/default/$schema/additionalProperties", () => {
    const decls = anthropicTools().map((t) => toGeminiSchema(t.input_schema));
    const text = JSON.stringify(decls);
    for (const banned of ['"pattern"', '"default"', '"$schema"', '"additionalProperties"'])
      expect(text).not.toContain(banned);
    const score = toGeminiSchema(
      anthropicTools().find((t) => t.name === "score_lead")!.input_schema,
    ) as {
      properties: Record<string, { enum?: string[]; anyOf?: unknown[]; minimum?: number }>;
    };
    expect(score.properties.category!.enum).toEqual(["fit", "needs_info", "poor_fit", "spam"]);
    expect(score.properties.budget!.anyOf).toEqual([
      { type: "string", maxLength: 200 },
      { type: "null" },
    ]);
    expect(score.properties.score!.minimum).toBe(0);
    expect(toGeminiSchema({ const: "x", additionalProperties: false })).toEqual({ enum: ["x"] });
  });
});

describe("GeminiClient in the agent loop (fake responses)", () => {
  it("tool call → result → parallel calls → final answer, replaying thought signatures verbatim", async () => {
    const first = [
      {
        functionCall: { id: "fc1", name: "score_lead", args: GOOD_SCORE },
        thoughtSignature: "sigA",
      },
    ];
    const second = [
      { text: "Checking the calendar and updating the CRM." },
      {
        functionCall: { id: "fc2", name: "check_availability", args: { days_ahead: 5 } },
        thoughtSignature: "sigB",
      },
      { functionCall: { id: "fc3", name: "upsert_crm_contact", args: { status: "qualified" } } },
    ];
    const f = mockFetch(
      sequence(
        isGen,
        () => reply(first),
        () => reply(second),
        () =>
          reply([
            { thought: true, text: "internal summary" },
            { text: "Qualified; slots checked." },
          ]),
      ),
    );
    const lead = await createLead(db);
    const out = await run(client(), lead.id);
    expect(out).toMatchObject({ status: "completed", summary: "Qualified; slots checked." });

    // Request 1: auth header, system instruction, tools, first user turn with the fenced lead.
    const r1 = f.bodyOf(0) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text?: string }[] }[];
      tools: { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[];
      toolConfig: unknown;
      generationConfig: { maxOutputTokens: number };
    };
    expect(f.calls[0]!.headers["x-goog-api-key"]).toBe("AIza-test");
    expect(f.calls[0]!.url).toBe(URL_);
    expect(r1.systemInstruction.parts[0]!.text).toContain("untrusted data");
    expect(r1.contents).toHaveLength(1);
    expect(r1.contents[0]!.parts[0]!.text).toContain("<lead_content");
    expect(r1.tools[0]!.functionDeclarations.map((d) => d.name)).toContain("book_meeting");
    expect(r1.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(r1.generationConfig.maxOutputTokens).toBeGreaterThan(0);

    // Request 2: the model turn is replayed exactly (signature intact), then the function response.
    const r2 = f.bodyOf(1) as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    expect(r2.contents[1]).toEqual({ role: "model", parts: first });
    expect(r2.contents[2]!.role).toBe("user");
    expect(r2.contents[2]!.parts[0]).toMatchObject({
      functionResponse: {
        id: "fc1",
        name: "score_lead",
        response: { saved: true, qualifies: true },
      },
    });

    // Request 3: parallel calls replayed in order (signature only on the first), results in order.
    const r3 = f.bodyOf(2) as {
      contents: { role: string; parts: { functionResponse?: { id: string; name: string } }[] }[];
    };
    expect(r3.contents[3]).toEqual({ role: "model", parts: second });
    expect(
      r3.contents[4]!.parts.map((p) => [p.functionResponse!.id, p.functionResponse!.name]),
    ).toEqual([
      ["fc2", "check_availability"],
      ["fc3", "upsert_crm_contact"],
    ]);

    // Trace: tokens per step like Anthropic (1000 uncached + 200 cached in; 80 + 40 thinking out).
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    const llmSteps = steps.filter((s) => s.type === "llm");
    expect(llmSteps).toHaveLength(3);
    expect(llmSteps[0]).toMatchObject({ inputTokens: 1200, outputTokens: 120 });
    expect(llmSteps[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(steps.filter((s) => s.type === "tool").map((s) => s.toolName)).toEqual([
      "score_lead",
      "check_availability",
      "upsert_crm_contact",
    ]);
    // Cost: estimate at paid rates, run marked as free tier.
    const expected = costOf(
      {
        input_tokens: 1000,
        output_tokens: 120,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
      },
      priceFor(MODEL),
    );
    expect(llmSteps[0]!.costUsd).toBeCloseTo(expected, 6);
    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(runRow).toMatchObject({ billingTier: "free", model: MODEL });
  });

  it("generates ids for id-less calls, sends their results without an id, and marks tool errors", async () => {
    const f = mockFetch(
      sequence(
        isGen,
        () =>
          reply([{ functionCall: { name: "score_lead", args: { ...GOOD_SCORE, score: 500 } } }]),
        () => reply([{ text: "Stopping." }]),
      ),
    );
    const out = await run(client(), (await createLead(db)).id);
    expect(out.status).toBe("completed");
    const r2 = f.bodyOf(1) as {
      contents: { parts: { functionResponse?: Record<string, unknown> }[] }[];
    };
    const fr = r2.contents[2]!.parts[0]!.functionResponse!;
    expect(fr.id).toBeUndefined();
    expect(fr).toMatchObject({
      name: "score_lead",
      response: { error: { error: "Invalid input" } },
    });
  });

  it("maps finish reasons: MAX_TOKENS, SAFETY, blocked prompts and malformed calls", async () => {
    const cases: [Response, RegExp][] = [
      [
        json(200, {
          candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
        }),
        /LLM_MAX_TOKENS/,
      ],
      [json(200, { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }), /refusal/],
      [json(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }), /refusal/],
      [
        json(200, {
          candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }],
        }),
        /Gemini error: model produced an invalid function call \(MALFORMED_FUNCTION_CALL\)/,
      ],
    ];
    for (const [response, error] of cases) {
      mockFetch(() => response.clone());
      const out = await run(client(), (await createLead(db)).id);
      expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(error) });
    }
  });
});

describe("rate limits (429)", () => {
  const exhausted = () =>
    json(429, {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" }],
      },
    });

  it("backs off and retries, then succeeds", async () => {
    const f = mockFetch(sequence(isGen, exhausted, () => reply([{ text: "ok" }])));
    const out = await run(client(), (await createLead(db)).id);
    expect(out.status).toBe("completed");
    expect(f.calls).toHaveLength(2);
  });

  it("fails the run with a clear error after the retries are exhausted and marks Gemini failing", async () => {
    const f = mockFetch(exhausted);
    const out = await run(client({ retries: 2 }), (await createLead(db)).id);
    expect(f.calls).toHaveLength(3);
    expect(out.status).toBe("failed");
    expect(out.error).toBe(
      "Gemini error (HTTP 429): RESOURCE_EXHAUSTED: You exceeded your current quota.",
    );
    const [h] = await db.select().from(adapterHealth).where(eq(adapterHealth.provider, "gemini"));
    expect(h).toMatchObject({ failing: true });
  });
});

describe("provider selection", () => {
  const base = { DATABASE_URL: "x" };
  const pick = (e: Record<string, string>) => resolveLlmProvider(parseEnv({ ...base, ...e }));

  it("defaults to Gemini when only GEMINI_API_KEY (+ model) is set", () => {
    expect(pick({ GEMINI_API_KEY: "g", GEMINI_MODEL: MODEL })).toBe("gemini");
    expect(llmLabel(parseEnv({ ...base, GEMINI_API_KEY: "g", GEMINI_MODEL: MODEL }))).toBe(
      `Gemini · ${MODEL} (free tier)`,
    );
  });

  it("keeps Anthropic as the default when both are configured, unless LLM_PROVIDER says otherwise", () => {
    const both = {
      GEMINI_API_KEY: "g",
      GEMINI_MODEL: MODEL,
      ANTHROPIC_API_KEY: "a",
      ANTHROPIC_MODEL: "claude-sonnet-5",
    };
    expect(pick(both)).toBe("anthropic");
    expect(pick({ ...both, LLM_PROVIDER: "gemini" })).toBe("gemini");
  });

  it("returns null when the selected provider lacks a key or model", () => {
    expect(pick({})).toBeNull();
    expect(pick({ GEMINI_API_KEY: "g" })).toBeNull();
    expect(
      pick({ LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "m" }),
    ).toBeNull();
    expect(() => parseEnv({ ...base, LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER/);
  });

  it("prices Gemini models by longest prefix and honors overrides", () => {
    expect(priceFor("gemini-3.5-flash-lite")).toMatchObject({
      input: 0.3,
      output: 2.5,
      known: true,
    });
    expect(priceFor("gemini-3.5-flash")).toMatchObject({ input: 1.5, output: 9 });
    expect(priceFor("gemini-2.5-flash-lite")).toMatchObject({ input: 0.1, output: 0.4 });
    expect(priceFor("gemini-9-experimental", { input: 0.2, output: 0.8 })).toMatchObject({
      input: 0.2,
      output: 0.8,
    });
  });
});

describe("ThrottledLlm (eval pacing)", () => {
  it("spaces calls at least minIntervalMs apart, even when issued concurrently", async () => {
    let t = 0;
    const waits: number[] = [];
    const inner: LlmClient = {
      model: "m",
      create: async () => ({
        model: "m",
        content: [],
        stop_reason: "end_turn",
        usage: {} as never,
      }),
    };
    const llm = new ThrottledLlm(
      inner,
      1000,
      async (ms) => {
        waits.push(ms);
      },
      () => t,
    );
    const req = { system: "", messages: [], tools: [], maxTokens: 1 };
    await Promise.all([llm.create(req), llm.create(req), llm.create(req)]);
    expect(waits).toEqual([1000, 2000]);
    t = 5000;
    await llm.create(req);
    expect(waits).toHaveLength(2); // enough time passed, no wait
  });
});
