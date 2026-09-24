import type { LlmClient, LlmRequest, LlmResponse } from "./types";

/**
 * Spaces model calls at least `minIntervalMs` apart (across concurrent callers), so batch
 * jobs like `pnpm eval` stay under per-minute rate limits (e.g. the Gemini free tier).
 */
export class ThrottledLlm implements LlmClient {
  private nextSlot = 0;

  constructor(
    private readonly inner: LlmClient,
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  get model() {
    return this.inner.model;
  }
  get billingTier() {
    return this.inner.billingTier;
  }
  get priceOverride() {
    return this.inner.priceOverride;
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    if (this.minIntervalMs > 0) {
      const now = this.now();
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + this.minIntervalMs; // reserve before awaiting: concurrency-safe
      if (slot > now) await this.sleep(slot - now);
    }
    return this.inner.create(req);
  }
}
