import { describe, expect, it } from "vitest";
import { costOf, priceFor } from "@/server/llm/pricing";

describe("pricing", () => {
  it("matches the longest model prefix", () => {
    expect(priceFor("claude-opus-5-5")).toMatchObject({ input: 4, output: 20, known: true });
    expect(priceFor("claude-opus-5")).toMatchObject({ input: 5, output: 25 });
    expect(priceFor("claude-sonnet-5")).toMatchObject({ input: 2, output: 10 });
    expect(priceFor("claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
  });

  it("falls back conservatively for unknown models and honors env overrides", () => {
    expect(priceFor("some-new-model")).toMatchObject({ input: 5, output: 25, known: false });
    expect(priceFor("some-new-model", { input: 1, output: 2 })).toMatchObject({
      input: 1,
      output: 2,
    });
  });

  it("prices cache writes at 1.25x and cache reads at 0.1x of input", () => {
    const p = { input: 10, output: 50, known: true };
    const cost = costOf(
      {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      },
      p,
    );
    expect(cost).toBeCloseTo(10 + 12.5 + 1 + 5, 6);
  });
});
