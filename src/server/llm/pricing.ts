import type Anthropic from "@anthropic-ai/sdk";

/** USD per million tokens. Longest matching prefix wins. Source: Anthropic pricing (2026). */
const PRICES: [prefix: string, input: number, output: number][] = [
  ["claude-fable-5", 10, 50],
  ["claude-mythos-5", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-opus-4-5", 5, 25],
  ["claude-opus-4", 15, 75],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4-5", 1, 5],
  ["claude-3-5-haiku", 0.8, 4],
];

// Unknown models are priced like the Opus tier so the per-run cost cap stays conservative.
const FALLBACK = { input: 5, output: 25 };

export type Price = { input: number; output: number; known: boolean };

export function priceFor(model: string, override?: { input?: number; output?: number }): Price {
  if (override?.input !== undefined && override.output !== undefined) {
    return { input: override.input, output: override.output, known: true };
  }
  const match = PRICES.filter(([p]) => model.startsWith(p)).sort(
    (a, b) => b[0].length - a[0].length,
  )[0];
  return match ? { input: match[1], output: match[2], known: true } : { ...FALLBACK, known: false };
}

type UsageLike = Pick<
  Anthropic.Usage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>;

/** Cost of one response. Cache writes bill at 1.25× input, cache reads at 0.1× input. */
export function costOf(usage: UsageLike, price: Price): number {
  const perToken = (usd: number) => usd / 1_000_000;
  const cost =
    usage.input_tokens * perToken(price.input) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(price.input) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * perToken(price.input) * 0.1 +
    usage.output_tokens * perToken(price.output);
  return Math.round(cost * 1e6) / 1e6;
}

/** Total prompt tokens including cached ones (what the model actually "read"). */
export function totalInputTokens(usage: UsageLike): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}
