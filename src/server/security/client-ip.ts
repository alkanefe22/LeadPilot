import { isIP } from "node:net";

/**
 * The one place that decides "who is this client?" for every rate limit.
 *
 * On Vercel, `x-forwarded-for` is set by the edge and its FIRST entry is the real client
 * (Vercel overwrites any value the client sent, so it can't be spoofed); `x-real-ip` carries
 * the same address. Behind other proxies the first entry is still the original client.
 * Anything that isn't a syntactically valid IP is ignored, and the fallback is a single
 * shared "unknown" bucket — conservative: unidentifiable callers share one limit.
 */
export function clientIp(headers: Headers): string {
  const candidates = [
    headers.get("x-forwarded-for")?.split(",")[0],
    headers.get("x-real-ip"),
    headers.get("cf-connecting-ip"),
  ];
  for (const raw of candidates) {
    const ip = normalizeIp(raw);
    if (ip) return ip;
  }
  return "unknown";
}

function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  // "[2001:db8::1]:443" and "203.0.113.7:51234" forms.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  // IPv4-mapped IPv6 → plain IPv4 so both forms share one bucket.
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}
