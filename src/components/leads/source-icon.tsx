import { FileTextIcon, MailIcon, SparklesIcon, SproutIcon, WebhookIcon } from "lucide-react";
import type { LeadSource } from "@/server/db/schema";

const ICONS = {
  form: FileTextIcon,
  email: MailIcon,
  webhook: WebhookIcon,
  simulated: SparklesIcon,
  seed: SproutIcon,
} as const;

export function SourceLabel({ source }: { source: LeadSource }) {
  const Icon = ICONS[source];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground capitalize">
      <Icon className="size-3.5" />
      {source}
    </span>
  );
}
