import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { workspaces } from "./db/schema";
import { DEFAULT_WORKSPACE_ID } from "./db/seed-data";

/**
 * The dashboard is single-tenant (one admin) while the schema is multi-tenant.
 * Everything resolves the current workspace through this one function.
 */
export function currentWorkspaceId() {
  return DEFAULT_WORKSPACE_ID;
}

export async function getWorkspace(id = currentWorkspaceId()) {
  const [ws] = await getDb().select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return ws ?? null;
}
