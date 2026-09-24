import Anthropic from "@anthropic-ai/sdk";
import { env, resolveLlmProvider } from "@/lib/env";
import { DevFakeLlm } from "./fake";
import { GeminiClient } from "./gemini";
import { LlmNotConfiguredError, type LlmClient, type LlmRequest, type LlmResponse } from "./types";

export class AnthropicLlm implements LlmClient {
  readonly billingTier = "paid" as const;
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
    private readonly effort?: "low" | "medium" | "high" | "xhigh" | "max",
    readonly priceOverride?: { input?: number; output?: number },
  ) {
    // Retries cover 429/5xx/network; the per-request timeout keeps us inside the run budget.
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 45_000 });
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        // System prompt + tool definitions are identical across every step of a run
        // (and across leads of a workspace) → auto prompt caching cuts input cost ~90%.
        cache_control: { type: "ephemeral" },
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      },
      { signal: req.signal },
    );
    return {
      content: res.content,
      stop_reason: res.stop_reason,
      usage: res.usage,
      model: res.model,
    };
  }
}

/** The configured LLM: Claude or Gemini (see resolveLlmProvider), or the dev fake. */
export type LlmOptions = {
  /** Batch jobs (eval) can wait longer for Gemini free-tier rate limits than a 60s function. */
  geminiRetries?: number;
  geminiMaxRetryDelayMs?: number;
};

export function getLlm(opts: LlmOptions = {}): LlmClient {
  const e = env();
  if (e.DEV_FAKE_LLM) {
    if (e.NODE_ENV === "production") throw new Error("DEV_FAKE_LLM cannot be used in production.");
    return new DevFakeLlm();
  }
  const provider = resolveLlmProvider(e);
  if (provider === "gemini") {
    return new GeminiClient(e.GEMINI_MODEL!, e.GEMINI_API_KEY!, {
      billingTier: e.GEMINI_TIER,
      priceOverride: {
        input: e.GEMINI_PRICE_INPUT_PER_MTOK,
        output: e.GEMINI_PRICE_OUTPUT_PER_MTOK,
      },
      retries: opts.geminiRetries,
      maxRetryDelayMs: opts.geminiMaxRetryDelayMs,
    });
  }
  if (provider === "anthropic") {
    return new AnthropicLlm(e.ANTHROPIC_MODEL!, e.ANTHROPIC_API_KEY!, e.ANTHROPIC_EFFORT, {
      input: e.ANTHROPIC_PRICE_INPUT_PER_MTOK,
      output: e.ANTHROPIC_PRICE_OUTPUT_PER_MTOK,
    });
  }
  throw new LlmNotConfiguredError();
}
