import { describe, expect, it } from "vitest";
import {
  sanitizeEmail,
  sanitizeLine,
  sanitizeText,
  sanitizeUrl,
  stripHtml,
} from "@/server/security/sanitize";

describe("sanitize", () => {
  it("strips scripts, tags and decodes basic entities", () => {
    expect(stripHtml(`<p>Hi &amp; hello</p><script>alert(1)</script><b>there</b>`)).toBe(
      "Hi & hello\nthere",
    );
  });

  it("removes control chars, normalizes newlines and truncates", () => {
    expect(sanitizeText("a\u0000b\r\n\r\n\r\n\r\nc")).toBe("ab\n\nc");
    expect(sanitizeText("x".repeat(20), 10)).toBe(`${"x".repeat(10)}…`);
    expect(sanitizeText(42)).toBe("");
  });

  it("collapses single-line fields and returns null when empty", () => {
    expect(sanitizeLine("  Acme \n Corp  ")).toBe("Acme Corp");
    expect(sanitizeLine("   ")).toBeNull();
  });

  it("validates and normalizes emails", () => {
    expect(sanitizeEmail("Jane Doe <Jane@Example.COM>")).toBe("jane@example.com");
    expect(sanitizeEmail("not-an-email")).toBeNull();
    expect(sanitizeEmail("a@b")).toBeNull();
  });

  it("only allows http(s) urls", () => {
    expect(sanitizeUrl("acme.io")).toBe("https://acme.io/");
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
  });
});
