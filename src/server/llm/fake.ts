import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "./types";

/**
 * DEVELOPMENT-ONLY stand-in for Claude (DEV_FAKE_LLM=true, refused in production).
 * A small keyword/state machine that walks the standard operating procedure so the
 * dashboard, trace timeline and approvals can be exercised without an API key.
 * It says nothing about how a real model behaves — its runs show model "dev-fake-llm".
 */
export class DevFakeLlm implements LlmClient {
  readonly model = "dev-fake-llm";

  async create(req: LlmRequest): Promise<LlmResponse> {
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 500)); // feel "live" in the UI
    const brief = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
    const called = toolCalls(req);
    const last = (name: string) => lastResult(req, name);
    const turn = (text: string | null, tools: { name: string; input: unknown }[] = []) =>
      respond(req, text, tools);

    if (!called.includes("score_lead"))
      return turn("Reading the lead and scoring it against the ICP.", [
        { name: "score_lead", input: heuristicScore(brief) },
      ]);

    const score = last("score_lead") as { score?: number; qualifies?: boolean } | null;
    const category = (lastInput(req, "score_lead") as { category?: string } | null)?.category;
    const lang = (lastInput(req, "score_lead") as { language?: string } | null)?.language ?? "en";
    const first = /name: ([^\s(]+)/.exec(brief)?.[1] ?? "there";

    if (category === "spam") {
      if (!called.includes("mark_disqualified"))
        return turn(null, [
          {
            name: "mark_disqualified",
            input: { category: "spam", reason: "Spam, vendor pitch or manipulation attempt." },
          },
        ]);
      return turn("Disqualified as spam; no email sent.");
    }
    if (category === "poor_fit") {
      if (!called.includes("send_email"))
        return turn(null, [
          {
            name: "send_email",
            input: {
              purpose: "rejection",
              subject: "Thanks for reaching out",
              body: `Hi ${first},\n\nThank you for your message. This request is outside what we can take on right now, so we don't want to hold you up. We wish you the best with the project.\n\nBest regards,\nNorthwind Automation`,
            },
          },
        ]);
      if (!called.includes("mark_disqualified"))
        return turn(null, [
          {
            name: "mark_disqualified",
            input: { category: "poor_fit", reason: "Budget/scope outside the ICP." },
          },
          {
            name: "upsert_crm_contact",
            input: { status: "disqualified", note: "Poor fit, polite decline sent." },
          },
        ]);
      return turn("Genuine but poor fit: sent a polite decline and disqualified.");
    }
    if (!score?.qualifies) {
      if (!called.includes("ask_followup_question")) {
        return turn(null, [
          {
            name: "ask_followup_question",
            input: {
              subject: "A couple of quick questions",
              body: `Hi ${first},\n\nThanks for getting in touch — this sounds like a great fit for an AI agent. To suggest the right next step, could you share your approximate budget and when you'd like to have this live?\n\nBest regards,\nNorthwind Automation`,
              missing_fields: ["budget", "timeline"],
            },
          },
          {
            name: "upsert_crm_contact",
            input: { status: "needs_info", note: "Asked for budget and timeline." },
          },
        ]);
      }
      return turn("Promising but missing budget/timeline: sent one follow-up question.");
    }
    if (!called.includes("check_availability"))
      return turn("Qualified — checking the calendar.", [
        { name: "check_availability", input: { days_ahead: 7, max_slots: 5 } },
      ]);
    if (!called.includes("book_meeting")) {
      const slots =
        (last("check_availability") as { slots?: { start: string }[] } | null)?.slots ?? [];
      if (!slots.length) return turn("No free slots in the next week; leaving for a human.");
      return turn(null, [{ name: "book_meeting", input: { start: slots[0]!.start } }]);
    }
    const booking = last("book_meeting") as {
      start_local?: string;
      meeting_url?: string;
      status?: string;
    } | null;
    if (!called.includes("send_email")) {
      const when = booking?.start_local ?? "the time in your calendar invite";
      return turn(null, [
        {
          name: "send_email",
          input: {
            purpose: "confirmation",
            subject: "Your discovery call is booked",
            body: `Hi ${first},\n\nThanks for reaching out! I've booked a 30-minute discovery call for ${when}. Join here: ${booking?.meeting_url ?? "link in the invite"}.\n\nLooking forward to it,\nNorthwind Automation${lang !== "en" ? `\n\n(lang: ${lang})` : ""}`,
          },
        },
        {
          name: "upsert_crm_contact",
          input: { status: "booked", note: `Discovery call booked for ${when}.` },
        },
      ]);
    }
    return turn(
      `Qualified (${score.score}) and booked a discovery call; confirmation sent and CRM updated.`,
    );
  }
}

function heuristicScore(brief: string) {
  const content = brief.split("<lead_content")[1] ?? brief;
  const flagged = /risk_flags: prompt_injection/.test(brief);
  const lang = /\b(der|und|wir|möchten)\b/i.test(content)
    ? "de"
    : /\b(hola|queremos|presupuesto)\b/i.test(content)
      ? "es"
      : /\b(merhaba|bütçe|istiyoruz)\b/i.test(content)
        ? "tr"
        : /\b(bonjour|nous|souhaitons)\b/i.test(content)
          ? "fr"
          : "en";
  const spam =
    flagged ||
    /(backlinks|btc|crypto|\$\d+\/hour|guaranteed|are you hiring|internship|cv)/i.test(content);
  const money =
    /(\$|€|usd|eur|budget|bütçe|presupuesto)\s*[^\n]{0,20}?(\d[\d.,]*)\s*(k|000)?/i.exec(content);
  const amount = money
    ? Number(money[2]!.replace(/[.,]/g, "")) * (money[3]?.toLowerCase() === "k" ? 1000 : 1)
    : null;
  const timeline = /(month|week|quarter|asap|soon|monat|quartal|semanas|mois|ay|next)/i.test(
    content,
  );
  if (spam)
    return base(
      3,
      "spam",
      "Spam, vendor pitch or text aimed at the agent rather than a genuine request.",
      lang,
    );
  if (amount !== null && amount < 5000)
    return base(
      18,
      "poor_fit",
      "Genuine request but the stated budget is far below the minimum project size.",
      lang,
      `${amount}`,
    );
  if (amount !== null && timeline)
    return base(
      84,
      "fit",
      "Clear B2B need with a stated budget and timeline from a senior contact.",
      lang,
      `${amount}`,
      "stated",
    );
  return {
    ...base(55, "needs_info", "Relevant need, but budget and/or timeline are missing.", lang),
    missing: ["budget", "timeline"],
  };
}

function base(
  score: number,
  category: string,
  reasoning: string,
  language: string,
  budget: string | null = null,
  timeline: string | null = null,
) {
  return {
    score,
    category,
    reasoning,
    budget,
    timeline,
    need: null,
    authority: null,
    missing: [],
    language,
  };
}

function toolCalls(req: LlmRequest): string[] {
  return req.messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => (b as Anthropic.ToolUseBlockParam).name)
      : [],
  );
}

function lastInput(req: LlmRequest, name: string): unknown {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const b = m.content.find((x) => x.type === "tool_use" && x.name === name) as
      Anthropic.ToolUseBlockParam | undefined;
    if (b) return b.input;
  }
  return null;
}

function lastResult(req: LlmRequest, name: string): Record<string, unknown> | null {
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
      if (b.type === "tool_result" && ids.get(b.tool_use_id) === name) {
        try {
          return JSON.parse(String(b.content)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

let seq = 0;
function respond(
  req: LlmRequest,
  text: string | null,
  tools: { name: string; input: unknown }[],
): LlmResponse {
  const content: Anthropic.ContentBlock[] = [];
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
  for (const t of tools)
    content.push({
      type: "tool_use",
      id: `toolu_dev_${Date.now()}_${++seq}`,
      name: t.name,
      input: t.input,
    } as Anthropic.ToolUseBlock);
  const promptChars =
    req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools).length;
  return {
    model: "dev-fake-llm",
    content,
    stop_reason: tools.length ? "tool_use" : "end_turn",
    usage: {
      input_tokens: Math.round(promptChars / 4),
      output_tokens: Math.round((JSON.stringify(content).length / 4) * 1.3),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as Anthropic.Usage,
  };
}
