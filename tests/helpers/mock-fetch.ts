import { vi } from "vitest";

export type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};
type Handler = (call: Call) => Response | Promise<Response> | undefined;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/**
 * Replaces global fetch. Handlers are tried in order; a handler with `once` semantics can be
 * built by the test. Unmatched requests fail loudly so contracts can't drift silently.
 */
export function mockFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers,
      body: (init.body as string | null) ?? null,
    };
    calls.push(call);
    for (const h of handlers) {
      const res = await h(call);
      if (res) return res;
    }
    throw new Error(`Unexpected fetch: ${call.method} ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    fn,
    bodyOf: (i: number) => JSON.parse(calls[i]!.body ?? "null") as Record<string, unknown>,
  };
}

/** Responds with each response in turn for requests matching `match`. */
export function sequence(match: (c: Call) => boolean, ...responses: (() => Response)[]): Handler {
  let i = 0;
  return (c) => (match(c) ? responses[Math.min(i++, responses.length - 1)]!() : undefined);
}
