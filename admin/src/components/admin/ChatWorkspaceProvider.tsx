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
import { findCsrfToken } from "@/lib/api";
import { parseSSEStream, type AGUIEvent } from "@/lib/ag-ui-parse";
import {
  canStartChatRun,
  chatWorkspaceReducer,
  createChatThread,
  createChatWorkspace,
  getActiveChatThread,
  getChatThread,
  isEmptyChatThread,
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

const VISITOR_TOKEN_STORAGE_KEY = "auggy-visitor-token";

export type ChatWorkspaceCommandResult =
  | { ok: true }
  | { ok: false; error: string };

export type ChatWorkspaceThreadCommandResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string };

export interface ChatWorkspaceContextValue {
  state: ChatWorkspaceState;
  activeThread: ChatThread;
  anonymousAllowed: boolean;
  hasVisitorToken: boolean;
  create: (previewMode?: ChatPreviewMode) => string;
  select: (threadId: string) => boolean;
  rename: (threadId: string, title: string) => ChatThreadTitleValidation;
  markUnread: (threadId: string, unread?: boolean) => boolean;
  deleteThread: (threadId: string) => boolean;
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
  fetchImpl?: typeof fetch;
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
  fetchImpl = fetch,
  createId = defaultCreateId,
  now = () => new Date(),
}: ChatWorkspaceProviderProps) {
  const { data } = useDashboardContext();
  const dependenciesRef = useRef({ data, fetchImpl, createId, now });
  dependenciesRef.current = { data, fetchImpl, createId, now };

  const initialStateRef = useRef<ChatWorkspaceState | null>(null);
  if (initialStateRef.current === null) {
    const createdAt = now().toISOString();
    const initialThread = createChatThread({
      id: createId(),
      previewMode: "creator",
      model: modelSnapshotFromDashboard(data),
      now: createdAt,
    });
    initialStateRef.current = initialState ?? createChatWorkspace(initialThread);
  }

  const [state, setState] = useState<ChatWorkspaceState>(initialStateRef.current);
  const stateRef = useRef(state);
  const runLockRef = useRef<RunLock | null>(null);
  // Visitor credentials are deliberately memory-only and bound to the first
  // request made by a thread. A later token must never silently inherit that
  // thread's privileged model context.
  const visitorTokenByThreadRef = useRef(new Map<string, string>());
  const invalidatedVisitorThreadsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const [hasVisitorToken, setHasVisitorToken] = useState(() => Boolean(readVisitorToken()));

  const dispatch = useCallback((action: ChatWorkspaceAction) => {
    const next = chatWorkspaceReducer(stateRef.current, action);
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
    };
  }, []);

  const refreshVisitorToken = useCallback(() => {
    const available = Boolean(readVisitorToken());
    if (!available) {
      for (const threadId of visitorTokenByThreadRef.current.keys()) {
        invalidatedVisitorThreadsRef.current.add(threadId);
      }
    }
    if (mountedRef.current) setHasVisitorToken(available);
    return available;
  }, []);

  const clearVisitor = useCallback(() => {
    for (const threadId of visitorTokenByThreadRef.current.keys()) {
      invalidatedVisitorThreadsRef.current.add(threadId);
    }
    clearVisitorToken();
    if (mountedRef.current) setHasVisitorToken(false);
  }, []);

  const setChatVisible = useCallback(
    (visible: boolean) => {
      dispatch({
        type: "workspace.visibility-set",
        visible,
        at: dependenciesRef.current.now().toISOString(),
      });
    },
    [dispatch],
  );

  useEffect(() => {
    const refresh = () => refreshVisitorToken();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refreshVisitorToken]);

  useEffect(() => {
    const model = modelSnapshotFromDashboard(data);
    if (!model) return;
    const at = dependenciesRef.current.now().toISOString();
    for (const thread of stateRef.current.threads) {
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
      const next = dispatch({ type: "draft.activate", draft });
      return next.activeThreadId;
    },
    [dispatch],
  );

  const select = useCallback(
    (threadId: string) => {
      if (!getChatThread(stateRef.current, threadId)) return false;
      dispatch({ type: "thread.select", threadId, at: dependenciesRef.current.now().toISOString() });
      return true;
    },
    [dispatch],
  );

  const rename = useCallback(
    (threadId: string, title: string) => {
      const validation = validateRenamedChatThreadTitle(title);
      if (!validation.valid || !getChatThread(stateRef.current, threadId)) return validation;
      dispatch({
        type: "thread.rename",
        threadId,
        title: validation.title,
        at: dependenciesRef.current.now().toISOString(),
      });
      return validation;
    },
    [dispatch],
  );

  const markUnread = useCallback(
    (threadId: string, unread = true) => {
      if (!getChatThread(stateRef.current, threadId)) return false;
      dispatch({
        type: "thread.read-state-set",
        threadId,
        unread,
        at: dependenciesRef.current.now().toISOString(),
      });
      return true;
    },
    [dispatch],
  );

  const deleteThread = useCallback(
    (threadId: string) => {
      const current = stateRef.current;
      if (!getChatThread(current, threadId) || current.activeRun?.threadId === threadId) {
        return false;
      }
      const deps = dependenciesRef.current;
      const at = deps.now().toISOString();
      const active = getActiveChatThread(current);
      visitorTokenByThreadRef.current.delete(threadId);
      invalidatedVisitorThreadsRef.current.delete(threadId);
      dispatch({
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
      return true;
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
      if (!canStartChatRun(currentState, threadId)) {
        return { ok: false, error: "Another response is already running." };
      }

      const deps = dependenciesRef.current;
      const anonymousAllowed = deps.data?.web.allowAnonymous.value !== false;
      const visitorToken = thread.previewMode === "visitor" ? readVisitorToken() : undefined;
      setHasVisitorToken(Boolean(readVisitorToken()));
      const availabilityError = previewModeAvailabilityError(
        thread.previewMode,
        anonymousAllowed,
        Boolean(visitorToken),
      );
      if (availabilityError) return { ok: false, error: availabilityError };
      if (thread.previewMode === "visitor" && visitorToken) {
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

      // Claim the global stream synchronously. React state updates alone cannot prevent
      // two send calls in the same event turn from racing past the guard above.
      runLockRef.current = lock;
      if (thread.previewMode === "visitor" && visitorToken) {
        visitorTokenByThreadRef.current.set(threadId, visitorToken);
      }
      dispatch({
        type: "run.start",
        clientRunId,
        threadId,
        userMessage,
        assistantMessage,
        model: modelSnapshotFromDashboard(deps.data),
        at: sentAt,
      });
      try {
        onAccepted?.();
      } catch {
        // UI acknowledgement must not be able to orphan an accepted agent run.
      }

      const toolCalls = new Map<string, ChatToolCall>();
      let receivedText = "";
      let eventError: string | undefined;
      let outcome: "complete" | "error" | "interrupted" = "complete";
      let sawTerminalEvent = false;

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
        const response = await deps.fetchImpl(buildSameOriginUrl("/console/api/chat"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            csrf,
            message: text,
            threadId,
            chatMode: thread.previewMode,
            ...(visitorToken ? { visitorToken } : {}),
          }),
          signal: controller.signal,
        });

        if (response.status === 419) throw new Error("Session expired — reload the page.");
        if (!response.ok) {
          const detail = await readErrorDetail(response);
          throw new Error(
            `${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
          );
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
          const eventResult = applyStreamEvent(event, toolCalls, receivedText);
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
        dispatch({
          type: "run.finish",
          clientRunId,
          threadId,
          outcome,
          error: eventError,
          at: dependenciesRef.current.now().toISOString(),
        });
      }

      return outcome === "complete"
        ? { ok: true }
        : { ok: false, error: eventError ?? "The response did not complete." };
    },
    [dispatch],
  );

  const activeThread = getActiveChatThread(state);
  if (!activeThread) {
    throw new Error("Chat workspace invariant violated: active thread is missing");
  }

  const value = useMemo<ChatWorkspaceContextValue>(
    () => ({
      state,
      activeThread,
      anonymousAllowed: data?.web.allowAnonymous.value !== false,
      hasVisitorToken,
      create,
      select,
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
      hasVisitorToken,
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

function modelSnapshotFromDashboard(
  data: ReturnType<typeof useDashboardContext>["data"],
): ChatModelSnapshot | null {
  const provider = data?.agentMeta?.engine?.provider?.trim();
  const model = data?.agentMeta?.engine?.model?.trim();
  if (!provider && !model) return null;
  const id = model ?? provider ?? "unknown";
  return { id, displayName: model ?? provider ?? id, ...(provider ? { provider } : {}) };
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
): AppliedStreamEvent {
  switch (event.type) {
    case "TEXT_MESSAGE_CONTENT": {
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

function readVisitorToken(): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const token = localStorage.getItem(VISITOR_TOKEN_STORAGE_KEY);
    return token && token.trim() !== "" ? token : undefined;
  } catch {
    return undefined;
  }
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
