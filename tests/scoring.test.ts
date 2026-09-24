import { describe, expect, it } from "vitest";
import { applyScoringPolicy, scoreLeadInput } from "@/server/agent/tools/lead";
import { GOOD_SCORE } from "./helpers/fixtures";

describe("score_lead input parsing", () => {
  it("accepts a well-formed score and normalizes blank fields to null", () => {
    const r = scoreLeadInput.parse({ ...GOOD_SCORE, budget: "  ", timeline: " Q3 " });
    expect(r.budget).toBeNull();
    expect(r.timeline).toBe("Q3");
  });

  it("coerces numeric strings (models sometimes send them) but rejects junk", () => {
    expect(scoreLeadInput.parse({ ...GOOD_SCORE, score: "85" }).score).toBe(85);
    expect(scoreLeadInput.safeParse({ ...GOOD_SCORE, score: "high" }).success).toBe(false);
  });

  it("rejects out-of-range scores, unknown categories and bad language codes", () => {
    expect(scoreLeadInput.safeParse({ ...GOOD_SCORE, score: 150 }).success).toBe(false);
    expect(scoreLeadInput.safeParse({ ...GOOD_SCORE, score: 72.5 }).success).toBe(false);
    expect(scoreLeadInput.safeParse({ ...GOOD_SCORE, category: "hot" }).success).toBe(false);
    expect(scoreLeadInput.safeParse({ ...GOOD_SCORE, language: "English" }).success).toBe(false);
  });

  it("defaults missing[] and requires reasoning", () => {
    const { missing: _m, ...rest } = GOOD_SCORE;
    expect(scoreLeadInput.parse(rest).missing).toEqual([]);
    expect(scoreLeadInput.safeParse({ ...GOOD_SCORE, reasoning: "" }).success).toBe(false);
  });
});

describe("scoring policy", () => {
  const input = scoreLeadInput.parse(GOOD_SCORE);
  const base = { threshold: 70, flagged: false, currentStatus: "new" as const };

  it("qualifies a fit lead at or above the threshold", () => {
    expect(applyScoringPolicy(input, base).status).toBe("qualified");
    expect(applyScoringPolicy({ ...input, score: 70 }, base).status).toBe("qualified");
  });

  it("puts below-threshold fits and needs_info leads into needs_info", () => {
    expect(applyScoringPolicy({ ...input, score: 60 }, base).status).toBe("needs_info");
    expect(applyScoringPolicy({ ...input, category: "needs_info" }, base).status).toBe(
      "needs_info",
    );
  });

  it("leaves status alone for spam/poor fit (mark_disqualified decides) and never downgrades booked", () => {
    expect(applyScoringPolicy({ ...input, category: "spam", score: 2 }, base).status).toBe("new");
    expect(
      applyScoringPolicy({ ...input, score: 10 }, { ...base, currentStatus: "booked" }).status,
    ).toBe("booked");
  });

  it("caps flagged (prompt-injection) leads below the threshold", () => {
    const r = applyScoringPolicy({ ...input, score: 100 }, { ...base, flagged: true });
    expect(r.capped).toBe(true);
    expect(r.qualification.score).toBe(69);
    expect(r.status).toBe("needs_info");
  });
});
