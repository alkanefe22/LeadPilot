"use client";

import { Loader2Icon, SaveIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveSettings, type SettingsInput } from "@/app/(dashboard)/settings/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function SettingsForm({ initial, isAdmin }: { initial: SettingsInput; isAdmin: boolean }) {
  const [v, setV] = useState(initial);
  const [pending, start] = useTransition();
  const set = <K extends keyof SettingsInput>(k: K, value: SettingsInput[K]) =>
    setV((s) => ({ ...s, [k]: value }));
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);

  const save = () =>
    start(async () => {
      const res = await saveSettings(v);
      if (res.ok) toast.success("Settings saved — the next agent run uses them.");
      else toast.error(res.error);
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Ideal Customer Profile</CardTitle>
          <CardDescription>
            Plain text. Becomes part of the agent&apos;s system prompt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            aria-label="Ideal customer profile"
            value={v.icpText}
            onChange={(e) => set("icpText", e.target.value)}
            rows={10}
            disabled={!isAdmin}
            className="font-mono text-xs leading-relaxed"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Qualification rules</CardTitle>
          <CardDescription>How the agent should act on each kind of lead.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            aria-label="Qualification rules"
            value={v.qualificationRules}
            onChange={(e) => set("qualificationRules", e.target.value)}
            rows={8}
            disabled={!isAdmin}
            className="font-mono text-xs leading-relaxed"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent behaviour</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Qualification threshold</Label>
              <span className="font-mono text-lg font-semibold tabular-nums">
                {v.scoreThreshold}
              </span>
            </div>
            <Slider
              value={v.scoreThreshold}
              min={1}
              max={100}
              step={1}
              onValueChange={(val) =>
                set("scoreThreshold", Array.isArray(val) ? (val[0] ?? 70) : (val as number))
              }
              disabled={!isAdmin}
              aria-label="Qualification threshold"
            />
            <p className="text-xs text-muted-foreground">
              Leads scoring at or above this (and categorized as a fit) get a meeting booked.
            </p>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="approval">Require approval before booking / sending</Label>
              <p className="text-xs text-muted-foreground">
                Outward actions go to the Approvals queue instead of executing.
              </p>
            </div>
            <Switch
              id="approval"
              checked={v.requireApproval}
              onCheckedChange={(c) => set("requireApproval", c)}
              disabled={!isAdmin}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="duration">Meeting length (min)</Label>
              <Input
                id="duration"
                type="number"
                min={15}
                max={60}
                step={5}
                value={v.meetingDurationMin}
                onChange={(e) => set("meetingDurationMin", Number(e.target.value))}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tz">Timezone (IANA)</Label>
              <Input
                id="tz"
                value={v.timezone}
                onChange={(e) => set("timezone", e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sender">Email sender name</Label>
              <Input
                id="sender"
                value={v.senderName}
                onChange={(e) => set("senderName", e.target.value)}
                disabled={!isAdmin}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 flex items-center justify-end gap-3">
        {!isAdmin ? (
          <span className="text-xs text-muted-foreground">
            Read-only — admin login required to edit.
          </span>
        ) : null}
        <Button onClick={save} disabled={!isAdmin || !dirty || pending}>
          {pending ? (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          ) : (
            <SaveIcon data-icon="inline-start" />
          )}
          Save settings
        </Button>
      </div>
    </div>
  );
}
