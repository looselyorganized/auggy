import { AlertTriangle, Inbox, Mail, MessageSquare } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { AgentMailConsoleLink } from "@/components/mail/AgentMailConsoleLink";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { selectMailDashboard } from "@/lib/mail-dashboard";
import type {
  MailDashboardProjection,
  MailDraftProjection,
  MailDraftState,
  MailInstanceProjection,
} from "@/lib/types";

export function MailRoute() {
  const { data, loading, error } = useDashboardContext();
  const projection = selectMailDashboard(data);

  if (loading && !data) {
    return <MailRouteState title="Mail" detail="Loading mail status…" role="status" />;
  }
  if (error && !data) {
    return <MailRouteState title="Mail unavailable" detail={error} role="alert" />;
  }
  if (!projection) return null;

  return <MailActionCenter projection={projection} />;
}

export function MailActionCenter({ projection }: { projection: MailDashboardProjection }) {
  const [selectedName, setSelectedName] = useState(projection.instances[0]?.augmentName ?? "");
  const selected =
    projection.instances.find((instance) => instance.augmentName === selectedName) ??
    projection.instances[0];

  useEffect(() => {
    if (!projection.instances.some((instance) => instance.augmentName === selectedName)) {
      setSelectedName(projection.instances[0]?.augmentName ?? "");
    }
  }, [projection.instances, selectedName]);

  if (!selected) return null;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl gap-4 p-3 sm:p-4">
        <section
          className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
          aria-labelledby="mail-title"
        >
          <div className="grid gap-1">
            <h2 id="mail-title" className="text-xl font-semibold tracking-normal">
              Mail
            </h2>
            <p className="text-sm text-muted-foreground">
              Review provider-native drafts with Auggy or open the same inbox in AgentMail.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            {projection.instances.length > 1 && (
              <label className="grid min-w-56 gap-1 text-xs font-medium" htmlFor="mail-instance">
                Inbox
                <select
                  id="mail-instance"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                  value={selected.augmentName}
                  onChange={(event) => setSelectedName(event.currentTarget.value)}
                >
                  {projection.instances.map((instance) => (
                    <option key={instance.augmentName} value={instance.augmentName}>
                      {instance.inboxEmail ?? instance.inboxId} · {instance.augmentName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <AgentMailConsoleLink instance={selected} />
          </div>
        </section>

        <InboxSummary instance={selected} />

        <Card>
          <CardHeader className="gap-1 p-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
              Review with Auggy
            </CardTitle>
            <CardDescription>
              In Chat, use <InlineCode>Show draft &lt;draft-id&gt;</InlineCode>, then ask for
              revisions. Sending always requires a fresh explicit{" "}
              <InlineCode>Send draft &lt;draft-id&gt;</InlineCode> command.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-end px-4 pb-4 pt-0">
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/chat/new">
              <MessageSquare aria-hidden="true" />
              Open Chat
            </Link>
          </CardContent>
        </Card>

        <DraftList instance={selected} />
      </div>
    </div>
  );
}

function InboxSummary({ instance }: { instance: MailInstanceProjection }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-md bg-primary/10 p-2 text-primary" aria-hidden="true">
            <Inbox className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-semibold">
                {instance.inboxEmail ?? "Inbox address unavailable"}
              </h3>
              <StatusBadge level={instance.status.level}>{instance.status.level}</StatusBadge>
              <Badge variant="outline">{instance.inbound.mode}</Badge>
              <Badge variant={instance.inbound.state === "ready" ? "success" : "secondary"}>
                {instance.inbound.state}
              </Badge>
              {instance.inbound.senderPolicy === "any" && (
                <Badge variant="warn">public senders</Badge>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {instance.inboxId} · {instance.augmentName}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{instance.status.message}</p>
            {instance.inbound.senderPolicy === "any" && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                Any sender may start an untrusted public email turn.
              </p>
            )}
          </div>
        </div>
        <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Replies</dt>
          <dd className="text-right">{instance.replies.mode}</dd>
          <dt className="text-muted-foreground">Reply all</dt>
          <dd className="text-right">{instance.replies.allowReplyAll ? "Allowed" : "Blocked"}</dd>
          {instance.inbound.globalMaxPerHour !== undefined && (
            <>
              <dt className="text-muted-foreground">Inbound limit</dt>
              <dd className="text-right">
                {instance.inbound.globalMaxPerHour}/hour ·{" "}
                {instance.inbound.perSenderMaxPerHour}/sender
              </dd>
            </>
          )}
          {instance.inbound.lastCatchUpAt && (
            <>
              <dt className="text-muted-foreground">Last catch-up</dt>
              <dd className="text-right">
                <time dateTime={instance.inbound.lastCatchUpAt}>
                  {formatTimestamp(instance.inbound.lastCatchUpAt)}
                </time>
              </dd>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function DraftList({ instance }: { instance: MailInstanceProjection }) {
  return (
    <Card>
      <CardHeader className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Mail className="size-4 text-muted-foreground" aria-hidden="true" />
              Managed drafts
            </CardTitle>
            <CardDescription className="mt-1.5">
              Metadata only. Draft content stays in AgentMail.
            </CardDescription>
          </div>
          <Badge variant="secondary">{instance.drafts.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        {instance.drafts.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-8 text-center">
            <div className="text-sm font-medium">No managed drafts</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Reply drafts created from inbound mail will appear here.
            </div>
          </div>
        ) : (
          <ol
            className="divide-y overflow-hidden rounded-md border bg-background"
            aria-label="Managed AgentMail drafts"
          >
            {instance.drafts.map((draft) => (
              <DraftRow key={draft.draftId} draft={draft} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function DraftRow({ draft }: { draft: MailDraftProjection }) {
  return (
    <li className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="break-all font-mono text-sm font-medium">{draft.draftId}</code>
          <DraftStateBadge state={draft.state} />
        </div>
        <dl className="mt-2 grid min-w-0 gap-x-3 gap-y-1 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Source message</dt>
          <dd className="break-all font-mono">{draft.sourceMessageId}</dd>
          <dt className="text-muted-foreground">Thread</dt>
          <dd className="break-all font-mono">{draft.threadId}</dd>
        </dl>
      </div>
      <time
        className="text-xs text-muted-foreground sm:text-right"
        dateTime={draft.providerUpdatedAt}
      >
        {formatTimestamp(draft.providerUpdatedAt)}
      </time>
    </li>
  );
}

function DraftStateBadge({ state }: { state: MailDraftState }) {
  const variant =
    state === "ready"
      ? "success"
      : state === "ambiguous" || state === "failed"
        ? "warn"
        : state === "sending" || state === "approved"
          ? "info"
          : "secondary";
  return <Badge variant={variant}>{draftStateLabel(state)}</Badge>;
}

function draftStateLabel(state: MailDraftState): string {
  switch (state) {
    case "ready":
      return "Ready for review";
    case "stale":
      return "Newer message received";
    case "approved":
      return "Approved";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "ambiguous":
      return "Send outcome unknown";
    case "failed":
      return "Needs attention";
  }
}

function StatusBadge({
  level,
  children,
}: {
  level: MailInstanceProjection["status"]["level"];
  children: ReactNode;
}) {
  return (
    <Badge variant={level === "ok" ? "success" : level === "warn" ? "warn" : "destructive"}>
      {children}
    </Badge>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function MailRouteState({
  title,
  detail,
  role,
}: {
  title: string;
  detail: string;
  role: "status" | "alert";
}) {
  return (
    <div className="grid h-full place-items-center p-6" role={role} aria-live="polite">
      <div className="max-w-md text-center">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
