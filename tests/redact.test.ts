import { describe, expect, it } from "vitest";
import { maskEmail, maskText, redactDeep } from "@/server/security/redact";

describe("public-demo redaction", () => {
  it("masks emails and phone numbers", () => {
    expect(maskEmail("sarah.mitchell@freightlane.io")).toBe("s***@freightlane.io");
    const t = maskText("Call +1 415 555 0142 or (415) 555-0199, mail jo@x.io");
    expect(t).not.toContain("555 0142");
    expect(t).not.toContain("555-0199");
    expect(t).toContain("j***@x.io");
  });

  it("leaves ISO timestamps, dates and money untouched", () => {
    const value = {
      startedAt: "2026-09-24T14:31:05.123Z",
      local: "Mon 28 Sept, 11:00 GMT+3",
      start: "2026-09-28T08:00:00+03:00",
      body: "Budget $20,000 by 2026-10-01",
      n: 42,
    };
    expect(redactDeep(value)).toEqual(value);
  });
});
