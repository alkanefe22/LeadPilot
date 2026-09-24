import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

describe("env", () => {
  it("boots with only DATABASE_URL and applies demo-friendly defaults", () => {
    const e = parseEnv({ DATABASE_URL: "postgres://x" });
    expect(e.PUBLIC_DEMO).toBe(true);
    expect(e.MAX_AGENT_STEPS).toBe(12);
    expect(e.CALENDAR_ADAPTER).toBe("auto");
    expect(e.APP_URL).toBe("http://localhost:3000");
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("treats empty strings as unset and coerces numbers/booleans", () => {
    const e = parseEnv({
      DATABASE_URL: "postgres://x",
      ANTHROPIC_API_KEY: "",
      PUBLIC_DEMO: "false",
      MAX_AGENT_STEPS: "5",
    });
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.PUBLIC_DEMO).toBe(false);
    expect(e.MAX_AGENT_STEPS).toBe(5);
  });

  it("fails loudly with a readable message when DATABASE_URL is missing", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects invalid adapter names", () => {
    expect(() => parseEnv({ DATABASE_URL: "x", CRM_ADAPTER: "salesforce" })).toThrow(/CRM_ADAPTER/);
  });
});
