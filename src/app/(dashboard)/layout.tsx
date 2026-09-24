import { and, count, eq } from "drizzle-orm";
import { EyeIcon } from "lucide-react";
import { AccountMenu } from "@/components/layout/account-menu";
import { Logo } from "@/components/layout/logo";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Nav } from "@/components/layout/nav";
import { SimulateButton } from "@/components/layout/simulate-button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getViewer } from "@/server/auth";
import { getSimulateState } from "@/server/dashboard";
import { getDb } from "@/server/db/client";
import { approvals } from "@/server/db/schema";
import { currentWorkspaceId, getWorkspace } from "@/server/workspace";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const viewer = await getViewer();
  const [simulate, workspace, [pending]] = await Promise.all([
    getSimulateState(viewer),
    getWorkspace(),
    getDb()
      .select({ n: count() })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, currentWorkspaceId()), eq(approvals.status, "pending"))),
  ]);
  const badges = { "/approvals": pending?.n ?? 0 };

  return (
    <div className="flex min-h-svh w-full">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 md:flex">
        <Logo />
        <Nav badges={badges} />
        <div className="mt-auto rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{workspace?.name ?? "Workspace"}</p>
          <p>
            Threshold {workspace?.scoreThreshold ?? "—"} ·{" "}
            {workspace?.requireApproval ? "approval on" : "autonomous"}
          </p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!viewer.isAdmin ? (
          <div className="flex items-center justify-center gap-2 border-b bg-primary/5 px-4 py-1.5 text-center text-xs text-muted-foreground">
            <EyeIcon className="size-3.5 shrink-0" />
            <span>
              {viewer.authConfigured
                ? "Read-only public demo — contact details are masked. Hit “Simulate lead” to watch the agent work live."
                : "Read-only mode — set ADMIN_PASSWORD to enable admin actions."}
            </span>
          </div>
        ) : null}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:px-6">
          <MobileNav badges={badges} />
          <div className="md:hidden">
            <Logo compact />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <SimulateButton state={simulate} />
            <ThemeToggle />
            <AccountMenu isAdmin={viewer.isAdmin} authConfigured={viewer.authConfigured} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
