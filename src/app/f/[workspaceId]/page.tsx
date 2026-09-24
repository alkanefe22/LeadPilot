import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeadForm } from "@/components/inbound/lead-form";
import { getDb } from "@/server/db/client";
import { workspaces } from "@/server/db/schema";

export const metadata: Metadata = { title: "Contact us" };

export default async function PublicFormPage({
  params,
  searchParams,
}: PageProps<"/f/[workspaceId]">) {
  const { workspaceId } = await params;
  const embed = (await searchParams).embed === "1";
  const [ws] = await getDb()
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) notFound();

  return (
    <main className={embed ? "p-4" : "flex min-h-svh items-center justify-center bg-muted/30 p-4"}>
      <div
        className={
          embed ? "w-full" : "w-full max-w-lg rounded-2xl border bg-background p-6 shadow-sm"
        }
      >
        {!embed ? (
          <div className="mb-5">
            <h1 className="text-xl font-semibold tracking-tight">Talk to {ws.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Tell us about your project — you&apos;ll hear back within minutes.
            </p>
          </div>
        ) : null}
        <LeadForm workspaceId={ws.id} embed={embed} />
      </div>
    </main>
  );
}
