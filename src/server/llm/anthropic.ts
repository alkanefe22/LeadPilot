import Anthropic from "@anthropic-ai/sdk";
import { env, isLlmConfigured } from "@/lib/env";
import { DevFakeLlm } from "./fake";
import { LlmNotConfiguredError, type LlmClient, type LlmRequest, type LlmResponse } from "./types";

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
    private readonly effort?: "low" | "medium" | "high" | "xhigh" | "max",
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

export function getLlm(): LlmClient {
  const e = env();
  if (e.DEV_FAKE_LLM) {
    if (e.NODE_ENV === "production") throw new Error("DEV_FAKE_LLM cannot be used in production.");
    return new DevFakeLlm();
  }
  if (!isLlmConfigured(e)) throw new LlmNotConfiguredError();
  return new AnthropicLlm(e.ANTHROPIC_MODEL!, e.ANTHROPIC_API_KEY!, e.ANTHROPIC_EFFORT);
}
