import "server-only";
import { selectAdapters, type AdapterKind } from "../adapters";
import { eq } from "drizzle-orm";
import { resolveLlmProvider } from "@/lib/env";
import { getDb } from "../db/client";
import { adapterHealth } from "../db/schema";

export type IntegrationView = {
  kind: AdapterKind;
  active: string;
  requested: string;
  external: boolean;
  note: string | null;
  health: "ok" | "failing" | "unknown" | "builtin";
  lastError: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
};

/** Active adapter per kind + its last known health (for the Settings page). */
export async function getIntegrations(): Promise<IntegrationView[]> {
  const { status } = selectAdapters();
  const rows = await getDb().select().from(adapterHealth);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return status.map((s) => {
    const h = s.external ? byProvider.get(s.active) : undefined;
    return {
      kind: s.kind,
      active: s.active,
      requested: s.requested,
      external: s.external,
      note: s.note,
      health: !s.external ? "builtin" : !h ? "unknown" : h.failing ? "failing" : "ok",
      lastError: h?.lastError ?? null,
      lastErrorAt: h?.lastErrorAt?.toISOString() ?? null,
      lastOkAt: h?.lastOkAt?.toISOString() ?? null,
    };
  });
}

/** Last error of the Gemini client (the only LLM that goes through providerFetch), if failing. */
export async function getLlmHealth(): Promise<string | null> {
  if (resolveLlmProvider() !== "gemini") return null;
  const [row] = await getDb()
    .select()
    .from(adapterHealth)
    .where(eq(adapterHealth.provider, "gemini"));
  return row?.failing ? row.lastError : null;
}
