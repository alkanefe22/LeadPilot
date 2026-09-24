import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "@/server/llm/types";

export type FakeTurn = {
  text?: string;
  tools?: { name: string; input: unknown }[];
  stop?: Anthropic.StopReason;
  usage?: Partial<Pick<Anthropic.Usage, "input_tokens" | "output_tokens">>;
};

type Script = (FakeTurn | ((req: LlmRequest) => FakeTurn))[];

let seq = 0;

/**
 * Deterministic stand-in for Claude. Each call pops the next scripted turn; a turn can
 * be a function of the request so it can react to earlier tool results (e.g. pick a slot).
 */
export class FakeLlm implements LlmClient {
  readonly model = "claude-test-model";
  readonly requests: LlmRequest[] = [];
  private i = 0;

  constructor(private readonly script: Script) {}

  async create(req: LlmRequest): Promise<LlmResponse> {
    // Snapshot: the loop mutates `messages` after the call.
    this.requests.push({ ...req, messages: [...req.messages] });
    const next = this.script[this.i++];
    const turn: FakeTurn =
      typeof next === "function" ? next(req) : (next ?? { text: "Done.", stop: "end_turn" });
    const content: Anthropic.ContentBlock[] = [];
    if (turn.text)
      content.push({ type: "text", text: turn.text, citations: null } as Anthropic.TextBlock);
    for (const t of turn.tools ?? []) {
      content.push({
        type: "tool_use",
        id: `toolu_fake_${++seq}`,
        name: t.name,
        input: t.input,
      } as Anthropic.ToolUseBlock);
    }
    return {
      model: this.model,
      content,
      stop_reason: turn.stop ?? (turn.tools?.length ? "tool_use" : "end_turn"),
      usage: {
        input_tokens: turn.usage?.input_tokens ?? 1000,
        output_tokens: turn.usage?.output_tokens ?? 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as Anthropic.Usage,
    };
  }
}

/** Parsed content of the most recent tool_result for `toolName` in the request history. */
export function lastToolResult(req: LlmRequest, toolName: string): Record<string, unknown> | null {
  const ids = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === "tool_use") ids.set(b.id, b.name);
    }
  }
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && ids.get(b.tool_use_id) === toolName) {
        return JSON.parse(String(b.content)) as Record<string, unknown>;
      }
    }
  }
  return null;
}
