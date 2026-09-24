import type Anthropic from "@anthropic-ai/sdk";

/** What the agent loop needs from a model. Real impl: Anthropic SDK. Tests: a scripted fake. */
export type LlmRequest = {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  /** Abort the HTTP call when the run's wall-clock budget is exhausted. */
  signal?: AbortSignal;
};

export type LlmResponse = Pick<Anthropic.Message, "content" | "stop_reason" | "usage" | "model">;

export interface LlmClient {
  readonly model: string;
  /** "free" → provider bills $0 (e.g. Gemini free tier); costs are estimates at paid rates. */
  readonly billingTier?: "free" | "paid";
  /** Per-provider price override (USD per 1M tokens) from env. */
  readonly priceOverride?: { input?: number; output?: number };
  create(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      "No LLM configured. Set GEMINI_API_KEY + GEMINI_MODEL (free tier) or ANTHROPIC_API_KEY + ANTHROPIC_MODEL in .env.local.",
    );
    this.name = "LlmNotConfiguredError";
  }
}
