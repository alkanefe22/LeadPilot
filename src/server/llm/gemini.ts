import type Anthropic from "@anthropic-ai/sdk";
import { ProviderError, providerFetch } from "../adapters/http";
import type { LlmClient, LlmRequest, LlmResponse } from "./types";

/**
 * Google Gemini via the stateless REST `models.generateContent` API
 * (https://ai.google.dev/api/generate-content), implementing the same LlmClient contract as
 * Claude so the agent loop, trace, guardrails and tests stay provider-agnostic.
 *
 * The loop speaks Anthropic message shapes; this client translates both ways:
 *   system                 → systemInstruction
 *   tools (JSON Schema)    → tools[].functionDeclarations[].parametersJsonSchema
 *   assistant tool_use     → model part { functionCall: { id, name, args } }
 *   user tool_result       → user part  { functionResponse: { id, name, response } }
 *   response functionCall  → tool_use block (stop_reason "tool_use")
 *
 * Thought signatures: Gemini 3 rejects follow-up requests whose functionCall parts lost their
 * `thoughtSignature`, and parallel calls carry it only on the first part. We therefore keep the
 * raw model parts of every response (keyed by the content array the loop appends to history)
 * and replay them verbatim — same parts, same order, same signatures.
 */

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type GenerateContentResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
};

const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** Documented escape hatch for function calls whose original signature is unavailable. */
const SKIP_SIGNATURE = "skip_thought_signature_validator";
const GENERATED_ID = "gemini_gen_";

const REFUSAL_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

// JSON Schema keywords we forward; everything else (pattern, default, $schema,
// additionalProperties — reported to cause MALFORMED_FUNCTION_CALL) is dropped.
const SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "anyOf",
  "format",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "title",
  "nullable",
]);

export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([name, s]) => [name, toGeminiSchema(s)]),
      );
    } else if (k === "const") {
      out.enum = [v];
    } else if (SCHEMA_KEYS.has(k)) {
      out[k] = k === "items" || k === "anyOf" ? toGeminiSchema(v) : v;
    }
  }
  return out;
}

export type GeminiThinking = "minimal" | "low" | "medium" | "high" | "default";

/**
 * thinkingConfig for a model (ai.google.dev/gemini-api/docs/generate-content/thinking):
 * Gemini 3 uses `thinkingLevel`; "minimal" is only accepted by 3.6/3.5 Flash and Flash-Lite,
 * so for 3.8/3.7 Flash and Pro the lowest valid level is "low". Thinking can't be fully
 * disabled on Gemini 3. Other families (e.g. 2.5, which uses thinkingBudget) get nothing.
 */
export function thinkingConfigFor(model: string, level: GeminiThinking) {
  if (level === "default" || !/^gemini-3/.test(model)) return undefined;
  const supportsMinimal = /flash-lite/.test(model) || /^gemini-3\.[56]-flash/.test(model);
  const thinkingLevel = level === "minimal" && !supportsMinimal ? "low" : level;
  return { thinkingLevel };
}

export type GeminiOptions = {
  billingTier?: "free" | "paid";
  /** Tried in order when a model answers 503 (overloaded) or its daily quota is exhausted. */
  fallbackModels?: string[];
  thinking?: GeminiThinking;
  priceOverride?: { input?: number; output?: number };
  /** Extra attempts on 429/5xx. Free-tier limits are per minute, so allow a few. */
  retries?: number;
  /** Cap on server-suggested waits; keep below the run's time budget in serverless. */
  maxRetryDelayMs?: number;
};

export class GeminiClient implements LlmClient {
  readonly billingTier: "free" | "paid";
  readonly priceOverride?: { input?: number; output?: number };
  /** Raw model parts per response (and the model that produced them), keyed by the content
   *  array the loop stores in history. */
  private readonly rawParts = new WeakMap<object, { model: string; parts: GeminiPart[] }>();
  private seq = 0;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly opts: GeminiOptions = {},
  ) {
    this.billingTier = opts.billingTier ?? "free";
    this.priceOverride = opts.priceOverride;
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    const models = [
      this.model,
      ...(this.opts.fallbackModels ?? []).filter((m) => m !== this.model),
    ];
    for (const [i, model] of models.entries()) {
      const last = i === models.length - 1;
      try {
        const res = await providerFetch<GenerateContentResponse>(
          "gemini",
          `${API}/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": this.apiKey },
            json: this.body(req, model),
            signal: req.signal,
          },
          {
            retries: this.opts.retries ?? 2,
            maxRetryDelayMs: this.opts.maxRetryDelayMs ?? 10_000,
            // With a fallback available, a 503 moves on immediately instead of retrying here;
            // 429 (rate limit) still backs off on the same model.
            retryOn: last
              ? undefined
              : (status) => status === 429 || (status >= 500 && status !== 503),
          },
        );
        return this.fromResponse(res, model);
      } catch (err) {
        // Fall back on overload (503) or an exhausted per-model daily quota (non-retryable 429):
        // free-tier quotas are per model, so the next model may still have budget.
        const dailyQuota = err instanceof ProviderError && err.status === 429 && !err.retryable;
        if (!last && err instanceof ProviderError && (err.status === 503 || dailyQuota)) continue;
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  private body(req: LlmRequest, model: string) {
    const thinkingConfig = thinkingConfigFor(model, this.opts.thinking ?? "default");
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: this.toContents(req.messages, model),
      tools: [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: toGeminiSchema(t.input_schema),
          })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    };
  }

  private toContents(messages: Anthropic.MessageParam[], model: string): GeminiContent[] {
    const toolNames = new Map<string, string>();
    const contents: GeminiContent[] = [];
    for (const m of messages) {
      if (typeof m.content === "string") {
        contents.push({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        });
        continue;
      }
      if (m.role === "assistant") {
        for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);
        const raw = this.rawParts.get(m.content);
        // Thought signatures are only meaningful to the model that issued them: after a
        // fallback switch, rebuild the turn with the documented skip-validator signature.
        contents.push({
          role: "model",
          parts: raw && raw.model === model ? raw.parts : this.rebuildModelParts(m.content),
        });
        continue;
      }
      const parts: GeminiPart[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ text: b.text });
        if (b.type === "tool_result") {
          const text =
            typeof b.content === "string"
              ? b.content
              : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
          let response: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(text);
            response =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : { result: parsed };
          } catch {
            response = { result: text };
          }
          if (b.is_error) response = { error: response };
          parts.push({
            functionResponse: {
              ...(b.tool_use_id.startsWith(GENERATED_ID) ? {} : { id: b.tool_use_id }),
              name: toolNames.get(b.tool_use_id) ?? "unknown_tool",
              response,
            },
          });
        }
      }
      contents.push({ role: "user", parts });
    }
    return contents;
  }

  /** Fallback for history this client didn't produce (e.g. a different provider's turns). */
  private rebuildModelParts(content: Anthropic.ContentBlockParam[]): GeminiPart[] {
    let signed = false;
    const parts: GeminiPart[] = [];
    for (const b of content) {
      if (b.type === "text" && b.text) parts.push({ text: b.text });
      if (b.type === "tool_use") {
        parts.push({
          functionCall: {
            ...(b.id.startsWith(GENERATED_ID) ? {} : { id: b.id }),
            name: b.name,
            args: (b.input ?? {}) as Record<string, unknown>,
          },
          ...(signed ? {} : { thoughtSignature: SKIP_SIGNATURE }),
        });
        signed = true;
      }
    }
    return parts;
  }

  private fromResponse(res: GenerateContentResponse, model: string): LlmResponse {
    const candidate = res.candidates?.[0];
    const usage = res.usageMetadata ?? {};
    const cached = usage.cachedContentTokenCount ?? 0;
    const anthropicUsage = {
      input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      // Paid output rates include thinking tokens, so count them as output.
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    } as Anthropic.Usage;

    if (!candidate) {
      if (res.promptFeedback?.blockReason) {
        return { model, content: [], stop_reason: "refusal", usage: anthropicUsage };
      }
      throw new ProviderError("gemini", null, "response contained no candidates", false);
    }
    const reason = candidate.finishReason ?? "STOP";
    if (reason === "MALFORMED_FUNCTION_CALL" || reason === "UNEXPECTED_TOOL_CALL") {
      throw new ProviderError(
        "gemini",
        null,
        `model produced an invalid function call (${reason})`,
        false,
      );
    }

    const rawParts = candidate.content?.parts ?? [];
    const content: Anthropic.ContentBlock[] = [];
    for (const p of rawParts) {
      if (p.thought) continue; // thought summaries aren't part of the answer
      if (p.functionCall) {
        const id = p.functionCall.id ?? `${GENERATED_ID}${++this.seq}`;
        content.push({
          type: "tool_use",
          id,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
        } as Anthropic.ToolUseBlock);
      } else if (p.text) {
        content.push({ type: "text", text: p.text, citations: null } as Anthropic.TextBlock);
      }
    }
    // Replay exactly what Gemini sent (thought signatures included) on the next turn. Calls
    // without an id (older models) get a local id; their functionResponse is sent without one.
    this.rawParts.set(content, { model, parts: rawParts });

    const hasCalls = content.some((b) => b.type === "tool_use");
    const stop_reason: Anthropic.StopReason = hasCalls
      ? "tool_use"
      : reason === "MAX_TOKENS"
        ? "max_tokens"
        : REFUSAL_REASONS.has(reason)
          ? "refusal"
          : "end_turn";
    // `model` is the one that actually answered (primary or a fallback) — shown in the trace.
    return { model, content, stop_reason, usage: anthropicUsage };
  }
}
