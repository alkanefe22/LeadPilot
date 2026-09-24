import type Anthropic from "@anthropic-ai/sdk";
import { ProviderError, providerFetch } from "../adapters/http";
import { INVALID_TOOL_ARGS, type LlmClient, type LlmRequest, type LlmResponse } from "./types";

/**
 * Any OpenAI-compatible Chat Completions API (`POST {baseUrl}/chat/completions`): Ollama,
 * LM Studio, OpenAI, Groq, OpenRouter, … Implements the same LlmClient contract as Claude and
 * Gemini, translating the loop's Anthropic-shaped messages both ways:
 *   system                 → { role: "system" }
 *   tools (JSON Schema)    → tools[] { type: "function", function: { name, description, parameters } }
 *   assistant tool_use     → assistant message tool_calls[] (arguments as a JSON string)
 *   user tool_result       → { role: "tool", tool_call_id, content }
 *   response tool_calls    → tool_use blocks (stop_reason "tool_use")
 *
 * Arguments that aren't valid JSON (common with small local models) are passed to the loop as
 * an INVALID_TOOL_ARGS marker; the executor returns that to the model as a tool error so it can
 * re-issue the call, exactly like a Zod validation failure.
 */

type ToolCall = { id?: string; type?: "function"; function: { name: string; arguments?: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatCompletion = {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null; tool_calls?: ToolCall[] };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

const GENERATED_ID = "call_gen_";

export type OpenAiCompatOptions = {
  apiKey?: string;
  /** "local" for a model on this machine: every call costs $0. */
  billingTier?: "paid" | "local";
  priceOverride?: { input?: number; output?: number };
  /** Optional `reasoning_effort` (thinking control; names are model-defined). */
  reasoningEffort?: string;
  /** Extra attempts on 429/5xx/network errors. */
  retries?: number;
};

/** JSON Schema as-is, minus `$schema` (some servers reject unknown top-level keywords). */
function toParameters(schema: unknown): Record<string, unknown> {
  const { $schema: _drop, ...rest } = (schema ?? {}) as Record<string, unknown>;
  return { type: "object", properties: {}, ...rest };
}

const resultText = (content: Anthropic.ToolResultBlockParam["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");

export class OpenAiCompatClient implements LlmClient {
  readonly billingTier: "paid" | "local";
  readonly priceOverride?: { input?: number; output?: number };
  private seq = 0;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly opts: OpenAiCompatOptions = {},
  ) {
    this.billingTier = opts.billingTier ?? "paid";
    this.priceOverride =
      this.billingTier === "local" ? { input: 0, output: 0 } : opts.priceOverride;
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await providerFetch<ChatCompletion>(
      "openai-compatible",
      url,
      {
        method: "POST",
        headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
        json: this.body(req),
        signal: req.signal,
      },
      { retries: this.opts.retries ?? 2 },
    );
    return this.fromResponse(res);
  }

  private body(req: LlmRequest) {
    return {
      model: this.model,
      messages: this.toMessages(req),
      tools: req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: toParameters(t.input_schema),
        },
      })),
      // OpenAI's own API wants max_completion_tokens (and rejects max_tokens on reasoning
      // models); Ollama and most other compatible servers document max_tokens.
      ...(/(^|\.)openai\.com$/.test(new URL(this.baseUrl).hostname)
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens }),
      ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
    };
  }

  private toMessages(req: LlmRequest): ChatMessage[] {
    const out: ChatMessage[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (typeof m.content === "string") {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      if (m.role === "assistant") {
        const text = m.content
          .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const calls = m.content
          .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: argumentsOf(b.input) },
          }));
        out.push({
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
        continue;
      }
      // Tool results must directly follow the assistant message that called them.
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const text = resultText(b.content);
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: b.is_error ? JSON.stringify({ error: safeJson(text) }) : text,
          });
        } else if (b.type === "text") {
          texts.push(b.text);
        }
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
    return out;
  }

  private fromResponse(res: ChatCompletion): LlmResponse {
    const usage = res.usage ?? {};
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const anthropicUsage = {
      input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: usage.completion_tokens ?? 0,
    } as Anthropic.Usage;
    const model = res.model || this.model;

    const choice = res.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError("openai-compatible", null, "response contained no choices", false);
    }
    const msg = choice.message;
    const content: Anthropic.ContentBlock[] = [];
    if (msg.content) {
      content.push({ type: "text", text: msg.content, citations: null } as Anthropic.TextBlock);
    }
    for (const call of msg.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id || `${GENERATED_ID}${++this.seq}`,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      } as Anthropic.ToolUseBlock);
    }

    const reason = choice.finish_reason ?? "stop";
    const stop_reason: Anthropic.StopReason = content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : reason === "length"
        ? "max_tokens"
        : reason === "content_filter" || msg.refusal
          ? "refusal"
          : "end_turn";
    return { model, content, stop_reason, usage: anthropicUsage };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Replays our own invalid-arguments marker verbatim so the model sees what it sent. */
function argumentsOf(input: unknown): string {
  const raw = (input as Record<string, unknown> | null)?.[INVALID_TOOL_ARGS];
  return typeof raw === "string" ? raw : JSON.stringify(input ?? {});
}

export function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { [INVALID_TOOL_ARGS]: raw };
}
