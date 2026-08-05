import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Clock3, Inbox, Mail, Send, UserRound } from "lucide-react";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { AgentMailConsoleLink } from "@/components/mail/AgentMailConsoleLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/lib/confirm";
import {
  fetchMailDetail,
  isStaleMailActionResult,
  MailDetailError,
  MAX_MAIL_BODY_CHARS,
  postMailAction,
  type MailDetail,
  type MailReviewDetail,
} from "@/lib/mail-api";
import { selectMailDashboard } from "@/lib/mail-dashboard";
import { useToast } from "@/lib/toast";
import type {
  CsrfToken,
  MailAttentionProjection,
  MailDashboardProjection,
  MailInstanceProjection,
  MailReviewProjection,
} from "@/lib/types";

interface MailApi {
  fetchDetail: typeof fetchMailDetail;
  postAction: typeof postMailAction;
}

const DEFAULT_API: MailApi = {
  fetchDetail: fetchMailDetail,
  postAction: postMailAction,
};

export function MailRoute() {
  const { data, loading, error, refresh } = useDashboardContext();
  const projection = selectMailDashboard(data);

  if (loading && !data) {
    return <MailRouteState title="Mail" detail="Loading inbox activity…" role="status" />;
  }
  if (error && !data) {
    return <MailRouteState title="Mail unavailable" detail={error} role="alert" />;
  }
  if (!projection) return null;

  return (
    <MailActionCenter
      projection={projection}
      csrfTokens={data?.csrfTokens ?? []}
      refresh={refresh}
    />
  );
}

export function MailActionCenter({
  projection,
  csrfTokens,
  refresh,
  api = DEFAULT_API,
}: {
  projection: MailDashboardProjection;
  csrfTokens: CsrfToken[];
  refresh: () => Promise<void>;
  api?: MailApi;
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
  const activeCount = selected.reviews.length + selected.attention.length;

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
              Review proposed replies and messages that need creator attention.
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

        <InboxSummary instance={selected} activeCount={activeCount} />

        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <ReviewQueue
            key={`reviews:${selected.augmentName}`}
            instance={selected}
            csrfTokens={csrfTokens}
            refresh={refresh}
            api={api}
          />
          <AttentionQueue
            key={`attention:${selected.augmentName}`}
            instance={selected}
            csrfTokens={csrfTokens}
            refresh={refresh}
            api={api}
          />
        </div>
      </div>
    </div>
  );
}

function InboxSummary({
  instance,
  activeCount,
}: {
  instance: MailInstanceProjection;
  activeCount: number;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
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
              {instance.inbound.senderPolicy === "allowlist" && (
                <Badge variant="outline">
                  {instance.inbound.allowedSenderCount ?? 0} allowed sender
                  {(instance.inbound.allowedSenderCount ?? 0) === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {instance.inboxId} · {instance.augmentName}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{instance.status.message}</p>
            {instance.inbound.senderPolicy === "any" && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                Any well-formed sender may start an untrusted public email turn.
              </p>
            )}
            {instance.inbound.rateLimit && (
              <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                <p>
                  Inbound quota: {instance.inbound.rateLimit.rollingGlobalUsage}/
                  {instance.inbound.rateLimit.globalMaxPerHour} admitted this rolling hour · max{" "}
                  {instance.inbound.rateLimit.perSenderMaxPerHour} per sender ·{" "}
                  {instance.inbound.rateLimit.globalRejections} global /{" "}
                  {instance.inbound.rateLimit.perSenderRejections} per-sender rejected total
                </p>
                {instance.inbound.rateLimit.lastRejectedAt && (
                  <p>
                    Last rejection: {formatTimestamp(instance.inbound.rateLimit.lastRejectedAt)}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <div className="text-2xl font-semibold tabular-nums">{activeCount}</div>
          <div className="text-xs text-muted-foreground">items needing attention</div>
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewQueue(props: QueueProps) {
  const { instance, ...queueProps } = props;
  const [selection, setSelection] = useState<MailReviewProjection | null>(null);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold leading-none">Pending review</h3>
            <CardDescription className="mt-1.5">
              Exact content loads only when you open an item.
            </CardDescription>
          </div>
          <Badge variant={instance.reviews.length > 0 ? "warn" : "secondary"}>
            {instance.reviews.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {instance.reviews.length === 0 ? (
          <EmptyQueue>No email proposals are waiting for review.</EmptyQueue>
        ) : (
          <ol className="grid gap-2" aria-label="Pending email reviews">
            {instance.reviews.map((review) => (
              <li key={review.rowKey}>
                <button
                  type="button"
                  className="grid w-full gap-2 rounded-md border bg-background p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => setSelection(review)}
                  aria-label={`Review ${review.subject || "(no subject)"}`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">
                      {review.subject || "(no subject)"}
                    </span>
                    <MailStateBadge state={review.status} />
                  </div>
                  <MetadataLine icon={<UserRound />} label="To" value={review.correspondent} />
                  <MetadataLine
                    icon={<Clock3 />}
                    label={review.updatedAt ? "Updated" : "Expires"}
                    value={formatTimestamp(review.updatedAt ?? review.expiresAt)}
                  />
                </button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <ReviewDetailDialog
        key={selection?.rowKey ?? "closed"}
        instance={instance}
        review={selection}
        onClose={() => setSelection(null)}
        {...queueProps}
      />
    </Card>
  );
}

function AttentionQueue(props: QueueProps) {
  const { instance, ...queueProps } = props;
  const [selection, setSelection] = useState<MailAttentionProjection | null>(null);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold leading-none">Creator attention</h3>
            <CardDescription className="mt-1.5">
              Inbound messages that need a decision or reconciliation.
            </CardDescription>
          </div>
          <Badge variant={instance.attention.length > 0 ? "warn" : "secondary"}>
            {instance.attention.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {instance.attention.length === 0 ? (
          <EmptyQueue>No inbound messages need creator attention.</EmptyQueue>
        ) : (
          <ol className="grid gap-2" aria-label="Email creator attention">
            {instance.attention.map((item) => (
              <li key={item.rowKey}>
                <button
                  type="button"
                  className="grid w-full gap-2 rounded-md border bg-background p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => setSelection(item)}
                  aria-label={`Open ${item.subject ?? `message ${item.messageId}`}`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">
                      {item.subject ?? `Message ${item.messageId}`}
                    </span>
                    <MailStateBadge state={item.status} />
                  </div>
                  <MetadataLine
                    icon={<UserRound />}
                    label="From"
                    value={item.sender ?? "Sender metadata unavailable"}
                  />
                  <MetadataLine
                    icon={<Clock3 />}
                    label={item.receivedAt ? "Received" : "Updated"}
                    value={formatTimestamp(item.receivedAt ?? item.updatedAt)}
                  />
                </button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <AttentionDetailDialog
        key={selection?.rowKey ?? "closed"}
        instance={instance}
        item={selection}
        onClose={() => setSelection(null)}
        {...queueProps}
      />
    </Card>
  );
}

interface QueueProps {
  instance: MailInstanceProjection;
  csrfTokens: CsrfToken[];
  refresh: () => Promise<void>;
  api: MailApi;
}

export function MailQueuedActionSummary({ detail }: { detail: MailReviewDetail }) {
  const { request } = detail;
  return (
    <section
      className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm"
      aria-labelledby="mail-queued-action-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="mail-queued-action-title" className="font-medium">
          Exact queued action
        </h4>
        <Badge variant="outline">{request.kind}</Badge>
      </div>
      <div className="grid gap-2">
        <DetailRow label="Subject" value={detail.subject || "(no subject)"} />
        <DetailRow
          label="Recipients"
          value={detail.recipients.length > 0 ? detail.recipients.join(", ") : "(none)"}
        />
        {request.kind !== "send" && (
          <DetailRow label="Message ID" value={request.messageId} />
        )}
        {request.kind === "reply" && (
          <DetailRow
            label="Reply all"
            value={request.replyAll === true ? "Yes" : request.replyAll === false ? "No" : "No (default)"}
          />
        )}
        <DetailRow
          label="Labels"
          value={request.labels.length > 0 ? request.labels.join(", ") : "(none)"}
        />
        <DetailRow label="Trust" value={detail.trustLevel} />
        <DetailRow label="Expires" value={formatTimestamp(detail.expiresAt)} />
      </div>
      <div>
        <h5 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Plain-text body
        </h5>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-sm">
          {request.text || "(no additional plain-text body)"}
        </pre>
      </div>
      {request.html !== undefined && (
        <details className="rounded-md border bg-background p-3 text-sm">
          <summary className="cursor-pointer font-medium">Queued HTML source</summary>
          <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">
            {request.html || "(empty HTML body)"}
          </pre>
        </details>
      )}
    </section>
  );
}

export function buildReviewSentRecoveryValues(
  fingerprint: string,
  values: {
    messageId: string;
    threadId: string;
    evidence: string;
  },
): Record<string, string> {
  const threadId = values.threadId.trim();
  return {
    fingerprint: fingerprint.trim(),
    messageId: values.messageId.trim(),
    ...(threadId ? { threadId } : {}),
    evidence: values.evidence.trim(),
  };
}

export function buildReviewFailedRecoveryValues(
  fingerprint: string,
  reason: string,
): Record<string, string> {
  return {
    fingerprint: fingerprint.trim(),
    reason: reason.trim(),
  };
}

export function buildAttentionRecoveryValues(
  version: number,
  evidence: string,
): Record<string, string> {
  return {
    version: String(version),
    evidence: evidence.trim(),
  };
}

export function isMailBodyWithinLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_MAIL_BODY_CHARS;
}

function ReviewDetailDialog({
  instance,
  review,
  onClose,
  csrfTokens,
  refresh,
  api,
}: QueueProps & {
  review: MailReviewProjection | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStale, setActionStale] = useState(false);
  const [revision, setRevision] = useState("");
  const [providerMessageId, setProviderMessageId] = useState("");
  const [providerThreadId, setProviderThreadId] = useState("");
  const [sentEvidence, setSentEvidence] = useState("");
  const [failedEvidence, setFailedEvidence] = useState("");
  const requestId = useRef(0);
  const confirm = useConfirm();
  const { push } = useToast();

  useEffect(() => {
    if (!review) return;
    const id = ++requestId.current;
    setLoading(true);
    setDetail(null);
    setDetailError(null);
    void api
      .fetchDetail(review.detailPath)
      .then((next) => {
        if (requestId.current !== id) return;
        setDetail(next);
        setRevision(next.kind === "review" ? next.request.text : "");
      })
      .catch((error) => {
        if (requestId.current === id) {
          if (
            error instanceof MailDetailError &&
            (error.code === "stale" || error.code === "not-found")
          ) {
            setActionStale(true);
          }
          setDetailError(error instanceof Error ? error.message : "Mail details are unavailable.");
        }
      })
      .finally(() => {
        if (requestId.current === id) setLoading(false);
      });
    return () => {
      requestId.current++;
    };
  }, [api, review]);

  const exactReview =
    detail?.kind === "review" && review && detail.reviewId === review.reviewId ? detail : null;

  async function mutate(
    actionId: string,
    label: string,
    values: Record<string, string>,
    destructive = false,
    confirmMessage?: string,
  ) {
    if (!review || busy) return;
    const confirmed = await confirm({
      title: label,
      message: confirmMessage ?? `${label} for “${review.subject}”?`,
      destructive,
      confirmLabel: label,
    });
    if (!confirmed) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await api.postAction({
        tokens: csrfTokens,
        augmentName: instance.augmentName,
        actionId,
        rowKey: review.rowKey,
        values,
      });
      if (result.csrfExpired) {
        window.location.reload();
        return;
      }
      if (!result.ok) {
        const stale = isStaleMailActionResult(result);
        if (stale) setActionStale(true);
        setActionError(mailActionFailureMessage(result, "The mail action failed."));
        push("error", stale ? "Mail item changed" : "Mail action failed", result.message);
        if (stale) await refresh();
        return;
      }
      push("success", label, result.message);
      await refresh();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The mail action failed.";
      setActionError(message);
      push("error", "Mail action failed", message);
    } finally {
      setBusy(false);
    }
  }

  const approve = review?.actions.approve;
  const revise = review?.actions.revise;
  const reject = review?.actions.reject;
  const reconcileSent = review?.actions.reconcileSent;
  const reconcileFailed = review?.actions.reconcileFailed;
  const canApprove =
    !!review &&
    !actionStale &&
    !!exactReview &&
    exactReview.state === "pending" &&
    !!approve &&
    hasExactToken(csrfTokens, instance.augmentName, approve.actionId, review.rowKey);
  const canRevise =
    !!review &&
    !actionStale &&
    !!exactReview &&
    exactReview.state === "pending" &&
    !!revise &&
    revision.trim().length > 0 &&
    isMailBodyWithinLimit(revision) &&
    hasExactToken(csrfTokens, instance.augmentName, revise.actionId, review.rowKey);
  const canReject =
    !!review &&
    !actionStale &&
    !!reject &&
    hasExactToken(csrfTokens, instance.augmentName, reject.actionId, review.rowKey);
  const canReconcileSent =
    !!review &&
    !actionStale &&
    exactReview?.state === "sending" &&
    !!reconcileSent &&
    providerMessageId.trim().length > 0 &&
    providerMessageId.trim().length <= 256 &&
    providerThreadId.trim().length <= 256 &&
    sentEvidence.trim().length > 0 &&
    sentEvidence.trim().length <= 400 &&
    hasExactToken(
      csrfTokens,
      instance.augmentName,
      reconcileSent.actionId,
      review.rowKey,
    );
  const canReconcileFailed =
    !!review &&
    !actionStale &&
    exactReview?.state === "sending" &&
    !!reconcileFailed &&
    failedEvidence.trim().length > 0 &&
    failedEvidence.trim().length <= 400 &&
    hasExactToken(
      csrfTokens,
      instance.augmentName,
      reconcileFailed.actionId,
      review.rowKey,
    );

  return (
    <Dialog open={review !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{review?.subject || "Email review"}</DialogTitle>
          <DialogDescription>
            {review ? `Review ${review.reviewId} · ${review.correspondent}` : "Email review"}
          </DialogDescription>
        </DialogHeader>

        {loading && <DialogState role="status">Loading exact queued content…</DialogState>}
        {detailError && <DialogState role="alert">{detailError}</DialogState>}
        {actionError && <MailActionFeedback message={actionError} />}
        {exactReview && (
          <div className="grid gap-4">
            <MailQueuedActionSummary detail={exactReview} />
            {exactReview.state === "pending" && revise && (
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="mail-revision">
                Revised plain-text message
                <Textarea
                  id="mail-revision"
                  rows={10}
                  value={revision}
                  disabled={busy}
                  maxLength={MAX_MAIL_BODY_CHARS}
                  onChange={(event) => setRevision(event.currentTarget.value)}
                  aria-describedby="mail-revision-help"
                />
                <span id="mail-revision-help" className="text-xs font-normal text-muted-foreground">
                  Approve sends the exact queued action shown above. Only Revise &amp; send uses
                  this editor and submits a new fingerprint-bound attempt.
                </span>
              </label>
            )}
            {exactReview.state === "sending" && (reconcileSent || reconcileFailed) && (
              <section
                className="grid gap-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3"
                aria-labelledby="mail-review-recovery-title"
              >
                <div className="grid gap-1">
                  <h4 id="mail-review-recovery-title" className="text-sm font-medium">
                    Resolve uncertain delivery
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Use these controls only after independently verifying the provider outcome.
                    They reconcile state and never send email themselves.
                  </p>
                </div>
                {reconcileSent && (
                  <div className="grid gap-3">
                    <label className="grid gap-1.5 text-sm font-medium" htmlFor="mail-provider-id">
                      Provider message ID
                      <Input
                        id="mail-provider-id"
                        value={providerMessageId}
                        disabled={busy}
                        maxLength={256}
                        onChange={(event) => setProviderMessageId(event.currentTarget.value)}
                      />
                    </label>
                    <label
                      className="grid gap-1.5 text-sm font-medium"
                      htmlFor="mail-provider-thread-id"
                    >
                      Provider thread ID (optional)
                      <Input
                        id="mail-provider-thread-id"
                        value={providerThreadId}
                        disabled={busy}
                        maxLength={256}
                        onChange={(event) => setProviderThreadId(event.currentTarget.value)}
                      />
                    </label>
                    <label
                      className="grid gap-1.5 text-sm font-medium"
                      htmlFor="mail-sent-evidence"
                    >
                      Evidence that the message was sent
                      <Textarea
                        id="mail-sent-evidence"
                        rows={3}
                        value={sentEvidence}
                        disabled={busy}
                        maxLength={400}
                        onChange={(event) => setSentEvidence(event.currentTarget.value)}
                      />
                    </label>
                  </div>
                )}
                {reconcileFailed && (
                  <label
                    className="grid gap-1.5 text-sm font-medium"
                    htmlFor="mail-failed-evidence"
                  >
                    Evidence that no message was sent
                    <Textarea
                      id="mail-failed-evidence"
                      rows={3}
                      value={failedEvidence}
                      disabled={busy}
                      maxLength={400}
                      onChange={(event) => setFailedEvidence(event.currentTarget.value)}
                    />
                  </label>
                )}
              </section>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:flex-wrap">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {reject && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !canReject}
              title={
                canReject
                  ? undefined
                  : "Reject is unavailable without exact row authorization."
              }
              onClick={() =>
                void mutate(
                  reject.actionId,
                  "Reject",
                  { reason: "Rejected in the Mail action center" },
                  true,
                )
              }
            >
              Reject
            </Button>
          )}
          {revise && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !canRevise}
              title={
                canRevise
                  ? undefined
                  : "Revise and send requires a pending detail, non-empty text, and exact row authorization."
              }
              onClick={() =>
                void mutate(revise.actionId, "Revise & send", {
                  fingerprint: exactReview!.fingerprint,
                  text: revision,
                })
              }
            >
              Revise &amp; send
            </Button>
          )}
          {approve && (
            <Button
              type="button"
              disabled={busy || !canApprove}
              title={
                canApprove
                  ? undefined
                  : "Approve and send requires a pending detail and exact row authorization."
              }
              onClick={() =>
                void mutate(approve.actionId, "Approve & send", {
                  fingerprint: exactReview!.fingerprint,
                })
              }
            >
              <Send data-icon="inline-start" />
              Approve &amp; send
            </Button>
          )}
          {reconcileFailed && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !canReconcileFailed}
              title={
                canReconcileFailed
                  ? undefined
                  : "Confirm not sent requires verified evidence and exact row authorization."
              }
              onClick={() =>
                void mutate(
                  reconcileFailed.actionId,
                  "Confirm not sent",
                  buildReviewFailedRecoveryValues(
                    exactReview!.fingerprint,
                    failedEvidence,
                  ),
                  true,
                  "Confirm that provider verification found no sent message? This closes the uncertain attempt as failed and permits a later retry; it does not send now.",
                )
              }
            >
              Confirm not sent
            </Button>
          )}
          {reconcileSent && (
            <Button
              type="button"
              disabled={busy || !canReconcileSent}
              title={
                canReconcileSent
                  ? undefined
                  : "Confirm sent requires provider IDs, verified evidence, and exact row authorization."
              }
              onClick={() =>
                void mutate(
                  reconcileSent.actionId,
                  "Confirm sent",
                  buildReviewSentRecoveryValues(exactReview!.fingerprint, {
                    messageId: providerMessageId,
                    threadId: providerThreadId,
                    evidence: sentEvidence,
                  }),
                  false,
                  "Confirm that provider verification proves this exact message was sent? This records the provider IDs and closes the attempt without resending.",
                )
              }
            >
              Confirm sent
            </Button>
          )}
        </DialogFooter>
        {busy && (
          <p className="sr-only" role="status" aria-live="polite">
            Applying mail action…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttentionDetailDialog({
  instance,
  item,
  onClose,
  csrfTokens,
  refresh,
  api,
}: QueueProps & {
  item: MailAttentionProjection | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionStale, setActionStale] = useState(false);
  const [recoveryEvidence, setRecoveryEvidence] = useState("");
  const confirm = useConfirm();
  const { push } = useToast();

  useEffect(() => {
    if (!item?.detailPath) return;
    let current = true;
    setLoading(true);
    setError(null);
    void api
      .fetchDetail(item.detailPath)
      .then((next) => current && setDetail(next))
      .catch((reason) => {
        if (current) {
          if (
            reason instanceof MailDetailError &&
            reason.code === "stale"
          ) {
            setActionStale(true);
          }
          setError(reason instanceof Error ? reason.message : "Mail details are unavailable.");
        }
      })
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [api, item]);

  const dismiss = item?.actions.dismiss;
  const reconcileProcessed = item?.actions.reconcileProcessed;
  const reconcilePending = item?.actions.reconcilePending;
  const canDismiss =
    !!item &&
    !actionStale &&
    !!dismiss &&
    hasExactToken(csrfTokens, instance.augmentName, dismiss.actionId, item.rowKey);
  const validRecoveryEvidence =
    recoveryEvidence.trim().length > 0 && recoveryEvidence.trim().length <= 400;
  const canReconcileProcessed =
    !!item &&
    item.status === "ambiguous" &&
    !actionStale &&
    !!reconcileProcessed &&
    validRecoveryEvidence &&
    hasExactToken(
      csrfTokens,
      instance.augmentName,
      reconcileProcessed.actionId,
      item.rowKey,
    );
  const canReconcilePending =
    !!item &&
    item.status === "ambiguous" &&
    !actionStale &&
    !!reconcilePending &&
    validRecoveryEvidence &&
    hasExactToken(
      csrfTokens,
      instance.augmentName,
      reconcilePending.actionId,
      item.rowKey,
    );

  async function applyAttentionAction({
    actionId,
    label,
    values,
    message,
    destructive = false,
  }: {
    actionId: string;
    label: string;
    values: Record<string, string>;
    message: string;
    destructive?: boolean;
  }) {
    if (!item || busy) return;
    const confirmed = await confirm({
      title: label,
      message,
      destructive,
      confirmLabel: label,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.postAction({
        tokens: csrfTokens,
        augmentName: instance.augmentName,
        actionId,
        rowKey: item.rowKey,
        values,
      });
      if (result.csrfExpired) {
        window.location.reload();
        return;
      }
      if (!result.ok) {
        const stale = isStaleMailActionResult(result);
        if (stale) setActionStale(true);
        setError(mailActionFailureMessage(result, `${label} failed.`));
        push("error", stale ? "Mail item changed" : `${label} failed`, result.message);
        if (stale) await refresh();
        return;
      }
      push("success", label, result.message);
      await refresh();
      onClose();
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : `${label} failed.`;
      setError(failure);
      push("error", `${label} failed`, failure);
    } finally {
      setBusy(false);
    }
  }

  const messageDetail =
    detail?.kind === "message" && item && detail.messageId === item.messageId ? detail : null;

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item?.subject ?? "Creator attention"}</DialogTitle>
          <DialogDescription>
            {item ? `Message ${item.messageId} · version ${item.version}` : "Inbound message"}
          </DialogDescription>
        </DialogHeader>
        {loading && <DialogState role="status">Loading message details…</DialogState>}
        {error && <DialogState role="alert">{error}</DialogState>}
        {!item?.detailPath && (
          <DialogState role="status">
            Exact message details are not available from this runtime.
          </DialogState>
        )}
        {messageDetail && (
          <div className="grid gap-4">
            <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm">
              <DetailRow label="From" value={messageDetail.sender} />
              <DetailRow label="Received" value={formatTimestamp(messageDetail.receivedAt)} />
            </div>
            {messageDetail.text && (
              <div>
                <h4 className="mb-2 text-sm font-medium">Plain-text message</h4>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm">
                  {messageDetail.text}
                </pre>
              </div>
            )}
            {messageDetail.html && (
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer font-medium">HTML source</summary>
                <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {messageDetail.html}
                </pre>
              </details>
            )}
          </div>
        )}
        {item?.status === "ambiguous" && (reconcileProcessed || reconcilePending) && (
          <section
            className="grid gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3"
            aria-labelledby="mail-attention-recovery-title"
          >
            <div className="grid gap-1">
              <h4 id="mail-attention-recovery-title" className="text-sm font-medium">
                Resolve uncertain processing
              </h4>
              <p className="text-xs text-muted-foreground">
                Use only after independently verifying whether the inbound message caused external
                effects. These controls reconcile state and do not process the message themselves.
              </p>
            </div>
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="mail-attention-evidence"
            >
              Verification evidence
              <Textarea
                id="mail-attention-evidence"
                rows={3}
                value={recoveryEvidence}
                disabled={busy}
                maxLength={400}
                onChange={(event) => setRecoveryEvidence(event.currentTarget.value)}
              />
            </label>
          </section>
        )}
        <DialogFooter className="gap-2 sm:flex-wrap">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {dismiss && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !canDismiss}
              title={
                canDismiss
                  ? undefined
                  : "Dismiss is unavailable without exact row authorization."
              }
              onClick={() =>
                void applyAttentionAction({
                  actionId: dismiss.actionId,
                  label: "Dismiss creator attention",
                  values: { expectedVersion: String(item!.version) },
                  message:
                    "Dismiss this attention item? This does not send email or resolve an ambiguous external effect.",
                  destructive: true,
                })
              }
            >
              Dismiss
            </Button>
          )}
          {reconcilePending && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !canReconcilePending}
              title={
                canReconcilePending
                  ? undefined
                  : "Confirm no effect requires verified evidence and exact row authorization."
              }
              onClick={() =>
                void applyAttentionAction({
                  actionId: reconcilePending.actionId,
                  label: "Confirm no effect & retry",
                  values: buildAttentionRecoveryValues(item!.version, recoveryEvidence),
                  message:
                    "Confirm that verification found no external effect? This marks the incident pending and permits the message to be retried; it does not retry it now.",
                  destructive: true,
                })
              }
            >
              Confirm no effect &amp; retry
            </Button>
          )}
          {reconcileProcessed && (
            <Button
              type="button"
              disabled={busy || !canReconcileProcessed}
              title={
                canReconcileProcessed
                  ? undefined
                  : "Confirm processed requires verified evidence and exact row authorization."
              }
              onClick={() =>
                void applyAttentionAction({
                  actionId: reconcileProcessed.actionId,
                  label: "Confirm processed",
                  values: buildAttentionRecoveryValues(item!.version, recoveryEvidence),
                  message:
                    "Confirm that verification proves external effects already occurred? This closes the incident as processed and prevents retry.",
                })
              }
            >
              Confirm processed
            </Button>
          )}
        </DialogFooter>
        {busy && (
          <p className="sr-only" role="status" aria-live="polite">
            Applying mail action…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function hasExactToken(
  tokens: CsrfToken[],
  augmentName: string,
  actionId: string,
  rowKey: string,
): boolean {
  return tokens.filter(
    (token) =>
      token.augmentName === augmentName &&
      token.actionId === actionId &&
      token.rowKey === rowKey &&
      token.token.length > 0,
  ).length === 1;
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
    <div className="grid h-full place-items-center p-4">
      <Card className="w-full max-w-xl" role={role}>
        <CardHeader>
          <h2 className="font-semibold leading-none">{title}</h2>
          <CardDescription>{detail}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function EmptyQueue({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-32 place-items-center rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
      <span>
        <Mail className="mx-auto mb-2 size-5" aria-hidden="true" />
        {children}
      </span>
    </div>
  );
}

function MetadataLine({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="[&>svg]:size-3.5" aria-hidden="true">
        {icon}
      </span>
      <span className="shrink-0">{label}:</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[5rem_minmax(0,1fr)]">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

function DialogState({
  role,
  children,
}: {
  role: "status" | "alert";
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function mailActionFailureMessage(
  result: { ok: boolean; message: string; conflict?: boolean; status?: number },
  fallback: string,
): string {
  return isStaleMailActionResult({
    ...result,
    csrfExpired: false,
  })
    ? "This item changed while it was open. The action was not applied; review the refreshed queue."
    : result.message || fallback;
}

export function MailActionFeedback({ message }: { message: string }) {
  return <DialogState role="alert">{message}</DialogState>;
}

function MailStateBadge({ state }: { state: string }) {
  const variant =
    state === "pending" || state === "pending_review"
      ? "warn"
      : state === "sending" || state === "ambiguous"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{state.replaceAll("_", " ")}</Badge>;
}

function StatusBadge({
  level,
  children,
}: {
  level: "ok" | "warn" | "error";
  children: ReactNode;
}) {
  return (
    <Badge variant={level === "ok" ? "success" : level === "warn" ? "warn" : "destructive"}>
      {children}
    </Badge>
  );
}

export function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
