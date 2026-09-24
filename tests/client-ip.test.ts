import { describe, expect, it } from "vitest";
import { clientIp } from "@/server/security/client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIp", () => {
  it("uses the first x-forwarded-for entry (Vercel puts the real client first)", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is missing or garbage", () => {
    expect(clientIp(h({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(h({ "x-forwarded-for": "not-an-ip", "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
  });

  it("normalizes ports, brackets, case and IPv4-mapped IPv6", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7:51234" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIp(h({ "x-forwarded-for": "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("returns a single shared 'unknown' bucket when nothing usable is present", () => {
    expect(clientIp(h({}))).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": "', DROP TABLE" }))).toBe("unknown");
  });
});
