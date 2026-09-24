import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentTool } from "../types";
import { bookMeeting, checkAvailability } from "./calendar";
import { upsertCrmContact } from "./crm";
import { getLead, markDisqualified, scoreLead } from "./lead";
import { askFollowupQuestion, sendEmail } from "./outreach";

// Order is stable on purpose: tool definitions are part of the cached prompt prefix.
export const TOOLS = [
  getLead,
  scoreLead,
  askFollowupQuestion,
  checkAvailability,
  bookMeeting,
  upsertCrmContact,
  sendEmail,
  markDisqualified,
] as unknown as AgentTool[];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function findTool(name: string): AgentTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Zod schema → Anthropic tool definition (one source of truth for LLM schema + validation). */
export function toAnthropicTool(tool: AgentTool): Anthropic.Tool {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<
    string,
    unknown
  >;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { ...schema, type: "object" } as Anthropic.Tool.InputSchema,
  };
}

let cachedDefs: Anthropic.Tool[] | undefined;
export function anthropicTools(): Anthropic.Tool[] {
  cachedDefs ??= TOOLS.map(toAnthropicTool);
  return cachedDefs;
}
