import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { findCsrfToken, type AdminFetch } from "@/lib/api";
import { parseSSEStream, type AGUIEvent } from "@/lib/ag-ui-parse";
import {
  deleteConsoleChatThread,
  getConsoleChatThread,
  isConsoleChatApiError,
  listConsoleChatThreads,
  renameConsoleChatThread,
  setConsoleChatThreadReadState,
} from "@/lib/console-chat-api";
import {
  deriveChatThreadTitle,
  validateRenamedChatThreadTitle,
  type ChatMessage,
  type ChatModelSnapshot,
  type ChatPreviewMode,
  type ChatThread,
  type ChatThreadSummary,
  type ChatThreadTitleValidation,
  type ChatToolCall,
} from "@/lib/chat-workspace";
import {
  canStartChatWorkspaceLifecycleRun,
  chatWorkspaceLifecycleReducer,
  createChatWorkspaceLifecycleState,
  createLocalChatDraft,
  getChatWorkspaceTargetById,
  getDurableChatThread,
  getSelectedChatWorkspaceId,
  getSelectedRenderableChatWorkspaceThread,
  getVisibleDurableChatThreadId,
  hasDurableChatThread,
  type ChatWorkspaceLifecycleAction,
  type ChatWorkspaceLifecycleState,
  type ChatWorkspaceVisibleTarget,
  type DurableChatThread,
  type DurableChatThreadDetail,
  type LocalChatDraft,
} from "@/lib/chat-workspace-state";
import { reconcileChatSummarySnapshot } from "@/lib/chat-request-snapshot";
import { createRequestAuthority } from "@/lib/request-authority";
import {
  resolveConsoleVisitorIdentity,
  type VisitorIdentityState,
} from "@/lib/visitor-identity-api";

const VISITOR_TOKEN_STORAGE_KEY = "auggy-visitor-token";
const VISITOR_PROMOTION_INTENT_STORAGE_KEY = "auggy-visitor-promotion-intent";
const VISITOR_AUTH_BROADCAST_CHANNEL = "auggy-visitor-auth";
const VISITOR_VERIFIED_EVENT_TYPE = "visitor-auth.verified";
const EXTERNAL_RUN_POLL_INITIAL_MS = 750;
const EXTERNAL_RUN_POLL_MAX_MS = 5_000;
const CHAT_HYDRATION_RETRY_INITIAL_MS = 750;
const CHAT_HYDRATION_RETRY_MAX_MS = 5_000;
const DETAIL_RECONCILIATION_RETRY_MAX_MS = 30_000;
const STALE_DETAIL_LOAD_RETRY_MAX = 3;
const CHAT_RECONCILIATION_ERROR =
  "The saved transcript could not be refreshed. It will retry automatically.";

interface DetailReconciliationRetry {
  failures: number;
  retryAt: number;
  failedUpdatedAt: string;
  failedRunStatus: ChatThread["runStatus"];
}

export type ChatWorkspaceCommandResult =
  | { ok: true }
  | { ok: false; error: string };

export type ChatWorkspaceThreadCommandResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string };

export interface ChatWorkspaceContextValue {
  state: ChatWorkspaceLifecycleState;
  activeThread: LocalChatDraft | DurableChatThreadDetail | null;
  deletingThreadIds: ReadonlySet<string>;
  hydrationStatus: "loading" | "ready" | "error";
  hydrationError: string | null;
  anonymousAllowed: boolean;
  hasVisitorToken: boolean;
  visitorIdentity: VisitorIdentityState;
  create: (previewMode?: ChatPreviewMode) => string;
  selectWelcome: () => void;
  select: (threadId: string) => boolean;
  loadThread: (threadId: string) => Promise<boolean>;
  rename: (threadId: string, title: string) => Promise<ChatThreadTitleValidation>;
  markUnread: (threadId: string, unread?: boolean) => Promise<boolean>;
  deleteThread: (threadId: string) => Promise<ChatWorkspaceCommandResult>;
  setPreviewMode: (previewMode: ChatPreviewMode) => ChatWorkspaceThreadCommandResult;
  send: (
    message: string,
    threadId?: string,
    onAccepted?: () => void,
  ) => Promise<ChatWorkspaceCommandResult>;
  stop: () => boolean;
  refreshVisitorToken: () => boolean;
  clearVisitor: () => void;
  setChatVisible: (target: ChatWorkspaceVisibleTarget | null) => void;
}

interface ChatWorkspaceProviderProps {
  children: ReactNode;
  /** Intended for tests and, later, durable server hydration. */
  initialState?: ChatWorkspaceLifecycleState;
  fetchImpl?: AdminFetch;
  createId?: () => string;
  now?: () => Date;
}

interface RunLock {
  clientRunId: string;
  threadId: string;
  assistantMessageId: string;
  controller: AbortController;
}

const HYDRATION_REQUEST_SCOPE = "chat:hydration" as const;
const POLL_REQUEST_SCOPE = "chat:poll" as const;
const SELECTION_REQUEST_SCOPE = "chat:selection" as const;
const VISITOR_IDENTITY_REQUEST_SCOPE = "chat:visitor-identity" as const;

type ChatRequestScope =
  | typeof HYDRATION_REQUEST_SCOPE
  | typeof POLL_REQUEST_SCOPE
  | typeof SELECTION_REQUEST_SCOPE
  | typeof VISITOR_IDENTITY_REQUEST_SCOPE
  | `chat:detail:${string}`
  | `chat:rename:${string}`
  | `chat:read:${string}`
  | `chat:delete:${string}`;

type ChatRequestAuthority = ReturnType<typeof createRequestAuthority<ChatRequestScope>>;

function detailRequestScope(threadId: string): ChatRequestScope {
  return `chat:detail:${threadId}`;
}

function renameRequestScope(threadId: string): ChatRequestScope {
  return `chat:rename:${threadId}`;
}

function readRequestScope(threadId: string): ChatRequestScope {
  return `chat:read:${threadId}`;
}

function deleteRequestScope(threadId: string): ChatRequestScope {
  return `chat:delete:${threadId}`;
}

const ChatWorkspaceContext = createContext<ChatWorkspaceContextValue | null>(null);

export function ChatWorkspaceProvider({
  children,
  initialState,
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  createId = defaultCreateId,
  now = () => new Date(),
}: ChatWorkspaceProviderProps) {
  const { data } = useDashboardContext();
  const dependenciesRef = useRef({ data, fetchImpl, createId, now });
  dependenciesRef.current = { data, fetchImpl, createId, now };

  const initialStateRef = useRef<ChatWorkspaceLifecycleState | null>(null);
  if (initialStateRef.current === null) {
    initialStateRef.current = initialState ?? createChatWorkspaceLifecycleState();
  }

  const [state, setState] = useState<ChatWorkspaceLifecycleState>(initialStateRef.current);
  const stateRef = useRef(state);
  const runLockRef = useRef<RunLock | null>(null);
  const requestAuthorityRef = useRef<ChatRequestAuthority | null>(null);
  if (requestAuthorityRef.current === null) {
    requestAuthorityRef.current = createRequestAuthority<ChatRequestScope>();
  }
  const requestAuthority = requestAuthorityRef.current;
  const readMutationQueueRef = useRef(new Map<string, Promise<unknown>>());
  const renameMutationQueueRef = useRef(new Map<string, Promise<unknown>>());
  const threadRevisionRef = useRef(new Map<string, number>());
  const detailReconciliationRetriesRef = useRef(new Map<string, DetailReconciliationRetry>());
  const deletingThreadIdsRef = useRef(new Set<string>());
  // Visitor credentials are deliberately memory-only and bound to the first
  // request made by a thread. A later token must never silently inherit that
  // thread's privileged model context.
  const visitorTokenByThreadRef = useRef(new Map<string, string>());
  const invalidatedVisitorThreadsRef = useRef(new Set<string>());
  const currentVisitorTokenRef = useRef(readVisitorToken());
  const initialPromotionIntent = readVisitorPromotionIntent(currentVisitorTokenRef.current);
  const pendingVisitorPromotionsRef = useRef(
    new Map<string, string>(
      initialPromotionIntent
        ? [[initialPromotionIntent.threadId, currentVisitorTokenRef.current!]]
        : [],
    ),
  );
  const mountedRef = useRef(true);
  const [hasVisitorToken, setHasVisitorToken] = useState(() => Boolean(readVisitorToken()));
  const [visitorIdentity, setVisitorIdentity] = useState<VisitorIdentityState>(() =>
    currentVisitorTokenRef.current ? { status: "checking" } : { status: "absent" },
  );
  const visitorIdentityInFlightTokenRef = useRef<string | undefined>(undefined);
  const visitorIdentitySettledTokenRef = useRef<string | undefined>(undefined);
  const [hydrationStatus, setHydrationStatus] = useState<"loading" | "ready" | "error">(
    initialState ? "ready" : "loading",
  );
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [visibilityKnown, setVisibilityKnown] = useState(false);
  const [deletingThreadIds, setDeletingThreadIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const consoleChatCsrfToken = consoleChatCsrf(data);
  const visibleDurableThreadId = getVisibleDurableChatThreadId(state);

  const dispatch = useCallback((action: ChatWorkspaceLifecycleAction) => {
    const previous = stateRef.current;
    const next = chatWorkspaceLifecycleReducer(previous, action);
    if (next !== previous) {
      const previousById = new Map(
        previous.durableThreads.map((thread) => [thread.id, thread]),
      );
      for (const thread of next.durableThreads) {
        if (previousById.get(thread.id) !== thread) {
          threadRevisionRef.current.set(
            thread.id,
            (threadRevisionRef.current.get(thread.id) ?? 0) + 1,
          );
        }
        previousById.delete(thread.id);
      }
      for (const removedId of previousById.keys()) {
        threadRevisionRef.current.set(
          removedId,
          (threadRevisionRef.current.get(removedId) ?? 0) + 1,
        );
      }
    }
    stateRef.current = next;
    if (mountedRef.current) setState(next);
    return next;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestAuthority.invalidateAll();
      runLockRef.current?.controller.abort();
      runLockRef.current = null;
      visitorTokenByThreadRef.current.clear();
      invalidatedVisitorThreadsRef.current.clear();
      pendingVisitorPromotionsRef.current.clear();
      visitorIdentityInFlightTokenRef.current = undefined;
      visitorIdentitySettledTokenRef.current = undefined;
      readMutationQueueRef.current.clear();
      renameMutationQueueRef.current.clear();
      deletingThreadIdsRef.current.clear();
    };
  }, [requestAuthority]);

  useEffect(() => {
    if (initialState) return;
    const hydrationLease = requestAuthority.begin(HYDRATION_REQUEST_SCOPE);
    const controller = new AbortController();
    let retryDelay = CHAT_HYDRATION_RETRY_INITIAL_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const hydrate = async () => {
      if (!requestAuthority.isCurrent(hydrationLease)) return;
      const revisionsBeforeRequest = new Map(threadRevisionRef.current);
      try {
        const summaries = await listConsoleChatThreads({
          signal: controller.signal,
          fetchImpl: dependenciesRef.current.fetchImpl,
        });
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          !requestAuthority.isCurrent(hydrationLease)
        ) {
          return;
        }
        const reconciledSummaries = reconcileChatSummarySnapshot(
          summaries,
          stateRef.current.durableThreads.map(durableThreadSummary),
          revisionsBeforeRequest,
          threadRevisionRef.current,
        );
        dispatch({ type: "server.hydrated", summaries: reconciledSummaries });
        setHydrationStatus("ready");
        setHydrationError(null);
        requestAuthority.finish(hydrationLease);
      } catch (error: unknown) {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          isAbortError(error) ||
          !requestAuthority.isCurrent(hydrationLease)
        ) {
          return;
        }
        setHydrationStatus("error");
        const retryable = shouldRetryChatHydration(error);
        setHydrationError(
          retryable
            ? `${errorMessage(error, "Could not load saved chats.")} Reconnecting automatically…`
            : errorMessage(error, "Could not load saved chats."),
        );
        if (retryable) {
          retryTimer = setTimeout(() => void hydrate(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, CHAT_HYDRATION_RETRY_MAX_MS);
        } else {
          requestAuthority.finish(hydrationLease);
        }
      }
    };

    void hydrate();

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      requestAuthority.finish(hydrationLease);
    };
  }, [dispatch, initialState, requestAuthority]);

  const resolveVisitorIdentity = useCallback((token: string | undefined, force = false) => {
    if (!token) {
      requestAuthority.invalidate(VISITOR_IDENTITY_REQUEST_SCOPE);
      visitorIdentityInFlightTokenRef.current = undefined;
      visitorIdentitySettledTokenRef.current = undefined;
      if (mountedRef.current) setVisitorIdentity({ status: "absent" });
      return;
    }
    if (
      visitorIdentityInFlightTokenRef.current === token ||
      (!force && visitorIdentitySettledTokenRef.current === token)
    ) {
      return;
    }
    const csrf = consoleChatCsrf(dependenciesRef.current.data);
    if (!csrf) {
      if (mountedRef.current) {
        setVisitorIdentity({ status: "unavailable", error: "Console session unavailable." });
      }
      return;
    }
    const identityLease = requestAuthority.begin(VISITOR_IDENTITY_REQUEST_SCOPE);
    visitorIdentityInFlightTokenRef.current = token;
    if (mountedRef.current) setVisitorIdentity({ status: "checking" });
    void resolveConsoleVisitorIdentity(token, csrf, {
      fetchImpl: dependenciesRef.current.fetchImpl,
    }).then(
      (identity) => {
        const ownsIdentity = requestAuthority.isCurrent(identityLease);
        if (
          !mountedRef.current ||
          !ownsIdentity ||
          readVisitorToken() !== token
        ) {
          if (ownsIdentity && visitorIdentityInFlightTokenRef.current === token) {
            visitorIdentityInFlightTokenRef.current = undefined;
          }
          requestAuthority.finish(identityLease);
          return;
        }
        visitorIdentityInFlightTokenRef.current = undefined;
        visitorIdentitySettledTokenRef.current = token;
        setVisitorIdentity(identity);
        requestAuthority.finish(identityLease);
      },
      (error: unknown) => {
        const ownsIdentity = requestAuthority.isCurrent(identityLease);
        if (
          !mountedRef.current ||
          !ownsIdentity ||
          readVisitorToken() !== token
        ) {
          if (ownsIdentity && visitorIdentityInFlightTokenRef.current === token) {
            visitorIdentityInFlightTokenRef.current = undefined;
          }
          requestAuthority.finish(identityLease);
          return;
        }
        visitorIdentityInFlightTokenRef.current = undefined;
        setVisitorIdentity({
          status: "unavailable",
          error: errorMessage(error, "Visitor identity could not be verified."),
        });
        requestAuthority.finish(identityLease);
      },
    );
  }, [requestAuthority]);

  const refreshVisitorToken = useCallback((forceIdentity = false) => {
    const token = readVisitorToken();
    currentVisitorTokenRef.current = token;
    const available = Boolean(token);
    pendingVisitorPromotionsRef.current.clear();
    const intent = readVisitorPromotionIntent(token, { quarantineInvalid: true });
    if (intent && token) {
      pendingVisitorPromotionsRef.current.set(intent.threadId, token);
    }
    if (!available) {
      for (const threadId of visitorTokenByThreadRef.current.keys()) {
        invalidatedVisitorThreadsRef.current.add(threadId);
      }
    }
    if (mountedRef.current) setHasVisitorToken(available);
    resolveVisitorIdentity(token, forceIdentity);
    return available;
  }, [resolveVisitorIdentity]);

  // The workspace mounts in parallel with dashboard hydration. A stored
  // visitor token may therefore be discovered before the console CSRF token
  // is available. Retry as soon as that session capability arrives instead of
  // leaving the identity stuck in an unavailable state until focus changes.
  useEffect(() => {
    if (!consoleChatCsrfToken) return;
    const token = readVisitorToken();
    if (!token) return;
    currentVisitorTokenRef.current = token;
    resolveVisitorIdentity(token);
  }, [consoleChatCsrfToken, resolveVisitorIdentity]);

  const clearVisitor = useCallback(() => {
    for (const threadId of visitorTokenByThreadRef.current.keys()) {
      invalidatedVisitorThreadsRef.current.add(threadId);
    }
    clearVisitorToken();
    clearVisitorPromotionIntent();
    currentVisitorTokenRef.current = undefined;
    pendingVisitorPromotionsRef.current.clear();
    resolveVisitorIdentity(undefined);
    if (mountedRef.current) setHasVisitorToken(false);
  }, [resolveVisitorIdentity]);

  const confirmServerThreadDeletion = useCallback(
    (threadId: string) => {
      if (!mountedRef.current) return;

      // Invalidate every callback that could otherwise merge stale state for
      // this ID after the server has proven it is tombstoned. Keep the delete
      // request's own ownership marker intact until its caller reaches finally.
      threadRevisionRef.current.set(
        threadId,
        (threadRevisionRef.current.get(threadId) ?? 0) + 1,
      );
      requestAuthority.invalidate(detailRequestScope(threadId));
      detailReconciliationRetriesRef.current.delete(threadId);
      requestAuthority.invalidate(renameRequestScope(threadId));
      requestAuthority.invalidate(readRequestScope(threadId));
      readMutationQueueRef.current.delete(threadId);
      renameMutationQueueRef.current.delete(threadId);
      visitorTokenByThreadRef.current.delete(threadId);
      invalidatedVisitorThreadsRef.current.delete(threadId);
      const promotionToken = pendingVisitorPromotionsRef.current.get(threadId);
      pendingVisitorPromotionsRef.current.delete(threadId);
      clearVisitorPromotionIntent(threadId, promotionToken);
      dispatch({ type: "thread.server-deletion-confirmed", threadId });
    },
    [dispatch, requestAuthority],
  );

  const persistReadState = useCallback(
    async (threadId: string, unread: boolean): Promise<boolean> => {
      if (!hasDurableChatThread(stateRef.current, threadId)) return false;
      const csrf = consoleChatCsrf(dependenciesRef.current.data);
      if (!csrf) throw new Error("Session expired — reload the page.");
      const readLease = requestAuthority.begin(readRequestScope(threadId));
      const previous = readMutationQueueRef.current.get(threadId) ?? Promise.resolve();
      const request = previous
        .catch(() => {
          // A rejected earlier marker must not prevent a newer explicit intent.
        })
        .then(() =>
          setConsoleChatThreadReadState(threadId, unread, csrf, {
            fetchImpl: dependenciesRef.current.fetchImpl,
          }),
        );
      readMutationQueueRef.current.set(threadId, request);
      try {
        const summary = await request;
        if (
          mountedRef.current &&
          requestAuthority.isCurrent(readLease) &&
          hasDurableChatThread(stateRef.current, threadId)
        ) {
          dispatch({
            type: "thread.read-state-confirmed",
            threadId,
            unread: summary.unread,
            lastReadAt: summary.lastReadAt,
          });
        }
        return true;
      } catch (error) {
        if (
          isConsoleChatApiError(error) &&
          error.code === "gone" &&
          mountedRef.current &&
          requestAuthority.isCurrent(readLease)
        ) {
          confirmServerThreadDeletion(threadId);
        }
        throw error;
      } finally {
        if (readMutationQueueRef.current.get(threadId) === request) {
          readMutationQueueRef.current.delete(threadId);
        }
        requestAuthority.finish(readLease);
      }
    },
    [confirmServerThreadDeletion, dispatch, requestAuthority],
  );

  const setChatVisible = useCallback(
    (target: ChatWorkspaceVisibleTarget | null) => {
      const at = dependenciesRef.current.now().toISOString();
      dispatch({ type: "workspace.visibility-set", target, at });
      setVisibilityKnown(true);
    },
    [dispatch],
  );

  // Selection/visibility can become ready before the dashboard CSRF payload.
  // Key this retry to the stable token and active route state so the durable
  // read marker cannot be lost during initial parallel hydration.
  useEffect(() => {
    if (!visibilityKnown || !consoleChatCsrfToken) return;
    if (!visibleDurableThreadId) return;
    void persistReadState(visibleDurableThreadId, false).catch(() => {
      // Explicit mark-unread errors remain user-visible; passive read markers
      // are retried by the next selection, visibility change, or page load.
    });
  }, [
    consoleChatCsrfToken,
    persistReadState,
    visibleDurableThreadId,
    visibilityKnown,
  ]);

  useEffect(() => {
    const refresh = () => refreshVisitorToken(true);
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === VISITOR_TOKEN_STORAGE_KEY ||
        event.key === VISITOR_PROMOTION_INTENT_STORAGE_KEY ||
        event.key === null
      ) {
        refresh();
      }
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", handleStorage);
    const channel =
      typeof window.BroadcastChannel === "function"
        ? new window.BroadcastChannel(VISITOR_AUTH_BROADCAST_CHANNEL)
        : null;
    const handleVerification = (event: MessageEvent<unknown>) => {
      if (isVisitorVerifiedNotification(event.data)) refresh();
    };
    channel?.addEventListener("message", handleVerification);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", handleStorage);
      channel?.removeEventListener("message", handleVerification);
      channel?.close();
    };
  }, [refreshVisitorToken]);

  useEffect(() => {
    if (visitorIdentity.status !== "verified") return;
    const token = visitorIdentitySettledTokenRef.current;
    if (!token || currentVisitorTokenRef.current !== token || readVisitorToken() !== token) {
      return;
    }
    const expiryLease = requestAuthority.begin(VISITOR_IDENTITY_REQUEST_SCOPE);
    const expireIdentity = () => {
      if (
        !mountedRef.current ||
        !requestAuthority.isCurrent(expiryLease) ||
        currentVisitorTokenRef.current !== token ||
        readVisitorToken() !== token ||
        visitorIdentitySettledTokenRef.current !== token
      ) {
        return;
      }
      setVisitorIdentity({ status: "invalid", error: "Visitor identity expired." });
      requestAuthority.finish(expiryLease);
    };
    const remaining = visitorIdentity.expiresAt - Date.now();
    if (remaining <= 0) {
      expireIdentity();
      return () => {
        requestAuthority.finish(expiryLease);
      };
    }
    const timer = setTimeout(expireIdentity, Math.min(remaining, 2_147_483_647));
    return () => {
      clearTimeout(timer);
      requestAuthority.finish(expiryLease);
    };
  }, [requestAuthority, visitorIdentity]);

  useEffect(() => {
    const model = modelSnapshotFromDashboard(data);
    const draft = stateRef.current.draft;
    if (!model || !draft || stateRef.current.activeRun) return;
    const at = dependenciesRef.current.now().toISOString();
    if (
      draft.model?.id !== model.id ||
      draft.model.displayName !== model.displayName ||
      draft.model.provider !== model.provider
    ) {
      dispatch({ type: "draft.model-set", draftId: draft.id, model, at });
    }
  }, [data, dispatch]);

  const externalStreamingKey = state.durableThreads
    .filter(
      (thread) =>
        thread.runStatus === "streaming" && state.activeRun?.threadId !== thread.id,
    )
    .map((thread) => thread.id)
    .sort()
    .join("\0");
  const unconfirmedDraftRunKey = state.unconfirmedDraftRun?.clientRunId ?? "";

  useEffect(() => {
    if (hydrationStatus !== "ready") return;
    const pollLease = requestAuthority.begin(POLL_REQUEST_SCOPE);
    const controller = new AbortController();
    const ownsPoll = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      requestAuthority.isCurrent(pollLease);
    const urgentReconciliation = Boolean(
      externalStreamingKey || unconfirmedDraftRunKey,
    );
    let delay = nextReconciliationPollDelay(
      urgentReconciliation,
      urgentReconciliation ? EXTERNAL_RUN_POLL_INITIAL_MS : EXTERNAL_RUN_POLL_MAX_MS,
      detailReconciliationRetriesRef.current,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const revisionsBeforeRequest = new Map(threadRevisionRef.current);
      try {
        const summaries = await listConsoleChatThreads({
          signal: controller.signal,
          fetchImpl: dependenciesRef.current.fetchImpl,
        });
        if (!ownsPoll()) return;
        const summaryIds = new Set(summaries.map(({ id }) => id));
        const summariesToAdd: ChatThreadSummary[] = [];
        for (const summary of summaries) {
          if (!ownsPoll()) return;
          const current = getDurableChatThread(stateRef.current, summary.id);
          if (!current) {
            if (
              deletingThreadIdsRef.current.has(summary.id) ||
              (threadRevisionRef.current.get(summary.id) ?? 0) !==
                (revisionsBeforeRequest.get(summary.id) ?? 0)
            ) {
              continue;
            }
            summariesToAdd.push(summary);
            continue;
          }
          if (stateRef.current.activeRun?.threadId === summary.id) continue;
          if (
            (threadRevisionRef.current.get(summary.id) ?? 0) !==
            (revisionsBeforeRequest.get(summary.id) ?? 0)
          ) {
            continue;
          }

          const detailRetry = detailReconciliationRetriesRef.current.get(summary.id);
          if (
            detailRetry &&
            !sameDetailReconciliationRevision(detailRetry, summary)
          ) {
            // A newer server revision is not the response that failed to load.
            // Reconcile it immediately so a new background run is never hidden
            // behind an old terminal-detail backoff window.
            if (!ownsPoll()) return;
            detailReconciliationRetriesRef.current.delete(summary.id);
          }
          if (shouldDeferDetailReconciliation(detailRetry, summary, Date.now())) continue;
          const changed =
            detailRetry !== undefined ||
            summary.updatedAt !== current.updatedAt ||
            summary.title !== current.title ||
            summary.previewMode !== current.previewMode ||
            summary.model?.id !== current.model?.id ||
            summary.model?.displayName !== current.model?.displayName ||
            summary.model?.provider !== current.model?.provider ||
            summary.runStatus !== current.runStatus ||
            summary.unread !== current.unread ||
            summary.lastReadAt !== current.lastReadAt;
          if (!changed) continue;
          if (current.lifecycle === "detail") {
            const beforeRevision = threadRevisionRef.current.get(summary.id) ?? 0;
            try {
              const detail = await getConsoleChatThread(summary.id, {
                signal: controller.signal,
                fetchImpl: dependenciesRef.current.fetchImpl,
              });
              if (!ownsPoll()) return;
              const latest = getDurableChatThread(stateRef.current, summary.id);
              if (
                latest &&
                stateRef.current.activeRun?.threadId !== summary.id &&
                (threadRevisionRef.current.get(summary.id) ?? 0) === beforeRevision
              ) {
                if (!ownsPoll()) return;
                detailReconciliationRetriesRef.current.delete(summary.id);
                dispatch({ type: "thread.detail-loaded", thread: detail });
                if (
                  detail.runStatus !== "streaming" &&
                  getVisibleDurableChatThreadId(stateRef.current) === detail.id
                ) {
                  void persistReadState(detail.id, false).catch(() => {
                    // Keep the reconciled transcript usable; selection retries the marker.
                  });
                }
              }
              continue;
            } catch (error) {
              if (!ownsPoll() || isAbortError(error)) return;
              if (isConsoleChatApiError(error) && error.code === "gone") {
                confirmServerThreadDeletion(summary.id);
                continue;
              }
              if (summary.runStatus !== "streaming") {
                // Unlock this thread using an explicit local error state while
                // retaining its last known transcript. Because the server
                // summary remains terminal, the explicit pending marker retries
                // detail even when the server and local error statuses match.
                if (!ownsPoll()) return;
                const failures = (detailRetry?.failures ?? 0) + 1;
                detailReconciliationRetriesRef.current.set(summary.id, {
                  failures,
                  retryAt: Date.now() + detailReconciliationRetryDelay(failures),
                  failedUpdatedAt: summary.updatedAt,
                  failedRunStatus: summary.runStatus,
                });
                dispatch({
                  type: "thread.reconciliation-failed",
                  thread: summary,
                  error: CHAT_RECONCILIATION_ERROR,
                });
                continue;
              }
            }
          }
          if (!ownsPoll()) return;
          dispatch({ type: "thread.summary-merge", thread: summary });
        }

        for (const thread of stateRef.current.durableThreads) {
          if (!ownsPoll()) return;
          if (
            stateRef.current.activeRun?.threadId === thread.id ||
            summaryIds.has(thread.id) ||
            (threadRevisionRef.current.get(thread.id) ?? 0) !==
              (revisionsBeforeRequest.get(thread.id) ?? 0)
          ) {
            continue;
          }
          dispatch({
            type: "server.hydrated",
            summaries: stateRef.current.durableThreads
              .filter((candidate) => candidate.id !== thread.id)
              .map(durableThreadSummary),
          });
          requestAuthority.invalidate(detailRequestScope(thread.id));
          detailReconciliationRetriesRef.current.delete(thread.id);
          visitorTokenByThreadRef.current.delete(thread.id);
          invalidatedVisitorThreadsRef.current.delete(thread.id);
          const promotionToken = pendingVisitorPromotionsRef.current.get(thread.id);
          pendingVisitorPromotionsRef.current.delete(thread.id);
          clearVisitorPromotionIntent(thread.id, promotionToken);
        }
        for (const summary of summariesToAdd) {
          if (!ownsPoll()) return;
          if (
            deletingThreadIdsRef.current.has(summary.id) ||
            (threadRevisionRef.current.get(summary.id) ?? 0) !==
              (revisionsBeforeRequest.get(summary.id) ?? 0) ||
            hasDurableChatThread(stateRef.current, summary.id)
          ) {
            continue;
          }
          dispatch({
            type: "server.hydrated",
            summaries: [
              ...stateRef.current.durableThreads.map(durableThreadSummary),
              summary,
            ],
          });
        }
        const hasExternalRun = stateRef.current.durableThreads.some(
          (thread) =>
            thread.runStatus === "streaming" &&
            stateRef.current.activeRun?.threadId !== thread.id,
        );
        const baseDelay = hasExternalRun
          ? Math.min(Math.round(delay * 1.5), EXTERNAL_RUN_POLL_MAX_MS)
          : EXTERNAL_RUN_POLL_MAX_MS;
        delay = nextReconciliationPollDelay(
          hasExternalRun,
          baseDelay,
          detailReconciliationRetriesRef.current,
        );
      } catch (error) {
        if (!ownsPoll() || isAbortError(error)) return;
        delay = Math.min(delay * 2, EXTERNAL_RUN_POLL_MAX_MS);
      }

      if (ownsPoll()) {
        timer = setTimeout(() => void poll(), delay);
      }
    };

    timer = setTimeout(() => void poll(), delay);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      requestAuthority.finish(pollLease);
    };
  }, [
    confirmServerThreadDeletion,
    dispatch,
    externalStreamingKey,
    hydrationStatus,
    persistReadState,
    requestAuthority,
    unconfirmedDraftRunKey,
  ]);

  const create = useCallback(
    (previewMode?: ChatPreviewMode) => {
      // Creating/selecting the local draft is route-authoritative and must
      // invalidate any durable detail selection still in flight.
      requestAuthority.begin(SELECTION_REQUEST_SCOPE);
      const current = getSelectedRenderableChatWorkspaceThread(stateRef.current);
      const deps = dependenciesRef.current;
      const createdAt = deps.now().toISOString();
      const draft = createLocalChatDraft({
        id: stateRef.current.draft?.id ?? deps.createId(),
        previewMode: previewMode ?? current?.previewMode ?? "creator",
        model: modelSnapshotFromDashboard(deps.data),
        now: createdAt,
      });
      dispatch({ type: "draft.set", draft });
      dispatch({ type: "selection.draft", draftId: draft.id });
      return draft.id;
    },
    [dispatch, requestAuthority],
  );

  const select = useCallback(
    (threadId: string) => {
      const target = getChatWorkspaceTargetById(stateRef.current, threadId);
      if (!target) return false;
      requestAuthority.begin(SELECTION_REQUEST_SCOPE);
      dispatch(
        target.lifecycle === "draft"
          ? { type: "selection.draft", draftId: threadId }
          : { type: "selection.thread", threadId },
      );
      return true;
    },
    [dispatch, requestAuthority],
  );

  const selectWelcome = useCallback(() => {
    requestAuthority.begin(SELECTION_REQUEST_SCOPE);
    dispatch({ type: "selection.welcome" });
  }, [dispatch, requestAuthority]);

  const loadThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const existing = getChatWorkspaceTargetById(stateRef.current, threadId);
      // Drafts belong exclusively to /chat/new. Durable loading must never
      // select one or cancel an in-flight durable selection generation.
      if (existing?.lifecycle === "draft") return false;
      const selectionLease = requestAuthority.begin(SELECTION_REQUEST_SCOPE);
      if (existing?.lifecycle === "detail") {
        if (requestAuthority.isCurrent(selectionLease)) select(threadId);
        return true;
      }

      for (let attempt = 0; attempt < STALE_DETAIL_LOAD_RETRY_MAX; attempt++) {
        const detailLease = requestAuthority.begin(detailRequestScope(threadId));
        const beforeRevision = threadRevisionRef.current.get(threadId) ?? 0;
        try {
          const detail = await getConsoleChatThread(threadId, {
            fetchImpl: dependenciesRef.current.fetchImpl,
          });
          if (!mountedRef.current || !requestAuthority.isCurrent(detailLease)) {
            return false;
          }
          const current = getDurableChatThread(stateRef.current, threadId);
          const revisionUnchanged =
            (threadRevisionRef.current.get(threadId) ?? 0) === beforeRevision;
          if (current && !revisionUnchanged && current.updatedAt >= detail.updatedAt) {
            // A newer summary or local mutation landed while this request was
            // in flight. Never combine its metadata with an older transcript:
            // that would make future summary polls believe the stale messages
            // were current. Keep the thread unloaded and request fresh detail.
            continue;
          }
          if (stateRef.current.activeRun?.threadId !== threadId) {
            if (current) {
              const threadToMerge =
                revisionUnchanged
                  ? detail
                  : { ...durableThreadSummary(current), messages: detail.messages };
              dispatch({ type: "thread.detail-loaded", thread: threadToMerge });
            } else if (revisionUnchanged) {
              dispatch({
                type: "server.hydrated",
                summaries: [
                  ...stateRef.current.durableThreads.map(durableThreadSummary),
                  durableThreadSummary(detail),
                ],
              });
              dispatch({ type: "thread.detail-loaded", thread: detail });
            } else {
              return false;
            }
            detailReconciliationRetriesRef.current.delete(threadId);
          }
          if (requestAuthority.isCurrent(selectionLease)) select(threadId);
          return true;
        } catch (error) {
          if (
            isConsoleChatApiError(error) &&
            error.code === "gone" &&
            mountedRef.current &&
            requestAuthority.isCurrent(detailLease)
          ) {
            confirmServerThreadDeletion(threadId);
            return false;
          }
          if (isConsoleChatApiError(error) && error.code === "not-found") return false;
          throw error;
        } finally {
          requestAuthority.finish(detailLease);
        }
      }
      throw new Error("The conversation changed while it was loading. Try again.");
    },
    [confirmServerThreadDeletion, dispatch, requestAuthority, select],
  );

  const rename = useCallback(
    async (threadId: string, title: string): Promise<ChatThreadTitleValidation> => {
      const validation = validateRenamedChatThreadTitle(title);
      const target = getChatWorkspaceTargetById(stateRef.current, threadId);
      if (!validation.valid || !target) return validation;
      if (deletingThreadIdsRef.current.has(threadId)) {
        throw new Error("This chat is being deleted.");
      }
      if (stateRef.current.activeRun?.threadId === threadId) {
        throw new Error("Wait for this response to finish before renaming the chat.");
      }
      if (target.lifecycle === "draft") {
        dispatch({
          type: "draft.rename",
          draftId: threadId,
          title: validation.title,
          at: dependenciesRef.current.now().toISOString(),
        });
        return validation;
      }
      const csrf = consoleChatCsrf(dependenciesRef.current.data);
      if (!csrf) throw new Error("Session expired — reload the page.");
      const renameLease = requestAuthority.begin(renameRequestScope(threadId));
      const previous = renameMutationQueueRef.current.get(threadId) ?? Promise.resolve();
      const request = previous
        .catch(() => {
          // A failed earlier rename must not prevent a newer explicit intent.
        })
        .then(() =>
          renameConsoleChatThread(threadId, validation.title, csrf, {
            fetchImpl: dependenciesRef.current.fetchImpl,
          }),
        );
      renameMutationQueueRef.current.set(threadId, request);
      try {
        const summary = await request;
        if (
          mountedRef.current &&
          requestAuthority.isCurrent(renameLease) &&
          hasDurableChatThread(stateRef.current, threadId)
        ) {
          dispatch({
            type: "thread.rename-confirmed",
            threadId,
            title: summary.title,
            updatedAt: summary.updatedAt,
          });
        }
        return validation;
      } catch (error) {
        if (
          isConsoleChatApiError(error) &&
          error.code === "gone" &&
          mountedRef.current &&
          requestAuthority.isCurrent(renameLease)
        ) {
          confirmServerThreadDeletion(threadId);
        }
        throw error;
      } finally {
        if (renameMutationQueueRef.current.get(threadId) === request) {
          renameMutationQueueRef.current.delete(threadId);
        }
        requestAuthority.finish(renameLease);
      }
    },
    [confirmServerThreadDeletion, dispatch, requestAuthority],
  );

  const markUnread = useCallback(
    async (threadId: string, unread = true): Promise<boolean> => {
      if (!hasDurableChatThread(stateRef.current, threadId)) return false;
      if (deletingThreadIdsRef.current.has(threadId)) {
        throw new Error("This chat is being deleted.");
      }
      if (stateRef.current.activeRun?.threadId === threadId) {
        throw new Error("Wait for this response to finish before changing its unread state.");
      }
      await persistReadState(threadId, unread);
      return true;
    },
    [dispatch, persistReadState],
  );

  const deleteThread = useCallback(
    async (threadId: string): Promise<ChatWorkspaceCommandResult> => {
      const current = stateRef.current;
      const target = getChatWorkspaceTargetById(current, threadId);
      if (!target) return { ok: false, error: "This chat no longer exists." };
      if (deletingThreadIdsRef.current.has(threadId)) {
        return { ok: false, error: "This chat is already being deleted." };
      }
      if (current.activeRun?.threadId === threadId) {
        return {
          ok: false,
          error: "Wait for this response to finish or stop it before deleting this chat.",
        };
      }
      const serverMayOwnDraft =
        target.lifecycle === "draft" && current.unconfirmedDraftRun?.threadId === target.id;
      if (target.lifecycle === "draft" && !serverMayOwnDraft) {
        visitorTokenByThreadRef.current.delete(threadId);
        invalidatedVisitorThreadsRef.current.delete(threadId);
        const promotionToken = pendingVisitorPromotionsRef.current.get(threadId);
        pendingVisitorPromotionsRef.current.delete(threadId);
        clearVisitorPromotionIntent(threadId, promotionToken);
        dispatch({ type: "draft.cleared", draftId: threadId });
        return { ok: true };
      }
      if (target.lifecycle !== "draft" && target.runStatus === "streaming") {
        return {
          ok: false,
          error: "This response is still running. Wait for it to finish before deleting this chat.",
        };
      }
      deletingThreadIdsRef.current.add(threadId);
      // Polls that started before DELETE must not promote a stale summary even
      // if their response arrives after the pending-delete guard is released.
      threadRevisionRef.current.set(
        threadId,
        (threadRevisionRef.current.get(threadId) ?? 0) + 1,
      );
      const deleteLease = requestAuthority.begin(deleteRequestScope(threadId));
      setDeletingThreadIds(new Set(deletingThreadIdsRef.current));
      try {
        const csrf = consoleChatCsrf(dependenciesRef.current.data);
        if (!csrf) throw new Error("Session expired — reload the page.");
        try {
          await deleteConsoleChatThread(threadId, csrf, {
            fetchImpl: dependenciesRef.current.fetchImpl,
          });
        } catch (error) {
          if (
            isConsoleChatApiError(error) &&
            error.code === "gone" &&
            mountedRef.current &&
            requestAuthority.isCurrent(deleteLease)
          ) {
            confirmServerThreadDeletion(threadId);
            return { ok: true };
          }
          throw error;
        }
        if (!mountedRef.current || !requestAuthority.isCurrent(deleteLease)) {
          return {
            ok: false,
            error: "This deletion was superseded. Retry if the chat is still present.",
          };
        }
        // A successful DELETE is authoritative even if a future refactor lets
        // local optimistic state appear while the request is in flight.
        confirmServerThreadDeletion(threadId);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error, "Could not delete this chat."),
        };
      } finally {
        requestAuthority.finish(deleteLease);
        deletingThreadIdsRef.current.delete(threadId);
        if (mountedRef.current) setDeletingThreadIds(new Set(deletingThreadIdsRef.current));
      }
    },
    [confirmServerThreadDeletion, dispatch, requestAuthority],
  );

  const setPreviewMode = useCallback(
    (previewMode: ChatPreviewMode): ChatWorkspaceThreadCommandResult => {
      const current = getSelectedRenderableChatWorkspaceThread(stateRef.current);
      if (!current) return { ok: false, error: "The active chat no longer exists." };
      if (stateRef.current.activeRun) {
        return { ok: false, error: "Wait for the active response to finish or stop it first." };
      }
      if (current.runStatus === "streaming") {
        return { ok: false, error: "This response is running in another console session." };
      }
      const availabilityError = previewModeAvailabilityError(
        previewMode,
        dependenciesRef.current.data?.web.allowAnonymous.value !== false,
        refreshVisitorToken(),
      );
      if (availabilityError) return { ok: false, error: availabilityError };
      if (previewMode === current.previewMode) return { ok: true, threadId: current.id };

      if (current.lifecycle === "detail") {
        return { ok: true, threadId: create(previewMode) };
      }

      dispatch({
        type: "draft.preview-mode-set",
        draftId: current.id,
        previewMode,
        at: dependenciesRef.current.now().toISOString(),
      });
      return { ok: true, threadId: current.id };
    },
    [create, dispatch, refreshVisitorToken],
  );

  const stop = useCallback(() => {
    const lock = runLockRef.current;
    if (!lock) return false;
    lock.controller.abort();
    return true;
  }, []);

  const send = useCallback(
    async (
      message: string,
      requestedThreadId?: string,
      onAccepted?: () => void,
    ): Promise<ChatWorkspaceCommandResult> => {
      const text = message.trim();
      if (!text) return { ok: false, error: "Write a message before sending." };
      if (runLockRef.current) {
        return { ok: false, error: "Wait for the active response to finish or stop it first." };
      }

      const currentState = stateRef.current;
      const threadId = requestedThreadId ?? getSelectedChatWorkspaceId(currentState);
      if (!threadId) return { ok: false, error: "Select or create a chat before sending." };
      const thread = getRenderableForId(currentState, threadId);
      if (!thread) return { ok: false, error: "This chat no longer exists." };
      if (deletingThreadIdsRef.current.has(threadId)) {
        return { ok: false, error: "This chat is being deleted." };
      }
      if (!canStartChatWorkspaceLifecycleRun(currentState, threadId)) {
        return { ok: false, error: "Another response is already running." };
      }

      const deps = dependenciesRef.current;
      const anonymousAllowed = deps.data?.web.allowAnonymous.value !== false;
      refreshVisitorToken();
      const storedVisitorToken = readVisitorToken();
      const promotionToken = pendingVisitorPromotionsRef.current.get(threadId);
      const promotingVisitor =
        thread.previewMode === "anonymous" &&
        Boolean(storedVisitorToken) &&
        promotionToken === storedVisitorToken;
      const effectivePreviewMode = promotingVisitor ? "visitor" : thread.previewMode;
      const visitorToken =
        effectivePreviewMode === "visitor" ? storedVisitorToken : undefined;
      const availabilityError = previewModeAvailabilityError(
        effectivePreviewMode,
        anonymousAllowed,
        Boolean(visitorToken),
      );
      if (availabilityError) return { ok: false, error: availabilityError };
      if (effectivePreviewMode === "visitor" && visitorToken && !promotingVisitor) {
        if (invalidatedVisitorThreadsRef.current.has(threadId)) {
          return {
            ok: false,
            error:
              "This visitor credential was cleared. Start a new verified visitor chat to continue.",
          };
        }
        const boundToken = visitorTokenByThreadRef.current.get(threadId);
        if (boundToken && boundToken !== visitorToken) {
          return {
            ok: false,
            error:
              "This chat belongs to a different verified visitor. Start a new chat to use the current visitor.",
          };
        }
      }

      const csrf = findCsrfToken(deps.data?.csrfTokens ?? [], "console-chat");
      if (!csrf) {
        return {
          ok: false,
          error: "Missing CSRF token — reload the page to start a fresh console session.",
        };
      }

      const clientRunId = deps.createId();
      const assistantMessageId = deps.createId();
      const sentAt = deps.now().toISOString();
      const userMessage: ChatMessage = {
        id: deps.createId(),
        role: "user",
        content: text,
        createdAt: sentAt,
        updatedAt: sentAt,
      };
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        toolCalls: [],
        createdAt: sentAt,
        updatedAt: sentAt,
      };
      const controller = new AbortController();
      const lock: RunLock = { clientRunId, threadId, assistantMessageId, controller };
      const ownsRun = () =>
        mountedRef.current &&
        !controller.signal.aborted &&
        runLockRef.current?.clientRunId === clientRunId &&
        runLockRef.current.threadId === threadId &&
        runLockRef.current.assistantMessageId === assistantMessageId;
      const runModel = modelSnapshotFromDashboard(deps.data);
      const submittedTitle =
        thread.lifecycle === "draft" && thread.titleSource === "default"
          ? deriveChatThreadTitle(text)
          : thread.title;

      // Claim the global stream synchronously. React state updates alone cannot prevent
      // two send calls in the same event turn from racing past the guard above.
      runLockRef.current = lock;
      const started = dispatch({
        type: "run.start",
        clientRunId,
        threadId,
        title: submittedTitle,
        userMessage,
        assistantMessage,
        model: runModel,
        at: sentAt,
      });
      if (
        started.activeRun?.clientRunId !== clientRunId ||
        started.activeRun.threadId !== threadId ||
        started.activeRun.assistantMessageId !== assistantMessageId ||
        started.activeRun.phase !== "pending"
      ) {
        runLockRef.current = null;
        return { ok: false, error: "Another response is already running." };
      }

      const toolCalls = new Map<string, ChatToolCall>();
      let receivedText = "";
      const textStreamState: { lastMessageId: string | null } = { lastMessageId: null };
      let eventError: string | undefined;
      let outcome: "complete" | "error" | "interrupted" = "complete";
      let sawTerminalEvent = false;
      let accepted = false;
      let durabilityRejected = false;

      const updateAssistant = (
        patch: Partial<Pick<ChatMessage, "content" | "toolCalls" | "error">>,
      ) => {
        dispatch({
          type: "run.message-update",
          clientRunId,
          threadId,
          assistantMessageId,
          patch,
          at: dependenciesRef.current.now().toISOString(),
        });
      };

      try {
        // Do not call a native Window.fetch stored on `deps` as an object
        // method. WebKit treats that object as the receiver and throws
        // "Illegal invocation". Detaching injected fetch functions also keeps
        // this seam consistent with a normal standalone function call.
        const sendFetch = deps.fetchImpl;
        const response = await sendFetch(buildSameOriginUrl("/console/api/chat"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            csrf,
            message: text,
            threadId,
            chatMode: effectivePreviewMode,
            title: submittedTitle,
            ...(runModel ? { model: runModel } : {}),
            runId: clientRunId,
            userMessageId: userMessage.id,
            assistantMessageId,
            ...(visitorToken ? { visitorToken } : {}),
          }),
          signal: controller.signal,
        });

        if (!ownsRun()) {
          const error = new Error("The chat request was superseded.");
          error.name = "AbortError";
          throw error;
        }

        if (!response.ok) durabilityRejected = true;
        if (response.status === 410 && ownsRun()) {
          confirmServerThreadDeletion(threadId);
        }
        if (response.status === 419) throw new Error("Session expired — reload the page.");
        if (!response.ok) {
          if (promotingVisitor && response.status === 403) {
            pendingVisitorPromotionsRef.current.delete(threadId);
            clearVisitorPromotionIntent(threadId, visitorToken);
          }
          const detail = await readErrorDetail(response);
          throw new Error(
            `${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
          );
        }
        const acceptedState = dispatch({
          type: "run.accept",
          clientRunId,
          threadId,
          assistantMessageId,
          ...(promotingVisitor ? { promoteToVisitor: true as const } : {}),
        });
        accepted =
          acceptedState.activeRun?.clientRunId === clientRunId &&
          acceptedState.activeRun.threadId === threadId &&
          acceptedState.activeRun.assistantMessageId === assistantMessageId &&
          acceptedState.activeRun.phase === "accepted";
        if (!accepted) throw new Error("The accepted response lost its chat ownership.");
        if (effectivePreviewMode === "visitor" && visitorToken) {
          visitorTokenByThreadRef.current.set(threadId, visitorToken);
        }
        if (promotingVisitor) {
          pendingVisitorPromotionsRef.current.delete(threadId);
          clearVisitorPromotionIntent(threadId, visitorToken);
        }
        try {
          onAccepted?.();
        } catch {
          // UI acknowledgement must not be able to orphan an accepted agent run.
        }
        if (!response.body) throw new Error("The agent returned an empty response.");

        for await (const event of parseSSEStream(response.body, { signal: controller.signal })) {
          if (
            event.type === "RUN_STARTED" &&
            event.threadId &&
            event.threadId !== threadId
          ) {
            outcome = "error";
            eventError = "The agent responded with a mismatched chat identifier.";
            sawTerminalEvent = true;
            break;
          }
          const eventResult = applyStreamEvent(event, toolCalls, receivedText, textStreamState);
          receivedText = eventResult.receivedText;
          if (eventResult.patch) updateAssistant(eventResult.patch);
          if (eventResult.error) {
            eventError = eventResult.error;
            outcome = eventResult.interrupted ? "interrupted" : "error";
          }
          if (eventResult.terminal) sawTerminalEvent = true;
        }
        if (!sawTerminalEvent) {
          outcome = "interrupted";
          eventError = "Response ended before the agent reported completion.";
        }
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          outcome = "interrupted";
          eventError = "Response stopped before completion.";
        } else {
          outcome = "error";
          eventError = error instanceof Error ? error.message : "The response failed.";
        }
      } finally {
        // A future request must never clear a newer owner's lock or reducer state.
        if (
          runLockRef.current?.clientRunId === clientRunId &&
          runLockRef.current.threadId === threadId &&
          runLockRef.current.assistantMessageId === assistantMessageId
        ) {
          runLockRef.current = null;
        }
        const next = accepted
          ? dispatch({
              type: "run.finish",
              clientRunId,
              threadId,
              assistantMessageId,
              outcome,
              error: eventError,
              at: dependenciesRef.current.now().toISOString(),
            })
          : dispatch({
              type: "run.rollback",
              clientRunId,
              threadId,
              assistantMessageId,
              durability: durabilityRejected ? "rejected" : "unknown",
            });
        if (
          accepted &&
          getVisibleDurableChatThreadId(next) === threadId
        ) {
          try {
            await persistReadState(threadId, false);
          } catch {
            // The conversation itself completed successfully. A later selection or
            // visibility transition retries the read marker with a fresh CSRF token.
          }
        }
      }

      return outcome === "complete"
        ? { ok: true }
        : { ok: false, error: eventError ?? "The response did not complete." };
    },
    [confirmServerThreadDeletion, dispatch, persistReadState],
  );

  const activeThread = getSelectedRenderableChatWorkspaceThread(state) ?? null;

  const value = useMemo<ChatWorkspaceContextValue>(
    () => ({
      state,
      activeThread,
      deletingThreadIds,
      hydrationStatus,
      hydrationError,
      anonymousAllowed: data?.web.allowAnonymous.value !== false,
      hasVisitorToken,
      visitorIdentity,
      create,
      selectWelcome,
      select,
      loadThread,
      rename,
      markUnread,
      deleteThread,
      setPreviewMode,
      send,
      stop,
      refreshVisitorToken,
      clearVisitor,
      setChatVisible,
    }),
    [
      activeThread,
      clearVisitor,
      create,
      data?.web.allowAnonymous.value,
      deleteThread,
      deletingThreadIds,
      hasVisitorToken,
      visitorIdentity,
      hydrationError,
      hydrationStatus,
      loadThread,
      markUnread,
      refreshVisitorToken,
      rename,
      select,
      selectWelcome,
      send,
      setPreviewMode,
      setChatVisible,
      state,
      stop,
    ],
  );

  return <ChatWorkspaceContext.Provider value={value}>{children}</ChatWorkspaceContext.Provider>;
}

export function useChatWorkspace(): ChatWorkspaceContextValue {
  const context = useContext(ChatWorkspaceContext);
  if (!context) {
    throw new Error("useChatWorkspace must be used inside <ChatWorkspaceProvider>");
  }
  return context;
}

function durableThreadSummary(thread: ChatThread | DurableChatThread): ChatThreadSummary {
  if ("lifecycle" in thread) {
    if (thread.lifecycle === "summary") {
      const { lifecycle: _lifecycle, ...summary } = thread;
      return summary;
    }
    const {
      lifecycle: _lifecycle,
      detailError: _detailError,
      messages: _messages,
      ...summary
    } = thread;
    return summary;
  }
  const { messages: _messages, ...summary } = thread;
  return summary;
}

function getRenderableForId(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): LocalChatDraft | DurableChatThreadDetail | undefined {
  const target = getChatWorkspaceTargetById(state, threadId);
  return target?.lifecycle === "summary" ? undefined : target;
}

function detailReconciliationRetryDelay(failures: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(
    EXTERNAL_RUN_POLL_INITIAL_MS * 2 ** exponent,
    DETAIL_RECONCILIATION_RETRY_MAX_MS,
  );
}

function sameDetailReconciliationRevision(
  retry: DetailReconciliationRetry,
  summary: Pick<ChatThread, "updatedAt" | "runStatus">,
): boolean {
  return (
    retry.failedUpdatedAt === summary.updatedAt && retry.failedRunStatus === summary.runStatus
  );
}

export function shouldDeferDetailReconciliation(
  retry: DetailReconciliationRetry | undefined,
  summary: Pick<ChatThread, "updatedAt" | "runStatus">,
  now: number,
): boolean {
  return Boolean(retry && sameDetailReconciliationRevision(retry, summary) && retry.retryAt > now);
}

function nextReconciliationPollDelay(
  externalRun: boolean,
  baseDelay: number,
  retries: ReadonlyMap<string, DetailReconciliationRetry>,
): number {
  let delay = externalRun ? Math.min(baseDelay, EXTERNAL_RUN_POLL_MAX_MS) : baseDelay;
  const now = Date.now();
  for (const retry of retries.values()) {
    delay = Math.min(delay, Math.max(retry.retryAt - now, 25));
  }
  return delay;
}

function modelSnapshotFromDashboard(
  data: ReturnType<typeof useDashboardContext>["data"],
): ChatModelSnapshot | null {
  const provider = data?.agentMeta?.engine?.provider?.trim();
  const model = data?.agentMeta?.engine?.model?.trim();
  if (!provider && !model) return null;
  const id = model ?? provider ?? "unknown";
  return { id, displayName: model ?? provider ?? id, ...(provider ? { provider } : {}) };
}

function consoleChatCsrf(
  data: ReturnType<typeof useDashboardContext>["data"],
): string | null {
  return findCsrfToken(data?.csrfTokens ?? [], "console-chat");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function previewModeAvailabilityError(
  previewMode: ChatPreviewMode,
  anonymousAllowed: boolean,
  hasVisitorToken: boolean,
): string | null {
  if (previewMode === "anonymous" && !anonymousAllowed) {
    return "Anonymous chat is disabled for this agent.";
  }
  if (previewMode === "visitor" && !hasVisitorToken) {
    return "Verify a visitor before using this chat.";
  }
  return null;
}

interface AppliedStreamEvent {
  receivedText: string;
  patch?: Partial<Pick<ChatMessage, "content" | "toolCalls" | "error">>;
  error?: string;
  interrupted?: boolean;
  terminal?: boolean;
}

function applyStreamEvent(
  event: AGUIEvent,
  toolCalls: Map<string, ChatToolCall>,
  receivedText: string,
  textStreamState: { lastMessageId: string | null },
): AppliedStreamEvent {
  switch (event.type) {
    case "TEXT_MESSAGE_CONTENT": {
      if (event.messageId && textStreamState.lastMessageId !== event.messageId) {
        receivedText =
          textStreamState.lastMessageId === null
            ? receivedText
            : appendTextSegmentBoundary(receivedText);
        textStreamState.lastMessageId = event.messageId;
      }
      const nextText = receivedText + (event.delta ?? "");
      return { receivedText: nextText, patch: { content: nextText } };
    }
    case "TOOL_CALL_START": {
      toolCalls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolCallName ?? "unknown",
        status: "running",
      });
      return { receivedText, patch: { toolCalls: [...toolCalls.values()] } };
    }
    case "TOOL_CALL_ARGS": {
      const toolCall = toolCalls.get(event.toolCallId);
      if (!toolCall) return { receivedText };
      toolCalls.set(event.toolCallId, {
        ...toolCall,
        args: (toolCall.args ?? "") + (event.delta ?? ""),
      });
      return { receivedText, patch: { toolCalls: [...toolCalls.values()] } };
    }
    case "TOOL_CALL_RESULT": {
      const toolCall = toolCalls.get(event.toolCallId);
      if (!toolCall) return { receivedText };
      toolCalls.set(event.toolCallId, {
        ...toolCall,
        result: event.content ?? "",
        status: "completed",
      });
      return { receivedText, patch: { toolCalls: [...toolCalls.values()] } };
    }
    case "TOOL_CALL_END": {
      const toolCall = toolCalls.get(event.toolCallId);
      if (!toolCall) return { receivedText };
      if (toolCall.status === "running") {
        toolCalls.set(event.toolCallId, { ...toolCall, status: "completed" });
      }
      return { receivedText, patch: { toolCalls: [...toolCalls.values()] } };
    }
    case "RUN_ERROR": {
      const error = event.message || "The agent reported an error.";
      return { receivedText, patch: { error }, error, terminal: true };
    }
    case "RUN_FINISHED": {
      const status = event.result?.status;
      if (status === "canceled") {
        const error = event.result?.message || "Response stopped before completion.";
        return { receivedText, patch: { error }, error, interrupted: true, terminal: true };
      }
      if (status === "failed" || status === "rejected" || status === "auth-required") {
        const error = event.result?.message || `Agent run ${status}.`;
        return { receivedText, patch: { error }, error, terminal: true };
      }
      return { receivedText, terminal: true };
    }
    case "RUN_STARTED":
    case "TEXT_MESSAGE_START":
    case "TEXT_MESSAGE_END":
      return { receivedText };
  }
}

function appendTextSegmentBoundary(content: string): string {
  if (!content || content.endsWith("\n\n")) return content;
  return content.endsWith("\n") ? `${content}\n` : `${content}\n\n`;
}

/** Retry startup races and transport/server outages, but not auth or malformed-data failures. */
export function shouldRetryChatHydration(error: unknown): boolean {
  if (!isConsoleChatApiError(error)) return false;
  return error.status === 0 || error.status >= 500;
}

function readVisitorToken(): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const token = localStorage.getItem(VISITOR_TOKEN_STORAGE_KEY);
    return token && token.trim() !== "" ? token : undefined;
  } catch {
    return undefined;
  }
}

interface VisitorPromotionIntent {
  type: typeof VISITOR_VERIFIED_EVENT_TYPE;
  version: 1;
  threadId: string;
  tokenTag: string;
}

function readVisitorPromotionIntent(
  visitorToken?: string,
  options: { quarantineInvalid?: boolean } = {},
): VisitorPromotionIntent | undefined {
  if (!visitorToken) return undefined;
  try {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(VISITOR_PROMOTION_INTENT_STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.type !== VISITOR_VERIFIED_EVENT_TYPE ||
      value.version !== 1 ||
      typeof value.threadId !== "string" ||
      value.threadId.length === 0 ||
      value.threadId.length > 256 ||
      value.tokenTag !== visitorTokenTag(visitorToken)
    ) {
      if (options.quarantineInvalid) {
        localStorage.removeItem(VISITOR_PROMOTION_INTENT_STORAGE_KEY);
      }
      return undefined;
    }
    return {
      type: VISITOR_VERIFIED_EVENT_TYPE,
      version: 1,
      threadId: value.threadId,
      tokenTag: value.tokenTag,
    };
  } catch {
    if (options.quarantineInvalid) {
      try {
        localStorage.removeItem(VISITOR_PROMOTION_INTENT_STORAGE_KEY);
      } catch {
        // Ignore the same storage failure that made the intent unreadable.
      }
    }
    return undefined;
  }
}

function isVisitorVerifiedNotification(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const notification = value as Record<string, unknown>;
  return (
    notification.type === VISITOR_VERIFIED_EVENT_TYPE &&
    notification.version === 1
  );
}

function clearVisitorPromotionIntent(threadId?: string, visitorToken?: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (threadId === undefined) {
      localStorage.removeItem(VISITOR_PROMOTION_INTENT_STORAGE_KEY);
      return;
    }
    const current = readVisitorPromotionIntent(visitorToken);
    if (current?.threadId === threadId) {
      localStorage.removeItem(VISITOR_PROMOTION_INTENT_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private browsing or sandboxed contexts.
  }
}

function visitorTokenTag(token: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function clearVisitorToken(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(VISITOR_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private browsing or sandboxed contexts.
  }
}

function buildSameOriginUrl(path: string): string {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  return new URL(path, base).toString();
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const copy = response.clone();
    const body = (await copy.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? "";
  } catch {
    try {
      return (await response.text()).slice(0, 300);
    } catch {
      return "";
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}
