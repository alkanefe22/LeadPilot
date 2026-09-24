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

describe("production safety", () => {
  const prod = {
    DATABASE_URL: "postgres://x",
    NODE_ENV: "production",
    ADMIN_PASSWORD: "a-long-enough-password",
    SESSION_SECRET: "s".repeat(64),
  };

  it("boots with strong credentials", () => {
    expect(parseEnv(prod).NODE_ENV).toBe("production");
  });

  it.each([
    [{ ADMIN_PASSWORD: undefined }, /ADMIN_PASSWORD: is required/],
    [{ ADMIN_PASSWORD: "short-pass" }, /ADMIN_PASSWORD: must be at least 12/],
    [{ ADMIN_PASSWORD: "leadpilot-dev" }, /ADMIN_PASSWORD: must not be the development default/],
    [{ SESSION_SECRET: undefined }, /SESSION_SECRET: is required/],
    [{ SESSION_SECRET: "too-short" }, /SESSION_SECRET: must be at least 32/],
    [{ DEV_FAKE_LLM: "true" }, /DEV_FAKE_LLM: must be false/],
  ])("refuses to start with %o", (override, message) => {
    expect(() => parseEnv({ ...prod, ...override })).toThrow(message);
  });

  it("does not enforce these rules in development", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: "x", ADMIN_PASSWORD: "leadpilot-dev", DEV_FAKE_LLM: "true" }),
    ).not.toThrow();
  });
});
