import "server-only";
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db/client";
import { leadSource, leadStatus, leads, type LeadSource, type LeadStatus } from "../db/schema";

export type LeadFilters = {
  workspaceId: string;
  q?: string;
  status?: string;
  source?: string;
  limit?: number;
  offset?: number;
};

const isStatus = (v?: string): v is LeadStatus =>
  !!v && (leadStatus.enumValues as readonly string[]).includes(v);
const isSource = (v?: string): v is LeadSource =>
  !!v && (leadSource.enumValues as readonly string[]).includes(v);

export async function listLeads(f: LeadFilters) {
  const db = getDb();
  const where: SQL[] = [eq(leads.workspaceId, f.workspaceId)];
  if (isStatus(f.status)) where.push(eq(leads.status, f.status));
  if (isSource(f.source)) where.push(eq(leads.source, f.source));
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    // Escape LIKE wildcards so user input is matched literally.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push(
      or(
        ilike(leads.name, pattern),
        ilike(leads.email, pattern),
        ilike(leads.company, pattern),
        ilike(leads.message, pattern),
      )!,
    );
  }
  const condition = and(...where);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        company: leads.company,
        source: leads.source,
        status: leads.status,
        score: leads.score,
        language: leads.language,
        message: leads.message,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(condition)
      .orderBy(desc(leads.createdAt))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0),
    db.select({ value: count() }).from(leads).where(condition),
  ]);
  return { rows, total: total?.value ?? 0 };
}

export type LeadListRow = Awaited<ReturnType<typeof listLeads>>["rows"][number];

export async function leadStatusCounts(workspaceId: string) {
  const rows = await getDb()
    .select({ status: leads.status, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(eq(leads.workspaceId, workspaceId))
    .groupBy(leads.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<
    Record<LeadStatus, number>
  >;
}
