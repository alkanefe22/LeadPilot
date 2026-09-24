import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isLlmConfigured } from "@/lib/env";
import { newId } from "@/lib/ids";
import { runAgentInBackground } from "@/server/agent/trigger";
import { jsonError } from "@/server/auth";
import { getDb } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";
import { clientIp } from "@/server/security/client-ip";
import { rateLimit } from "@/server/security/rate-limit";
import { sanitizeEmail } from "@/server/security/sanitize";
import { createInboundLead } from "@/server/services/intake";

// Triggers an agent run (in after()): give the background work the full function budget.
export const maxDuration = 60;

const formSchema = z.object({
  workspaceId: z.string().min(1).max(64),
  name: z.string().trim().min(1, "Please tell us your name").max(200),
  email: z
    .string()
    .trim()
    .max(320)
    .refine((v) => sanitizeEmail(v) !== null, "Please enter a valid email"),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().min(10, "Please add a few words about your project").max(5000),
  // Honeypot: invisible to humans, bots fill it in.
  website_url: z.string().max(500).optional(),
});

/** Public lead form (the /f/[workspaceId] page and the embeddable iframe post here). */
export async function POST(req: NextRequest) {
  const db = getDb();
  const ip = clientIp(req.headers);
  const limited = await rateLimit(db, `form:ip:${ip}`, 5, 600);
  if (!limited.ok) return jsonError(429, "Too many submissions — please try again later.");

  const parsed = formSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(422, parsed.error.issues[0]?.message ?? "Invalid form.", {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    });
  }
  const f = parsed.data;
  // Pretend success for bots so they don't adapt; store nothing.
  if (f.website_url) return NextResponse.json({ ok: true }, { status: 202 });

  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, f.workspaceId));
  if (!workspace) return jsonError(404, "Form not found.");

  const lead = await createInboundLead(db, {
    workspaceId: workspace.id,
    source: "form",
    externalId: newId("form"),
    name: f.name,
    email: f.email,
    company: f.company,
    message: f.message,
    rawPayload: { form: true, referer: req.headers.get("referer") },
  });
  if (!lead) return jsonError(500, "Could not save your message.");
  if (isLlmConfigured()) runAgentInBackground(lead.id, "inbound");
  return NextResponse.json({ ok: true }, { status: 202 });
}
