import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAdapters } from "@/server/adapters";
import { ProviderError } from "@/server/adapters/http";
import { jsonError, requireAdmin } from "@/server/auth";

const body = z.object({ kind: z.enum(["calendar", "crm", "email"]) });

/** "Test connection": a harmless read call against the active adapter. Admin only. */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "kind must be calendar, crm or email.");
  const adapter = getAdapters()[parsed.data.kind];
  try {
    const res = await adapter.testConnection();
    return NextResponse.json({ ok: true, adapter: adapter.name, detail: res.detail });
  } catch (err) {
    // The failure is already recorded in adapter health by providerFetch.
    const error =
      err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, adapter: adapter.name, error }, { status: 200 });
  }
}
