"use client";

import { DatabaseZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-24 text-center">
      <DatabaseZapIcon className="size-10 text-muted-foreground" />
      <h2 className="text-lg font-semibold">Something went wrong loading this page</h2>
      <p className="text-sm text-muted-foreground">
        If this is a fresh install, make sure <code className="font-mono">DATABASE_URL</code> is set
        and run <code className="font-mono">pnpm db:migrate && pnpm db:seed</code>.
      </p>
      {process.env.NODE_ENV !== "production" ? (
        <pre className="max-w-full overflow-auto rounded-md bg-muted p-3 text-left text-xs">
          {error.message}
        </pre>
      ) : null}
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
