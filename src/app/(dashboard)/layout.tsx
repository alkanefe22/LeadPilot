import { Logo } from "@/components/layout/logo";
import { MobileNav } from "@/components/layout/mobile-nav";
import { Nav } from "@/components/layout/nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 md:flex">
        <Logo />
        <Nav />
        <div className="mt-auto rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Demo workspace</p>
          <p>Northwind Automation</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:px-6">
          <MobileNav />
          <div className="md:hidden">
            <Logo />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
