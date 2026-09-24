import { PlaneTakeoffIcon } from "lucide-react";
import Link from "next/link";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <PlaneTakeoffIcon className="size-4" />
      </span>
      <span className={compact ? "hidden sm:inline" : undefined}>LeadPilot</span>
    </Link>
  );
}
