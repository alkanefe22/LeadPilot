"use client";

import { LogInIcon, LogOutIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function AccountMenu({
  isAdmin,
  authConfigured,
}: {
  isAdmin: boolean;
  authConfigured: boolean;
}) {
  const router = useRouter();
  if (isAdmin) {
    return (
      <div className="flex items-center gap-1">
        <span className="hidden items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground lg:inline-flex">
          <ShieldCheckIcon className="size-3.5 text-emerald-500" /> Admin
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Log out"
          title="Log out"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.refresh();
          }}
        >
          <LogOutIcon />
        </Button>
      </div>
    );
  }
  if (!authConfigured) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={<Link href="/login" aria-label="Admin login" />}
    >
      <LogInIcon data-icon="inline-start" /> <span className="hidden sm:inline">Admin login</span>
    </Button>
  );
}
