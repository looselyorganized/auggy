import { ExternalLink } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { MailInstanceProjection } from "@/lib/types";

export function AgentMailConsoleLink({ instance }: { instance: MailInstanceProjection }) {
  if (!instance.externalConsoleUrl) return null;
  const inboxLabel = instance.inboxEmail ?? instance.inboxId;

  return (
    <a
      className={buttonVariants({ variant: "outline", size: "sm" })}
      href={instance.externalConsoleUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${inboxLabel} in AgentMail (opens in a new tab)`}
    >
      <ExternalLink aria-hidden="true" />
      Open in AgentMail
    </a>
  );
}
