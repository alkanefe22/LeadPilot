import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "@/lib/env";
import { proxy } from "@/proxy";

const visit = () => proxy(new NextRequest("http://localhost/leads"));

describe("dashboard proxy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is private by default: an anonymous visitor is sent to /login", async () => {
    vi.stubEnv("PUBLIC_DEMO", undefined);
    const res = await visit();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login?next=%2Fleads");
  });

  it("lets anonymous visitors through only when PUBLIC_DEMO is explicitly on", async () => {
    vi.stubEnv("PUBLIC_DEMO", "true");
    expect((await visit()).headers.get("location")).toBeNull();
  });

  // The proxy and the env schema must never disagree about whether the demo is public.
  it.each(["true", "TRUE", "1", "yes", "on", "false", "0", "no", "off", ""])(
    "agrees with the env schema for PUBLIC_DEMO=%j",
    async (value) => {
      vi.stubEnv("PUBLIC_DEMO", value);
      const isPublic = (await visit()).headers.get("location") === null;
      expect(isPublic).toBe(parseEnv({ DATABASE_URL: "x", PUBLIC_DEMO: value }).PUBLIC_DEMO);
    },
  );
});
