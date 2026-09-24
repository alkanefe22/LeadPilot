"use client";

import { MenuIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Logo } from "./logo";
import { Nav } from "./nav";

export function MobileNav({ badges }: { badges?: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={<Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" />}
      >
        <MenuIcon />
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-4">
        <SheetHeader className="p-0 pb-4">
          <SheetTitle render={<div />}>
            <Logo />
          </SheetTitle>
        </SheetHeader>
        <Nav badges={badges} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
