"use client";

import {
  CalendarDaysIcon,
  CheckCheckIcon,
  InboxIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/leads", label: "Leads", icon: UsersIcon },
  { href: "/approvals", label: "Approvals", icon: CheckCheckIcon },
  { href: "/outbox", label: "Outbox", icon: InboxIcon },
  { href: "/calendar", label: "Calendar", icon: CalendarDaysIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function Nav({
  badges,
  onNavigate,
}: {
  badges?: Record<string, number>;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        const badge = badges?.[href];
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            <span className="flex-1">{label}</span>
            {badge ? (
              <span className="rounded-full bg-primary px-1.5 font-mono text-[10px] leading-4 text-primary-foreground">
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
