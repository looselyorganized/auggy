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
  canStartChatRun,
  chatThreadFromSummary,
  chatWorkspaceReducer,
  createChatThread,
  createChatWorkspace,
  deriveChatThreadTitle,
  getActiveChatThread,
  getChatThread,
  isEmptyChatThread,
  mergeHydratedChatThreads,
  validateRenamedChatThreadTitle,
  type ActiveChatRun,
  type ChatMessage,
  type ChatModelSnapshot,
  type ChatPreviewMode,
  type ChatThread,
  type ChatThreadTitleValidation,
  type ChatToolCall,
  type ChatWorkspaceAction,
  type ChatWorkspaceState,
} from "@/lib/chat-workspace";
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
  state: ChatWorkspaceState;
  activeThread: ChatThread;
  ephemeralDraftId: string;
  deletingThreadIds: ReadonlySet<string>;
  hydrationStatus: "loading" | "ready" | "error";
  hydrationError: string | null;
  anonymousAllowed: boolean;
  hasVisitorToken: boolean;
  visitorIdentity: VisitorIdentityState;
  create: (previewMode?: ChatPreviewMode) => string;
  select: (threadId: string) => boolean;
  loadThread: (threadId: string) => Promise<boolean>;
  rename: (threadId: string, title: string) => Promise<ChatThreadTitleValidation>;
  markUnread: (threadId: string, unread?: boolean) => Promise<boolean>;
  deleteThread: (threadId: string) => Promise<boolean>;
  setPreviewMode: (previewMode: ChatPreviewMode) => ChatWorkspaceThreadCommandResult;
  send: (
    message: string,
    threadId?: string,
    onAccepted?: () => void,
  ) => Promise<ChatWorkspaceCommandResult>;
  stop: () => boolean;
  refreshVisitorToken: () => boolean;
  clearVisitor: () => void;
  setChatVisible: (visible: boolean) => void;
}

interface ChatWorkspaceProviderProps {
  children: ReactNode;
  /** Intended for tests and, later, durable server hydration. */
  initialState?: ChatWorkspaceState;
  fetchImpl?: AdminFetch;
  createId?: () => string;
  now?: () => Date;
}

interface RunLock extends ActiveChatRun {
  controller: AbortController;
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

  const initialStateRef = useRef<ChatWorkspaceState | null>(null);
  if (initialStateRef.current === null) {
    if (initialState) {
      initialStateRef.current = initialState;
    } else {
      const createdAt = now().toISOString();
      const initialThread = createChatThread({
        id: createId(),
        previewMode: "creator",
        model: modelSnapshotFromDashboard(data),
        now: createdAt,
      });
      initialStateRef.current = createChatWorkspace(initialThread);
    }
  }

  const [state, setState] = useState<ChatWorkspaceState>(initialStateRef.current);
  const stateRef = useRef(state);
  const runLockRef = useRef<RunLock | null>(null);
  const localDraftIdRef = useRef(initialStateRef.current.activeThreadId);
  const persistedThreadIdsRef = useRef(
    new Set(
      initialState
        ? initialState.threads
            .filter((thread) => !isEmptyChatThread(thread))
            .map((thread) => thread.id)
        : [],
    ),
  );
  const loadedThreadIdsRef = useRef(
    new Set(initialState ? initialState.threads.map((thread) => thread.id) : []),
  );
  const detailRequestRef = useRef(new Map<string, number>());
  const selectionRequestRef = useRef(0);
  const mutationRequestRef = useRef(new Map<string, number>());
  const readMutationQueueRef = useRef(new Map<string, Promise<unknown>>());
  const threadRevisionRef = useRef(new Map<string, number>());
  const detailReconciliationRetriesRef = useRef(new Map<string, DetailReconciliationRetry>());
  const draftRenamedIdsRef = useRef(new Set<string>());
  const deletingThreadIdsRef = useRef(new Set<string>());
  const nextRequestIdRef = useRef(0);
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
  const visitorIdentityRequestRef = useRef(0);
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

  const dispatch = useCallback((action: ChatWorkspaceAction) => {
    const previous = stateRef.current;
    const next = chatWorkspaceReducer(previous, action);
    if (next !== previous) {
      const previousById = new Map(previous.threads.map((thread) => [thread.id, thread]));
      for (const thread of next.threads) {
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
      runLockRef.current?.controller.abort();
      runLockRef.current = null;
      visitorTokenByThreadRef.current.clear();
      invalidatedVisitorThreadsRef.current.clear();
      pendingVisitorPromotionsRef.current.clear();
      visitorIdentityInFlightTokenRef.current = undefined;
      visitorIdentitySettledTokenRef.current = undefined;
      deletingThreadIdsRef.current.clear();
      draftRenamedIdsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (initialState) return;
    const controller = new AbortController();
    let retryDelay = CHAT_HYDRATION_RETRY_INITIAL_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const hydrate = async () => {
      ++nextRequestIdRef.current;
      try {
        const summaries = await listConsoleChatThreads({
          signal: controller.signal,
          fetchImpl: dependenciesRef.current.fetchImpl,
        });
        if (!mountedRef.current || controller.signal.aborted) return;
        const current = stateRef.current;
        const serverIds = new Set(summaries.map((thread) => thread.id));
        for (const id of serverIds) persistedThreadIdsRef.current.add(id);

        const hydrated = mergeHydratedChatThreads(current, summaries, {
          localDraftId: localDraftIdRef.current,
          persistedThreadIds: persistedThreadIdsRef.current,
          loadedThreadIds: loadedThreadIdsRef.current,
        });
        const activeThreadId =
          !current.activeRun &&
          current.activeThreadId === localDraftIdRef.current &&
          summaries[0]
            ? summaries[0].id
            : current.activeThreadId;
        dispatch({
          type: "workspace.hydrate",
          threads: hydrated,
          activeThreadId,
        });
        setHydrationStatus("ready");
        setHydrationError(null);
      } catch (error: unknown) {
        if (!mountedRef.current || controller.signal.aborted || isAbortError(error)) return;
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
        }
      }
    };

    void hydrate();

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [dispatch, initialState]);

  const resolveVisitorIdentity = useCallback((token: string | undefined, force = false) => {
    if (!token) {
      visitorIdentityRequestRef.current++;
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
    const requestId = ++visitorIdentityRequestRef.current;
    visitorIdentityInFlightTokenRef.current = token;
    if (mountedRef.current) setVisitorIdentity({ status: "checking" });
    void resolveConsoleVisitorIdentity(token, csrf, {
      fetchImpl: dependenciesRef.current.fetchImpl,
    }).then(
      (identity) => {
        if (
          !mountedRef.current ||
          visitorIdentityRequestRef.current !== requestId ||
          readVisitorToken() !== token
        ) {
          return;
        }
        visitorIdentityInFlightTokenRef.current = undefined;
        visitorIdentitySettledTokenRef.current = token;
        setVisitorIdentity(identity);
      },
      (error: unknown) => {
        if (!mountedRef.current || visitorIdentityRequestRef.current !== requestId) return;
        visitorIdentityInFlightTokenRef.current = undefined;
        setVisitorIdentity({
          status: "unavailable",
          error: errorMessage(error, "Visitor identity could not be verified."),
        });
      },
    );
  }, []);

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

  const persistReadState = useCallback(
    async (threadId: string, unread: boolean): Promise<boolean> => {
      if (!persistedThreadIdsRef.current.has(threadId)) return false;
      const csrf = consoleChatCsrf(dependenciesRef.current.data);
      if (!csrf) throw new Error("Session expired — reload the page.");
      const key = `${threadId}:read`;
      const requestId = ++nextRequestIdRef.current;
      mutationRequestRef.current.set(key, requestId);
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
      let summary;
      try {
        summary = await request;
      } finally {
        if (readMutationQueueRef.current.get(threadId) === request) {
          readMutationQueueRef.current.delete(threadId);
        }
      }
      if (
        mountedRef.current &&
        mutationRequestRef.current.get(key) === requestId &&
        getChatThread(stateRef.current, threadId)
      ) {
        dispatch({
          type: "thread.read-state-confirmed",
          threadId,
          unread: summary.unread,
          lastReadAt: summary.lastReadAt,
        });
      }
      return true;
    },
    [dispatch],
  );

  const setChatVisible = useCallback(
    (visible: boolean) => {
      const at = dependenciesRef.current.now().toISOString();
      dispatch({ type: "workspace.visibility-set", visible, at });
      setVisibilityKnown(true);
    },
    [dispatch],
  );

  // Selection/visibility can become ready before the dashboard CSRF payload.
  // Key this retry to the stable token and active route state so the durable
  // read marker cannot be lost during initial parallel hydration.
  useEffect(() => {
    if (!visibilityKnown || !consoleChatCsrfToken || !state.chatVisible) return;
    if (!persistedThreadIdsRef.current.has(state.activeThreadId)) return;
    void persistReadState(state.activeThreadId, false).catch(() => {
      // Explicit mark-unread errors remain user-visible; passive read markers
      // are retried by the next selection, visibility change, or page load.
    });
  }, [
    consoleChatCsrfToken,
    persistReadState,
    state.activeThreadId,
    state.chatVisible,
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
    const remaining = visitorIdentity.expiresAt - Date.now();
    if (remaining <= 0) {
      visitorIdentitySettledTokenRef.current = currentVisitorTokenRef.current;
      setVisitorIdentity({ status: "invalid", error: "Visitor identity expired." });
      return;
    }
    const timer = setTimeout(() => {
      visitorIdentitySettledTokenRef.current = currentVisitorTokenRef.current;
      setVisitorIdentity({ status: "invalid", error: "Visitor identity expired." });
    }, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [visitorIdentity]);

  useEffect(() => {
    const model = modelSnapshotFromDashboard(data);
    if (!model) return;
    const at = dependenciesRef.current.now().toISOString();
    for (const thread of stateRef.current.threads) {
      if (persistedThreadIdsRef.current.has(thread.id)) continue;
      if (!isEmptyChatThread(thread)) continue;
      if (
        thread.model?.id === model.id &&
        thread.model.displayName === model.displayName &&
        thread.model.provider === model.provider
      ) {
        continue;
      }
      dispatch({ type: "thread.model-set", threadId: thread.id, model, at });
    }
  }, [data, dispatch]);

  const externalStreamingKey = state.threads
    .filter(
      (thread) =>
        thread.runStatus === "streaming" && state.activeRun?.threadId !== thread.id,
    )
    .map((thread) => thread.id)
    .sort()
    .join("\0");

  useEffect(() => {
    if (hydrationStatus !== "ready") return;
    const controller = new AbortController();
    let delay = nextReconciliationPollDelay(
      Boolean(externalStreamingKey),
      externalStreamingKey ? EXTERNAL_RUN_POLL_INITIAL_MS : EXTERNAL_RUN_POLL_MAX_MS,
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
        const summaryIds = new Set(summaries.map(({ id }) => id));
        for (const summary of summaries) {
          const current = getChatThread(stateRef.current, summary.id);
          if (!current) {
            if (
              deletingThreadIdsRef.current.has(summary.id) ||
              (threadRevisionRef.current.get(summary.id) ?? 0) !==
                (revisionsBeforeRequest.get(summary.id) ?? 0)
            ) {
              continue;
            }
            persistedThreadIdsRef.current.add(summary.id);
            dispatch({
              type: "workspace.hydrate",
              threads: [...stateRef.current.threads, chatThreadFromSummary(summary)],
              activeThreadId: stateRef.current.activeThreadId,
            });
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
          if (loadedThreadIdsRef.current.has(summary.id)) {
            const beforeRevision = threadRevisionRef.current.get(summary.id) ?? 0;
            try {
              const detail = await getConsoleChatThread(summary.id, {
                signal: controller.signal,
                fetchImpl: dependenciesRef.current.fetchImpl,
              });
              const latest = getChatThread(stateRef.current, summary.id);
              if (
                latest &&
                stateRef.current.activeRun?.threadId !== summary.id &&
                (threadRevisionRef.current.get(summary.id) ?? 0) === beforeRevision
              ) {
                detailReconciliationRetriesRef.current.delete(summary.id);
                dispatch({ type: "thread.detail-merge", thread: detail });
                if (
                  detail.runStatus !== "streaming" &&
                  stateRef.current.chatVisible &&
                  stateRef.current.activeThreadId === detail.id
                ) {
                  void persistReadState(detail.id, false).catch(() => {
                    // Keep the reconciled transcript usable; selection retries the marker.
                  });
                }
              }
              continue;
            } catch (error) {
              if (isAbortError(error)) return;
              if (summary.runStatus !== "streaming") {
                // Unlock this thread using an explicit local error state while
                // retaining its last known transcript. Because the server
                // summary remains terminal, the explicit pending marker retries
                // detail even when the server and local error statuses match.
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
          dispatch({ type: "thread.summary-merge", thread: summary });
        }

        for (const thread of stateRef.current.threads) {
          if (
            !persistedThreadIdsRef.current.has(thread.id) ||
            stateRef.current.activeRun?.threadId === thread.id ||
            summaryIds.has(thread.id) ||
            (threadRevisionRef.current.get(thread.id) ?? 0) !==
              (revisionsBeforeRequest.get(thread.id) ?? 0)
          ) {
            continue;
          }
          const deps = dependenciesRef.current;
          const at = deps.now().toISOString();
          const next = dispatch({
            type: "thread.delete",
            threadId: thread.id,
            at,
            fallbackDraft: createChatThread({
              id: deps.createId(),
              previewMode: thread.previewMode,
              model: modelSnapshotFromDashboard(deps.data),
              now: at,
            }),
          });
          persistedThreadIdsRef.current.delete(thread.id);
          loadedThreadIdsRef.current.delete(thread.id);
          detailRequestRef.current.delete(thread.id);
          detailReconciliationRetriesRef.current.delete(thread.id);
          visitorTokenByThreadRef.current.delete(thread.id);
          invalidatedVisitorThreadsRef.current.delete(thread.id);
          const promotionToken = pendingVisitorPromotionsRef.current.get(thread.id);
          pendingVisitorPromotionsRef.current.delete(thread.id);
          clearVisitorPromotionIntent(thread.id, promotionToken);
          const localDraft = next.threads.find(
            (candidate) =>
              !persistedThreadIdsRef.current.has(candidate.id) && isEmptyChatThread(candidate),
          );
          if (localDraft) localDraftIdRef.current = localDraft.id;
        }
        const hasExternalRun = stateRef.current.threads.some(
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
        if (isAbortError(error) || controller.signal.aborted) return;
        delay = Math.min(delay * 2, EXTERNAL_RUN_POLL_MAX_MS);
      }

      if (!controller.signal.aborted) {
        timer = setTimeout(() => void poll(), delay);
      }
    };

    timer = setTimeout(() => void poll(), delay);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [dispatch, externalStreamingKey, hydrationStatus, persistReadState]);

  const create = useCallback(
    (previewMode?: ChatPreviewMode) => {
      const current = getActiveChatThread(stateRef.current);
      const deps = dependenciesRef.current;
      const createdAt = deps.now().toISOString();
      const draft = createChatThread({
        id: deps.createId(),
        previewMode: previewMode ?? current?.previewMode ?? "creator",
        model: modelSnapshotFromDashboard(deps.data),
        now: createdAt,
      });
      const next = dispatch({
        type: "draft.activate",
        draft,
        reusableThreadId: localDraftIdRef.current,
      });
      localDraftIdRef.current = next.activeThreadId;
      draftRenamedIdsRef.current.delete(next.activeThreadId);
      return next.activeThreadId;
    },
    [dispatch],
  );

  const select = useCallback(
    (threadId: string) => {
      const thread = getChatThread(stateRef.current, threadId);
      if (!thread) return false;
      dispatch({
        type: "thread.select",
        threadId,
        at: dependenciesRef.current.now().toISOString(),
      });
      return true;
    },
    [dispatch],
  );

  const loadThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const selectionRequest = ++selectionRequestRef.current;
      const existing = getChatThread(stateRef.current, threadId);
      if (existing && !persistedThreadIdsRef.current.has(threadId)) {
        if (selectionRequest === selectionRequestRef.current) select(threadId);
        return true;
      }
      if (existing && loadedThreadIdsRef.current.has(threadId)) {
        if (selectionRequest === selectionRequestRef.current) select(threadId);
        return true;
      }

      const detailRequest = ++nextRequestIdRef.current;
      detailRequestRef.current.set(threadId, detailRequest);
      const beforeRevision = threadRevisionRef.current.get(threadId) ?? 0;
      try {
        const detail = await getConsoleChatThread(threadId, {
          fetchImpl: dependenciesRef.current.fetchImpl,
        });
        if (!mountedRef.current || detailRequestRef.current.get(threadId) !== detailRequest) {
          return false;
        }
        const current = getChatThread(stateRef.current, threadId);
        const revisionUnchanged =
          (threadRevisionRef.current.get(threadId) ?? 0) === beforeRevision;
        if (stateRef.current.activeRun?.threadId !== threadId) {
          if (current) {
            const threadToMerge =
              revisionUnchanged ? detail : { ...current, messages: detail.messages };
            dispatch({ type: "thread.detail-merge", thread: threadToMerge });
          } else if (revisionUnchanged) {
            dispatch({
              type: "workspace.hydrate",
              threads: [...stateRef.current.threads, detail],
              activeThreadId: stateRef.current.activeThreadId,
            });
          } else {
            return false;
          }
          loadedThreadIdsRef.current.add(threadId);
          detailReconciliationRetriesRef.current.delete(threadId);
        }
        persistedThreadIdsRef.current.add(threadId);
        if (selectionRequest === selectionRequestRef.current) select(threadId);
        return true;
      } catch (error) {
        if (isConsoleChatApiError(error) && error.code === "not-found") return false;
        throw error;
      }
    },
    [dispatch, select],
  );

  const rename = useCallback(
    async (threadId: string, title: string): Promise<ChatThreadTitleValidation> => {
      const validation = validateRenamedChatThreadTitle(title);
      if (!validation.valid || !getChatThread(stateRef.current, threadId)) return validation;
      if (deletingThreadIdsRef.current.has(threadId)) {
        throw new Error("This chat is being deleted.");
      }
      if (stateRef.current.activeRun?.threadId === threadId) {
        throw new Error("Wait for this response to finish before renaming the chat.");
      }
      if (!persistedThreadIdsRef.current.has(threadId)) {
        dispatch({
          type: "thread.rename",
          threadId,
          title: validation.title,
          at: dependenciesRef.current.now().toISOString(),
        });
        draftRenamedIdsRef.current.add(threadId);
        return validation;
      }
      const csrf = consoleChatCsrf(dependenciesRef.current.data);
      if (!csrf) throw new Error("Session expired — reload the page.");
      const key = `${threadId}:rename`;
      const requestId = ++nextRequestIdRef.current;
      mutationRequestRef.current.set(key, requestId);
      const summary = await renameConsoleChatThread(threadId, validation.title, csrf, {
        fetchImpl: dependenciesRef.current.fetchImpl,
      });
      if (
        mountedRef.current &&
        mutationRequestRef.current.get(key) === requestId &&
        getChatThread(stateRef.current, threadId)
      ) {
        dispatch({
          type: "thread.rename-confirmed",
          threadId,
          title: summary.title,
          updatedAt: summary.updatedAt,
        });
      }
      return validation;
    },
    [dispatch],
  );

  const markUnread = useCallback(
    async (threadId: string, unread = true): Promise<boolean> => {
      if (!getChatThread(stateRef.current, threadId)) return false;
      if (deletingThreadIdsRef.current.has(threadId)) {
        throw new Error("This chat is being deleted.");
      }
      if (stateRef.current.activeRun?.threadId === threadId) {
        throw new Error("Wait for this response to finish before changing its unread state.");
      }
      if (persistedThreadIdsRef.current.has(threadId)) {
        await persistReadState(threadId, unread);
      } else {
        dispatch({
          type: "thread.read-state-set",
          threadId,
          unread,
          at: dependenciesRef.current.now().toISOString(),
        });
      }
      return true;
    },
    [dispatch, persistReadState],
  );

  const deleteThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const current = stateRef.current;
      const target = getChatThread(current, threadId);
      if (
        !target ||
        deletingThreadIdsRef.current.has(threadId) ||
        target.runStatus === "streaming" ||
        current.activeRun?.threadId === threadId
      ) {
        return false;
      }
      deletingThreadIdsRef.current.add(threadId);
      setDeletingThreadIds(new Set(deletingThreadIdsRef.current));
      try {
        if (persistedThreadIdsRef.current.has(threadId)) {
          const csrf = consoleChatCsrf(dependenciesRef.current.data);
          if (!csrf) throw new Error("Session expired — reload the page.");
          const key = `${threadId}:delete`;
          const requestId = ++nextRequestIdRef.current;
          mutationRequestRef.current.set(key, requestId);
          await deleteConsoleChatThread(threadId, csrf, {
            fetchImpl: dependenciesRef.current.fetchImpl,
          });
          if (!mountedRef.current || mutationRequestRef.current.get(key) !== requestId) {
            return false;
          }
        }
        // The pending-delete guard prevents a send from claiming this thread
        // while the server mutation is in flight. Re-check before removing
        // persistence bookkeeping so future refactors cannot reintroduce it.
        if (stateRef.current.activeRun?.threadId === threadId) return false;

        const deps = dependenciesRef.current;
        const at = deps.now().toISOString();
        const active = getActiveChatThread(stateRef.current);
        persistedThreadIdsRef.current.delete(threadId);
        loadedThreadIdsRef.current.delete(threadId);
        detailRequestRef.current.delete(threadId);
        detailReconciliationRetriesRef.current.delete(threadId);
        visitorTokenByThreadRef.current.delete(threadId);
        invalidatedVisitorThreadsRef.current.delete(threadId);
        const promotionToken = pendingVisitorPromotionsRef.current.get(threadId);
        pendingVisitorPromotionsRef.current.delete(threadId);
        clearVisitorPromotionIntent(threadId, promotionToken);
        draftRenamedIdsRef.current.delete(threadId);
        const next = dispatch({
          type: "thread.delete",
          threadId,
          at,
          fallbackDraft: createChatThread({
            id: deps.createId(),
            previewMode: active?.previewMode ?? "creator",
            model: modelSnapshotFromDashboard(deps.data),
            now: at,
          }),
        });
        const localDraft = next.threads.find(
          (candidate) =>
            !persistedThreadIdsRef.current.has(candidate.id) && isEmptyChatThread(candidate),
        );
        if (localDraft) localDraftIdRef.current = localDraft.id;
        return true;
      } finally {
        deletingThreadIdsRef.current.delete(threadId);
        if (mountedRef.current) setDeletingThreadIds(new Set(deletingThreadIdsRef.current));
      }
    },
    [dispatch],
  );

  const setPreviewMode = useCallback(
    (previewMode: ChatPreviewMode): ChatWorkspaceThreadCommandResult => {
      const current = getActiveChatThread(stateRef.current);
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

      if (!isEmptyChatThread(current)) {
        return { ok: true, threadId: create(previewMode) };
      }

      dispatch({
        type: "thread.preview-mode-set",
        threadId: current.id,
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
      const threadId = requestedThreadId ?? currentState.activeThreadId;
      const thread = getChatThread(currentState, threadId);
      if (!thread) return { ok: false, error: "This chat no longer exists." };
      if (deletingThreadIdsRef.current.has(threadId)) {
        return { ok: false, error: "This chat is being deleted." };
      }
      if (!canStartChatRun(currentState, threadId)) {
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
      const runModel = modelSnapshotFromDashboard(deps.data);
      const submittedTitle =
        thread.messages.length === 0 && !draftRenamedIdsRef.current.has(threadId)
          ? deriveChatThreadTitle(text)
          : thread.title;

      // Claim the global stream synchronously. React state updates alone cannot prevent
      // two send calls in the same event turn from racing past the guard above.
      runLockRef.current = lock;
      dispatch({
        type: "run.start",
        clientRunId,
        threadId,
        title: submittedTitle,
        userMessage,
        assistantMessage,
        model: runModel,
        at: sentAt,
      });

      const toolCalls = new Map<string, ChatToolCall>();
      let receivedText = "";
      const textStreamState: { lastMessageId: string | null } = { lastMessageId: null };
      let eventError: string | undefined;
      let outcome: "complete" | "error" | "interrupted" = "complete";
      let sawTerminalEvent = false;
      let accepted = false;

      const updateAssistant = (
        patch: Partial<Pick<ChatMessage, "content" | "toolCalls" | "error">>,
      ) => {
        dispatch({
          type: "run.message-update",
          clientRunId,
          threadId,
          messageId: assistantMessageId,
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
        accepted = true;
        persistedThreadIdsRef.current.add(threadId);
        loadedThreadIdsRef.current.add(threadId);
        draftRenamedIdsRef.current.delete(threadId);
        if (effectivePreviewMode === "visitor" && visitorToken) {
          visitorTokenByThreadRef.current.set(threadId, visitorToken);
        }
        if (promotingVisitor) {
          pendingVisitorPromotionsRef.current.delete(threadId);
          clearVisitorPromotionIntent(threadId, visitorToken);
          dispatch({
            type: "thread.identity-promoted",
            threadId,
            at: dependenciesRef.current.now().toISOString(),
          });
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
        if (runLockRef.current?.clientRunId === clientRunId) runLockRef.current = null;
        const next = accepted
          ? dispatch({
              type: "run.finish",
              clientRunId,
              threadId,
              outcome,
              error: eventError,
              at: dependenciesRef.current.now().toISOString(),
            })
          : dispatch({
              type: "run.rollback",
              clientRunId,
              threadId,
              previousThread: thread,
            });
        if (
          accepted &&
          persistedThreadIdsRef.current.has(threadId) &&
          next.chatVisible &&
          next.activeThreadId === threadId
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
    [dispatch, persistReadState],
  );

  const activeThread = getActiveChatThread(state);
  if (!activeThread) {
    throw new Error("Chat workspace invariant violated: active thread is missing");
  }

  const value = useMemo<ChatWorkspaceContextValue>(
    () => ({
      state,
      activeThread,
      ephemeralDraftId: localDraftIdRef.current,
      deletingThreadIds,
      hydrationStatus,
      hydrationError,
      anonymousAllowed: data?.web.allowAnonymous.value !== false,
      hasVisitorToken,
      visitorIdentity,
      create,
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
