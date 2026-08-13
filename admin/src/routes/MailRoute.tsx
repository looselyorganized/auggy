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

  return <MailActionCenter projection={projection} refreshError={error ?? undefined} />;
}

export function MailActionCenter({
  projection,
  refreshError,
}: {
  projection: MailDashboardProjection;
  refreshError?: string;
}) {
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
              Review drafts with Auggy or open the inbox in AgentMail.
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

        {(refreshError || needsAttention(selected)) && (
          <MailHealthNotice instance={selected} refreshError={refreshError} />
        )}

        <Card>
          <CardHeader className="gap-1 p-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
              Review with Auggy
            </CardTitle>
            <CardDescription>
              In Chat, ask Auggy to <InlineCode>show draft &lt;draft-id&gt;</InlineCode>, then request
              revisions. Sending requires a fresh exact{" "}
              <InlineCode>send draft &lt;draft-id&gt;</InlineCode> command.
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
                {inboundStateLabel(instance.inbound.state)}
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
              Drafts created or tracked by Auggy will appear here.
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
          {draft.sourceMessageId && (
            <>
              <dt className="text-muted-foreground">Source message</dt>
              <dd className="break-all font-mono">{draft.sourceMessageId}</dd>
            </>
          )}
          {draft.threadId && (
            <>
              <dt className="text-muted-foreground">Thread</dt>
              <dd className="break-all font-mono">{draft.threadId}</dd>
            </>
          )}
          {!draft.sourceMessageId && !draft.threadId && (
            <>
              <dt className="text-muted-foreground">Origin</dt>
              <dd>New message draft</dd>
            </>
          )}
          {draft.sendAt && (
            <>
              <dt className="text-muted-foreground">
                {draft.state === "scheduled" ? "Scheduled for" : "Provider send time"}
              </dt>
              <dd>
                <time dateTime={draft.sendAt}>{formatTimestamp(draft.sendAt)}</time>
              </dd>
            </>
          )}
          {draft.retryOperationId && (
            <>
              <dt className="text-muted-foreground">Retry in Chat</dt>
              <dd>
                <InlineCode>retry mail delivery {draft.retryOperationId}</InlineCode>
              </dd>
            </>
          )}
          {draft.retryAt && (
            <>
              <dt className="text-muted-foreground">Retry after</dt>
              <dd>
                <time dateTime={draft.retryAt}>{formatTimestamp(draft.retryAt)}</time>
              </dd>
            </>
          )}
        </dl>
      </div>
      <time
        className="text-xs text-muted-foreground sm:text-right"
        dateTime={draft.providerUpdatedAt}
        aria-label="Provider updated"
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
      : state === "ambiguous" || state === "failed" || state === "retryable"
        ? "warn"
        : state === "sending" || state === "approved" || state === "scheduled"
          ? "info"
          : "secondary";
  return <Badge variant={variant}>{draftStateLabel(state)}</Badge>;
}

function draftStateLabel(state: MailDraftState): string {
  switch (state) {
    case "ready":
      return "Ready for review";
    case "scheduled":
      return "Scheduled in AgentMail";
    case "stale":
      return "Changed in AgentMail";
    case "approved":
      return "Approved";
    case "sending":
      return "Sending";
    case "retryable":
      return "Retry required";
    case "sent":
      return "Sent";
    case "ambiguous":
      return "Send outcome unknown";
    case "failed":
      return "Needs attention";
    case "deleted":
      return "Deleted in AgentMail";
  }
}

function needsAttention(instance: MailInstanceProjection): boolean {
  return (
    instance.status.level !== "ok" ||
    instance.inbound.state === "degraded" ||
    (instance.inbound.mode === "websocket" && instance.inbound.state === "stopped")
  );
}

function MailHealthNotice({
  instance,
  refreshError,
}: {
  instance: MailInstanceProjection;
  refreshError?: string;
}) {
  const isRefreshFailure = Boolean(refreshError);
  const isUnavailable = instance.status.level === "error";
  const title = isUnavailable
    ? "Mail is unavailable"
    : isRefreshFailure
      ? "Mail status may be stale"
      : "Mail needs attention";
  const detail = isUnavailable
    ? instance.status.message
    : isRefreshFailure
      ? refreshError
      : instance.status.message;

  return (
    <Card
      className={isUnavailable ? "border-destructive/40" : "border-amber-500/40"}
      role="alert"
    >
      <CardContent className="flex items-start gap-3 p-4">
        <AlertTriangle
          className={
            isUnavailable
              ? "mt-0.5 size-4 shrink-0 text-destructive"
              : "mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300"
          }
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div
            className={
              isUnavailable ? "text-sm font-medium text-destructive" : "text-sm font-medium"
            }
          >
            {title}
          </div>
          <p className="mt-1 break-words text-xs text-muted-foreground">{detail}</p>
          {isUnavailable && refreshError && (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              Latest dashboard refresh also failed: {refreshError}
            </p>
          )}
          {instance.inbound.lastErrorCode && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Error code: {instance.inbound.lastErrorCode}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function inboundStateLabel(state: MailInstanceProjection["inbound"]["state"]): string {
  switch (state) {
    case "catching_up":
      return "catching up";
    default:
      return state;
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
    <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
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
