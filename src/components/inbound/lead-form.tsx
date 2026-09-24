"use client";

import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function LeadForm({ workspaceId, embed }: { workspaceId: string; embed: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const ref = useRef<HTMLDivElement>(null);

  // Tell the embedding page our height so the iframe never scrolls (see /embed.js).
  useEffect(() => {
    if (!embed || !ref.current) return;
    const post = () =>
      window.parent?.postMessage(
        { type: "leadpilot:resize", height: document.documentElement.scrollHeight },
        "*",
      );
    const ro = new ResizeObserver(post);
    ro.observe(ref.current);
    post();
    return () => ro.disconnect();
  }, [embed, state]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("sending");
    setError(null);
    setFieldErrors({});
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/inbound/form", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, workspaceId }),
    }).catch(() => null);
    if (res?.ok) {
      setState("done");
      return;
    }
    const body = (await res?.json().catch(() => ({}))) as
      { error?: string; fields?: Record<string, string> } | undefined;
    setFieldErrors(body?.fields ?? {});
    setError(body?.error ?? "Something went wrong — please try again.");
    setState("idle");
  }

  if (state === "done") {
    return (
      <div ref={ref} className="flex flex-col items-center gap-2 py-8 text-center" role="status">
        <CheckCircle2Icon className="size-10 text-emerald-500" />
        <p className="font-medium">Thanks — we got your message.</p>
        <p className="text-sm text-muted-foreground">Check your inbox shortly for our reply.</p>
      </div>
    );
  }

  const field = (name: string) =>
    fieldErrors[name] ? { "aria-invalid": true as const, "aria-describedby": `${name}-err` } : {};
  return (
    <div ref={ref}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required {...field("name")} />
            {fieldErrors.name ? (
              <p id="name-err" className="text-xs text-destructive">
                {fieldErrors.name}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              {...field("email")}
            />
            {fieldErrors.email ? (
              <p id="email-err" className="text-xs text-destructive">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company">Company</Label>
          <Input id="company" name="company" autoComplete="organization" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="message">What would you like to automate?</Label>
          <Textarea
            id="message"
            name="message"
            rows={5}
            required
            placeholder="The process, rough budget and timeline help us reply faster."
            {...field("message")}
          />
          {fieldErrors.message ? (
            <p id="message-err" className="text-xs text-destructive">
              {fieldErrors.message}
            </p>
          ) : null}
        </div>
        {/* Honeypot: hidden from people and assistive tech, irresistible to bots. */}
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor="website_url">Website</label>
          <input id="website_url" name="website_url" tabIndex={-1} autoComplete="off" />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={state === "sending"}>
          {state === "sending" ? (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          ) : null}
          Send message
        </Button>
      </form>
    </div>
  );
}
