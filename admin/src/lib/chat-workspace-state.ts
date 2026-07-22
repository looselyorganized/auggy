import {
  createChatThread,
  deriveChatThreadTitle,
  validateRenamedChatThreadTitle,
  type ChatThread,
  type ChatThreadSummary,
  type ChatMessage,
  type ChatModelSnapshot,
  type ChatPreviewMode,
  type ChatRunStatus,
  type CreateChatThreadOptions,
} from "./chat-workspace";

/** A durable conversation known only through the server list response. */
export type DurableChatThreadSummary = ChatThreadSummary & {
  lifecycle: "summary";
};

/** A durable conversation whose transcript has also been loaded. */
export type DurableChatThreadDetail = ChatThread & {
  lifecycle: "detail";
  /** A detail refresh failure is transport state, not the canonical run status. */
  detailError: string | null;
};

export type DurableChatThread = DurableChatThreadSummary | DurableChatThreadDetail;

/**
 * The one browser-local composer draft. Its lifecycle is explicit: an empty
 * durable transcript is never inferred to be a draft.
 */
export type LocalChatDraft = ChatThread & {
  lifecycle: "draft";
  titleSource: "default" | "explicit";
};

export type ChatWorkspaceSelection =
  | { kind: "welcome" }
  | { kind: "draft"; draftId: string }
  | { kind: "thread"; threadId: string };

export type ChatWorkspaceVisibleTarget = Exclude<ChatWorkspaceSelection, { kind: "welcome" }>;

export interface ChatWorkspaceLifecycleState {
  durableThreads: readonly DurableChatThread[];
  draft: LocalChatDraft | null;
  /** Server durability observed before the matching POST response was accepted locally. */
  deferredDraftSummary: ChatThreadSummary | null;
  /** A first-send request may have committed even though no HTTP response arrived. */
  unconfirmedDraftRun: {
    threadId: string;
    clientRunId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null;
  selection: ChatWorkspaceSelection;
  /** Derived convenience flag kept coherent with the identity-bound visible target. */
  chatVisible: boolean;
  visibleTarget: ChatWorkspaceVisibleTarget | null;
  activeRun: ChatWorkspaceLifecycleRun | null;
}

interface ChatRunRollbackDelta {
  userMessageId: string;
  assistantMessageId: string;
  previousTitle: string;
  previousModel: ChatModelSnapshot | null;
  previousRunStatus: ChatRunStatus;
  previousUpdatedAt: string;
}

export interface ChatWorkspaceLifecycleRun {
  clientRunId: string;
  threadId: string;
  assistantMessageId: string;
  targetKind: "draft" | "thread";
  phase: "pending" | "accepted";
  rollback: ChatRunRollbackDelta;
  /** Latest ordered server summary held aside while local run-owned fields are authoritative. */
  deferredSummary?: ChatThreadSummary;
}

export type SelectedChatWorkspaceTarget =
  | { kind: "welcome" }
  | { kind: "draft"; draft: LocalChatDraft }
  | { kind: "thread"; thread: DurableChatThread };

export type ChatWorkspaceLifecycleAction =
  | { type: "server.hydrated"; summaries: readonly ChatThreadSummary[] }
  | { type: "thread.detail-loaded"; thread: ChatThread }
  | { type: "thread.summary-merge"; thread: ChatThreadSummary }
  | { type: "thread.reconciliation-failed"; thread: ChatThreadSummary; error: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "draft.set"; draft: LocalChatDraft }
  | { type: "draft.rename"; draftId: string; title: string; at: string }
  | {
      type: "draft.preview-mode-set";
      draftId: string;
      previewMode: ChatPreviewMode;
      at: string;
    }
  | {
      type: "draft.model-set";
      draftId: string;
      model: ChatModelSnapshot | null;
      at: string;
    }
  | { type: "draft.cleared"; draftId: string }
  | {
      type: "workspace.visibility-set";
      /** Null means hidden; otherwise the exact selected identity proven visible. */
      target: ChatWorkspaceVisibleTarget | null;
      at: string;
    }
  | { type: "selection.welcome" }
  | { type: "selection.draft"; draftId: string }
  | { type: "selection.thread"; threadId: string }
  | {
      type: "thread.rename-confirmed";
      threadId: string;
      title: string;
      updatedAt: string;
    }
  | {
      type: "thread.read-state-confirmed";
      threadId: string;
      unread: boolean;
      lastReadAt: string | null;
    }
  | {
      type: "run.start";
      clientRunId: string;
      threadId: string;
      title?: string;
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
      model: ChatModelSnapshot | null;
      at: string;
    }
  | {
      type: "run.accept";
      clientRunId: string;
      threadId: string;
      assistantMessageId: string;
      promoteToVisitor?: true;
    }
  | {
      type: "run.rollback";
      clientRunId: string;
      threadId: string;
      assistantMessageId: string;
      /** `unknown` means transport failure prevented a definitive server response. */
      durability?: "rejected" | "unknown";
    }
  | {
      type: "run.message-update";
      clientRunId: string;
      threadId: string;
      assistantMessageId: string;
      patch: Partial<Pick<ChatMessage, "content" | "toolCalls" | "error">>;
      at: string;
    }
  | {
      type: "run.finish";
      clientRunId: string;
      threadId: string;
      assistantMessageId: string;
      outcome: Exclude<ChatRunStatus, "idle" | "streaming">;
      error?: string;
      at: string;
    };

const WELCOME_SELECTION: ChatWorkspaceSelection = { kind: "welcome" };

/** Start with no implicit draft and no implicit durable selection. */
export function createChatWorkspaceLifecycleState(): ChatWorkspaceLifecycleState {
  return {
    durableThreads: [],
    draft: null,
    deferredDraftSummary: null,
    unconfirmedDraftRun: null,
    selection: WELCOME_SELECTION,
    chatVisible: false,
    visibleTarget: null,
    activeRun: null,
  };
}

/** Draft creation is the only operation that assigns the draft lifecycle. */
export function createLocalChatDraft(options: CreateChatThreadOptions): LocalChatDraft {
  return {
    ...createChatThread(options),
    lifecycle: "draft",
    titleSource: options.title?.trim() ? "explicit" : "default",
  };
}

export function getDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): DurableChatThread | undefined {
  return state.durableThreads.find((thread) => thread.id === threadId);
}

export function getLoadedDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): DurableChatThreadDetail | undefined {
  const thread = getDurableChatThread(state, threadId);
  return thread?.lifecycle === "detail" ? thread : undefined;
}

/** Resolve a workspace-owned target without conflating summaries and drafts. */
export function getChatWorkspaceTargetById(
  state: ChatWorkspaceLifecycleState,
  targetId: string,
): LocalChatDraft | DurableChatThread | undefined {
  if (state.draft?.id === targetId) return state.draft;
  return getDurableChatThread(state, targetId);
}

export function getSelectedChatWorkspaceId(
  state: ChatWorkspaceLifecycleState,
): string | null {
  if (state.selection.kind === "draft") return state.selection.draftId;
  if (state.selection.kind === "thread") return state.selection.threadId;
  return null;
}

/** A summary is navigation data and is not renderable as an empty transcript. */
export function getSelectedRenderableChatWorkspaceThread(
  state: ChatWorkspaceLifecycleState,
): LocalChatDraft | DurableChatThreadDetail | undefined {
  const selectedId = getSelectedChatWorkspaceId(state);
  if (!selectedId) return undefined;
  const target = getChatWorkspaceTargetById(state, selectedId);
  return target?.lifecycle === "summary" ? undefined : target;
}

export function hasDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): boolean {
  return getDurableChatThread(state, threadId) !== undefined;
}

/** The exact durable selection that may receive visible/read semantics. */
export function getVisibleDurableChatThreadId(
  state: ChatWorkspaceLifecycleState,
): string | null {
  if (
    !state.chatVisible ||
    state.visibleTarget?.kind !== "thread" ||
    state.selection.kind !== "thread" ||
    state.visibleTarget.threadId !== state.selection.threadId
  ) {
    return null;
  }
  return hasDurableChatThread(state, state.visibleTarget.threadId)
    ? state.visibleTarget.threadId
    : null;
}

export function hasChatWorkspaceUserMessages(
  thread: LocalChatDraft | DurableChatThreadDetail,
): boolean {
  return thread.messages.some((message) => message.role === "user");
}

export function getSelectedChatWorkspaceTarget(
  state: ChatWorkspaceLifecycleState,
): SelectedChatWorkspaceTarget {
  if (state.selection.kind === "draft") {
    return state.draft?.id === state.selection.draftId
      ? { kind: "draft", draft: state.draft }
      : { kind: "welcome" };
  }
  if (state.selection.kind === "thread") {
    const thread = getDurableChatThread(state, state.selection.threadId);
    return thread ? { kind: "thread", thread } : { kind: "welcome" };
  }
  return { kind: "welcome" };
}

/**
 * Replace the durable list with the authoritative server snapshot. Loaded
 * transcripts survive for matching IDs. A local run keeps ownership of its
 * optimistic fields while the latest ordered server summary is deferred.
 */
export function hydrateDurableChatThreads(
  state: ChatWorkspaceLifecycleState,
  summaries: readonly ChatThreadSummary[],
): ChatWorkspaceLifecycleState {
  assertUniqueThreadIds(summaries);
  const recoveredDraftSummary = summaries.find(
    (summary) =>
      !state.activeRun &&
      state.draft?.id === summary.id &&
      state.unconfirmedDraftRun?.threadId === summary.id,
  );
  if (recoveredDraftSummary && state.draft) {
    const draftId = state.draft.id;
    const selected =
      state.selection.kind === "draft" && state.selection.draftId === draftId;
    return hydrateDurableChatThreads(
      {
        ...state,
        draft: null,
        deferredDraftSummary: null,
        unconfirmedDraftRun: null,
        selection: selected ? { kind: "thread", threadId: draftId } : state.selection,
        chatVisible: selected ? false : state.chatVisible,
        visibleTarget: selected ? null : state.visibleTarget,
      },
      summaries,
    );
  }
  const pendingDraftId =
    state.activeRun?.phase === "pending" && state.activeRun.targetKind === "draft"
      ? state.activeRun.threadId
      : undefined;
  const deferredDraftSummary = summaries.find(
    (summary) => state.draft?.id === summary.id && summary.id === pendingDraftId,
  );
  const visibleSummaries = deferredDraftSummary
    ? summaries.filter((summary) => summary.id !== deferredDraftSummary.id)
    : summaries;
  assertNoDraftDurableIdCollision(state.draft, visibleSummaries);
  const existingById = new Map(state.durableThreads.map((thread) => [thread.id, thread]));
  let deferredRunSummary: ChatThreadSummary | undefined;
  const durableThreads = visibleSummaries.map<DurableChatThread>((summary) => {
    const existing = existingById.get(summary.id);
    if (existing?.lifecycle === "detail") {
      const preserveLocalRun = state.activeRun?.threadId === summary.id;
      if (preserveLocalRun) deferredRunSummary = summary;
      return {
        ...summary,
        ...(preserveLocalRun
          ? {
              title: existing.title,
              previewMode: existing.previewMode,
              model: existing.model,
              updatedAt: existing.updatedAt,
              runStatus: existing.runStatus,
            }
          : {}),
        messages: existing.messages,
        lifecycle: "detail",
        detailError: existing.detailError,
      };
    }
    return { ...summary, lifecycle: "summary" };
  });
  if (
    state.activeRun?.targetKind === "thread" &&
    !durableThreads.some((thread) => thread.id === state.activeRun?.threadId)
  ) {
    const activeThread = existingById.get(state.activeRun.threadId);
    if (activeThread) durableThreads.push(activeThread);
  }
  const durableIds = new Set(durableThreads.map((thread) => thread.id));
  const selection =
    state.selection.kind === "thread" && !durableIds.has(state.selection.threadId)
      ? WELCOME_SELECTION
      : state.selection;
  const selectionChanged = selection !== state.selection;

  return {
    ...state,
    durableThreads,
    deferredDraftSummary:
      pendingDraftId === undefined
        ? null
        : deferredDraftSummary ?? state.deferredDraftSummary,
    activeRun:
      state.activeRun && deferredRunSummary
        ? { ...state.activeRun, deferredSummary: deferredRunSummary }
        : state.activeRun,
    selection,
    chatVisible: selectionChanged ? false : state.chatVisible,
    visibleTarget: selectionChanged ? null : state.visibleTarget,
  };
}

/**
 * Enrich an existing durable summary with server detail. Unknown IDs are
 * ignored so a delayed detail response cannot resurrect a deleted thread.
 */
export function mergeDurableChatThreadDetail(
  state: ChatWorkspaceLifecycleState,
  thread: ChatThread,
): ChatWorkspaceLifecycleState {
  if (state.activeRun?.threadId === thread.id) return state;
  const index = state.durableThreads.findIndex((candidate) => candidate.id === thread.id);
  if (index < 0) return state;
  const durableThreads = state.durableThreads.slice();
  durableThreads[index] = { ...thread, lifecycle: "detail", detailError: null };
  return { ...state, durableThreads };
}

/**
 * Merge one server summary without dropping a previously loaded transcript.
 * Run-owned optimistic fields remain deferred until that run resolves.
 */
export function mergeDurableChatThreadSummary(
  state: ChatWorkspaceLifecycleState,
  summary: ChatThreadSummary,
): ChatWorkspaceLifecycleState {
  const index = state.durableThreads.findIndex((candidate) => candidate.id === summary.id);
  if (index < 0) return state;
  const existing = state.durableThreads[index];
  if (!existing) return state;
  if (state.activeRun?.threadId === summary.id) {
    return {
      ...state,
      activeRun: { ...state.activeRun, deferredSummary: summary },
    };
  }
  const next: DurableChatThread =
    existing.lifecycle === "detail"
      ? {
          ...summary,
          messages: existing.messages,
          lifecycle: "detail",
          detailError: existing.detailError,
        }
      : { ...summary, lifecycle: "summary" };
  if (durableChatThreadsEqual(existing, next)) return state;
  const durableThreads = state.durableThreads.slice();
  durableThreads[index] = next;
  return { ...state, durableThreads };
}

/** Preserve the transcript when terminal detail reconciliation cannot be loaded. */
export function recordDurableChatThreadDetailError(
  state: ChatWorkspaceLifecycleState,
  summary: ChatThreadSummary,
  error: string,
): ChatWorkspaceLifecycleState {
  if (!error) return mergeDurableChatThreadSummary(state, summary);
  const existing = getLoadedDurableChatThread(state, summary.id);
  if (!existing) return state;
  if (state.activeRun?.threadId === summary.id) return state;
  const next: DurableChatThreadDetail = {
    ...summary,
    messages: existing.messages,
    lifecycle: "detail",
    detailError: error,
  };
  if (durableChatThreadsEqual(existing, next)) return state;
  return replaceLoadedChatWorkspaceTarget(state, next);
}

/** Add or replace the local draft without changing the current selection. */
export function setLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  draft: LocalChatDraft,
): ChatWorkspaceLifecycleState {
  assertNoDraftDurableIdCollision(draft, state.durableThreads);
  if (state.activeRun?.targetKind === "draft") return state;
  if (state.draft === draft) return state;
  const selection =
    state.selection.kind === "draft" && state.selection.draftId !== draft.id
      ? WELCOME_SELECTION
      : state.selection;
  const selectionChanged = selection !== state.selection;
  return {
    ...state,
    draft,
    deferredDraftSummary: null,
    unconfirmedDraftRun:
      state.unconfirmedDraftRun?.threadId === draft.id
        ? state.unconfirmedDraftRun
        : null,
    selection,
    chatVisible: selectionChanged ? false : state.chatVisible,
    visibleTarget: selectionChanged ? null : state.visibleTarget,
  };
}

export function clearLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  draftId: string,
): ChatWorkspaceLifecycleState {
  if (state.activeRun?.targetKind === "draft") return state;
  if (state.draft?.id !== draftId) return state;
  const selectionChanged = state.selection.kind === "draft";
  return {
    ...state,
    draft: null,
    deferredDraftSummary: null,
    unconfirmedDraftRun: null,
    selection: selectionChanged ? WELCOME_SELECTION : state.selection,
    chatVisible: selectionChanged ? false : state.chatVisible,
    visibleTarget: selectionChanged ? null : state.visibleTarget,
  };
}

export function renameLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  draftId: string,
  title: string,
  at: string,
): ChatWorkspaceLifecycleState {
  const validation = validateRenamedChatThreadTitle(title);
  if (
    state.draft?.id !== draftId ||
    !validation.valid ||
    state.activeRun
  ) {
    return state;
  }
  return {
    ...state,
    draft: {
      ...state.draft,
      title: validation.title,
      titleSource: "explicit",
      updatedAt: at,
    },
  };
}

export function setLocalChatDraftPreviewMode(
  state: ChatWorkspaceLifecycleState,
  draftId: string,
  previewMode: ChatPreviewMode,
  at: string,
): ChatWorkspaceLifecycleState {
  if (state.activeRun || state.draft?.id !== draftId) return state;
  if (state.draft.previewMode === previewMode) return state;
  return { ...state, draft: { ...state.draft, previewMode, updatedAt: at } };
}

export function setLocalChatDraftModel(
  state: ChatWorkspaceLifecycleState,
  draftId: string,
  model: ChatModelSnapshot | null,
  at: string,
): ChatWorkspaceLifecycleState {
  if (state.activeRun || state.draft?.id !== draftId) return state;
  if (chatModelsEqual(state.draft.model, model)) return state;
  return { ...state, draft: { ...state.draft, model, updatedAt: at } };
}

export function setChatWorkspaceVisibility(
  state: ChatWorkspaceLifecycleState,
  target: ChatWorkspaceVisibleTarget | null,
  at: string,
): ChatWorkspaceLifecycleState {
  if (!target) {
    return state.chatVisible || state.visibleTarget
      ? { ...state, chatVisible: false, visibleTarget: null }
      : state;
  }
  if (!visibleTargetMatchesSelection(target, state.selection)) return state;
  if (
    (target.kind === "draft" && state.draft?.id !== target.draftId) ||
    (target.kind === "thread" && !hasDurableChatThread(state, target.threadId))
  ) {
    return state;
  }
  const exactVisibleThreadId = target.kind === "thread" ? target.threadId : null;
  const exactVisibleThread = exactVisibleThreadId
    ? getDurableChatThread(state, exactVisibleThreadId)
    : undefined;
  const durableThreads =
    exactVisibleThread && (exactVisibleThread.unread || exactVisibleThread.lastReadAt !== at)
      ? state.durableThreads.map((thread) =>
          thread.id === exactVisibleThreadId
            ? { ...thread, unread: false, lastReadAt: at }
            : thread,
        )
      : state.durableThreads;
  if (
    state.chatVisible &&
    visibleTargetsEqual(state.visibleTarget, target) &&
    durableThreads === state.durableThreads
  ) {
    return state;
  }
  return { ...state, chatVisible: true, visibleTarget: target, durableThreads };
}

export function confirmDurableChatThreadRename(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
  title: string,
  updatedAt: string,
): ChatWorkspaceLifecycleState {
  if (state.activeRun?.threadId === threadId) return state;
  return updateDurableChatThread(state, threadId, (thread) =>
    thread.title === title && thread.updatedAt === updatedAt
      ? thread
      : { ...thread, title, updatedAt },
  );
}

export function confirmDurableChatThreadReadState(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
  unread: boolean,
  lastReadAt: string | null,
): ChatWorkspaceLifecycleState {
  return updateDurableChatThread(state, threadId, (thread) =>
    thread.unread === unread && thread.lastReadAt === lastReadAt
      ? thread
      : { ...thread, unread, lastReadAt },
  );
}

export function canStartChatWorkspaceLifecycleRun(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): boolean {
  if (state.activeRun) return false;
  if (state.draft?.id === threadId) return state.draft.runStatus !== "streaming";
  const durable = getDurableChatThread(state, threadId);
  return durable?.lifecycle === "detail" && durable.runStatus !== "streaming";
}

export function startChatWorkspaceLifecycleRun(
  state: ChatWorkspaceLifecycleState,
  action: Extract<ChatWorkspaceLifecycleAction, { type: "run.start" }>,
): ChatWorkspaceLifecycleState {
  if (!canStartChatWorkspaceLifecycleRun(state, action.threadId)) return state;
  if (
    !action.clientRunId ||
    !action.userMessage.id ||
    !action.assistantMessage.id ||
    !action.userMessage.content.trim() ||
    action.userMessage.role !== "user" ||
    action.assistantMessage.role !== "assistant" ||
    action.userMessage.id === action.assistantMessage.id
  ) {
    return state;
  }

  const target = getLoadedChatWorkspaceTarget(state, action.threadId);
  if (
    !target ||
    target.messages.some(
      (message) =>
        message.id === action.userMessage.id || message.id === action.assistantMessage.id,
    )
  ) {
    return state;
  }

  const submittedTitle =
    target.lifecycle === "detail"
      ? target.title
      : target.titleSource === "explicit"
        ? target.title
        : action.title?.trim() || deriveChatThreadTitle(action.userMessage.content);
  const optimisticModel = action.model ?? target.model;
  const nextTarget = {
    ...target,
    title: submittedTitle,
    model: optimisticModel,
    messages: [...target.messages, action.userMessage, action.assistantMessage],
    runStatus: "streaming" as const,
    updatedAt: action.at,
  };
  const next = replaceLoadedChatWorkspaceTarget(state, nextTarget);
  return {
    ...next,
    activeRun: {
      clientRunId: action.clientRunId,
      threadId: action.threadId,
      assistantMessageId: action.assistantMessage.id,
      targetKind: target.lifecycle === "draft" ? "draft" : "thread",
      phase: "pending",
      rollback: {
        userMessageId: action.userMessage.id,
        assistantMessageId: action.assistantMessage.id,
        previousTitle: target.title,
        previousModel: target.model,
        previousRunStatus: target.runStatus,
        previousUpdatedAt: target.updatedAt,
      },
    },
  };
}

export function acceptChatWorkspaceLifecycleRun(
  state: ChatWorkspaceLifecycleState,
  action: Extract<ChatWorkspaceLifecycleAction, { type: "run.accept" }>,
): ChatWorkspaceLifecycleState {
  const run = matchingChatWorkspaceLifecycleRun(state, action);
  if (!run || run.phase !== "pending") return state;
  const target = getLoadedChatWorkspaceTarget(state, action.threadId);
  if (!target) return state;
  const previewMode =
    action.promoteToVisitor && target.previewMode === "anonymous"
      ? "visitor"
      : target.previewMode;
  if (run.targetKind === "draft") {
    if (target.lifecycle !== "draft") return state;
    if (state.durableThreads.some(({ id }) => id === target.id)) {
      throw new Error(`Accepted draft ID already exists as a durable chat thread: ${target.id}`);
    }
    const acceptedDraft: LocalChatDraft = {
      ...target,
      previewMode,
    };
    const { lifecycle: _lifecycle, titleSource: _titleSource, ...thread } = acceptedDraft;
    const detail: DurableChatThreadDetail = {
      ...thread,
      lifecycle: "detail",
      detailError: null,
    };
    const durableThreads = [...state.durableThreads, detail];
    return {
      ...state,
      durableThreads,
      draft: null,
      deferredDraftSummary: null,
      unconfirmedDraftRun: null,
      selection:
        state.selection.kind === "draft" && state.selection.draftId === detail.id
          ? { kind: "thread", threadId: detail.id }
          : state.selection,
      chatVisible:
        state.selection.kind === "draft" && state.selection.draftId === detail.id
          ? false
          : state.chatVisible,
      visibleTarget:
        state.selection.kind === "draft" && state.selection.draftId === detail.id
          ? null
          : state.visibleTarget,
      activeRun: {
        ...run,
        targetKind: "thread",
        phase: "accepted",
        deferredSummary: undefined,
      },
    };
  }

  if (target.lifecycle !== "detail") return state;
  const acceptedTarget: DurableChatThreadDetail = {
    ...target,
    previewMode,
  };
  const next = replaceLoadedChatWorkspaceTarget(state, acceptedTarget);
  return {
    ...next,
    activeRun: { ...run, phase: "accepted", deferredSummary: undefined },
  };
}

export function rollbackChatWorkspaceLifecycleRun(
  state: ChatWorkspaceLifecycleState,
  action: Extract<ChatWorkspaceLifecycleAction, { type: "run.rollback" }>,
): ChatWorkspaceLifecycleState {
  const run = matchingChatWorkspaceLifecycleRun(state, action);
  if (!run || run.phase !== "pending") return state;
  const target = getLoadedChatWorkspaceTarget(state, action.threadId);
  if (!target) return state;
  if (
    run.targetKind === "draft" &&
    target.lifecycle === "draft" &&
    state.deferredDraftSummary?.id === target.id
  ) {
    const recovered: DurableChatThreadSummary = {
      ...state.deferredDraftSummary,
      lifecycle: "summary",
    };
    return {
      ...state,
      durableThreads: [...state.durableThreads, recovered],
      draft: null,
      deferredDraftSummary: null,
      unconfirmedDraftRun: null,
      selection:
        state.selection.kind === "draft" && state.selection.draftId === target.id
          ? { kind: "thread", threadId: target.id }
          : state.selection,
      chatVisible:
        state.selection.kind === "draft" && state.selection.draftId === target.id
          ? false
          : state.chatVisible,
      visibleTarget:
        state.selection.kind === "draft" && state.selection.draftId === target.id
          ? null
          : state.visibleTarget,
      activeRun: null,
    };
  }
  const rollback = run.rollback;
  const messages = target.messages.filter(
    (message) =>
      message.id !== rollback.userMessageId && message.id !== rollback.assistantMessageId,
  );
  let rolledBack: LocalChatDraft | DurableChatThreadDetail;
  if (run.deferredSummary) {
    if (target.lifecycle !== "detail") return state;
    rolledBack = {
      ...run.deferredSummary,
      messages,
      lifecycle: "detail",
      detailError: target.detailError,
    };
  } else {
    rolledBack = {
      ...target,
      title: rollback.previousTitle,
      model: rollback.previousModel,
      messages,
      runStatus: rollback.previousRunStatus,
      updatedAt: rollback.previousUpdatedAt,
    };
  }
  const next = replaceLoadedChatWorkspaceTarget(state, rolledBack);
  const unconfirmedDraftRun =
    run.targetKind === "draft" && action.durability === "unknown"
      ? {
          threadId: run.threadId,
          clientRunId: run.clientRunId,
          userMessageId: run.rollback.userMessageId,
          assistantMessageId: run.assistantMessageId,
        }
      : state.unconfirmedDraftRun;
  return { ...next, activeRun: null, unconfirmedDraftRun };
}

export function updateChatWorkspaceLifecycleRunMessage(
  state: ChatWorkspaceLifecycleState,
  action: Extract<ChatWorkspaceLifecycleAction, { type: "run.message-update" }>,
): ChatWorkspaceLifecycleState {
  const run = matchingChatWorkspaceLifecycleRun(state, action);
  if (!run || run.phase !== "accepted") return state;
  const target = getLoadedChatWorkspaceTarget(state, action.threadId);
  if (!target) return state;
  const assistant = target.messages.find(
    (message) => message.id === action.assistantMessageId && message.role === "assistant",
  );
  if (!assistant || !messagePatchChanges(assistant, action.patch)) return state;
  const nextTarget = withChatWorkspaceActivity(
    state,
    {
      ...target,
      messages: target.messages.map((message) =>
        message.id === action.assistantMessageId
          ? { ...message, ...action.patch, updatedAt: action.at }
          : message,
      ),
    },
    action.at,
  );
  return replaceLoadedChatWorkspaceTarget(state, nextTarget);
}

export function finishChatWorkspaceLifecycleRun(
  state: ChatWorkspaceLifecycleState,
  action: Extract<ChatWorkspaceLifecycleAction, { type: "run.finish" }>,
): ChatWorkspaceLifecycleState {
  const run = matchingChatWorkspaceLifecycleRun(state, action);
  if (!run || run.phase !== "accepted") return state;
  const target = getLoadedDurableChatThread(state, action.threadId);
  if (!target) return state;
  const assistant = target.messages.find(
    (message) => message.id === action.assistantMessageId && message.role === "assistant",
  );
  if (!assistant) return state;
  const nextTarget = withChatWorkspaceActivity(
    state,
    {
      ...target,
      messages: target.messages.map((message) =>
        message.id === action.assistantMessageId
          ? finalizeAssistantMessage(message, action.outcome, action.error, action.at)
          : message,
      ),
      runStatus: action.outcome,
    },
    action.at,
  );
  const next = replaceLoadedChatWorkspaceTarget(state, nextTarget);
  return next === state ? state : { ...next, activeRun: null };
}

export function selectChatWelcome(
  state: ChatWorkspaceLifecycleState,
): ChatWorkspaceLifecycleState {
  return state.selection.kind === "welcome"
    ? state
    : {
        ...state,
        selection: WELCOME_SELECTION,
        chatVisible: false,
        visibleTarget: null,
      };
}

export function selectLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  draftId: string,
): ChatWorkspaceLifecycleState {
  if (state.draft?.id !== draftId) return state;
  if (state.selection.kind === "draft" && state.selection.draftId === state.draft.id) {
    return state;
  }
  return {
    ...state,
    selection: { kind: "draft", draftId: state.draft.id },
    chatVisible: false,
    visibleTarget: null,
  };
}

export function selectDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): ChatWorkspaceLifecycleState {
  if (!getDurableChatThread(state, threadId)) return state;
  if (state.selection.kind === "thread" && state.selection.threadId === threadId) return state;
  return {
    ...state,
    selection: { kind: "thread", threadId },
    chatVisible: false,
    visibleTarget: null,
  };
}

/**
 * Remove only durable state. The independently-owned local draft keeps the
 * same identity, even when the deleted thread had been selected.
 */
export function deleteDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): ChatWorkspaceLifecycleState {
  if (state.activeRun?.threadId === threadId) return state;
  if (getDurableChatThread(state, threadId)?.runStatus === "streaming") return state;
  const durableThreads = state.durableThreads.filter((thread) => thread.id !== threadId);
  if (durableThreads.length === state.durableThreads.length) return state;
  const selection =
    state.selection.kind === "thread" && state.selection.threadId === threadId
      ? WELCOME_SELECTION
      : state.selection;
  const selectionChanged = selection !== state.selection;
  return {
    ...state,
    durableThreads,
    selection,
    chatVisible: selectionChanged ? false : state.chatVisible,
    visibleTarget: selectionChanged ? null : state.visibleTarget,
  };
}

export function chatWorkspaceLifecycleReducer(
  state: ChatWorkspaceLifecycleState,
  action: ChatWorkspaceLifecycleAction,
): ChatWorkspaceLifecycleState {
  switch (action.type) {
    case "server.hydrated":
      return hydrateDurableChatThreads(state, action.summaries);
    case "thread.detail-loaded":
      return mergeDurableChatThreadDetail(state, action.thread);
    case "thread.summary-merge":
      return mergeDurableChatThreadSummary(state, action.thread);
    case "thread.reconciliation-failed":
      return recordDurableChatThreadDetailError(state, action.thread, action.error);
    case "thread.deleted":
      return deleteDurableChatThread(state, action.threadId);
    case "draft.set":
      return setLocalChatDraft(state, action.draft);
    case "draft.rename":
      return renameLocalChatDraft(state, action.draftId, action.title, action.at);
    case "draft.preview-mode-set":
      return setLocalChatDraftPreviewMode(
        state,
        action.draftId,
        action.previewMode,
        action.at,
      );
    case "draft.model-set":
      return setLocalChatDraftModel(state, action.draftId, action.model, action.at);
    case "draft.cleared":
      return clearLocalChatDraft(state, action.draftId);
    case "workspace.visibility-set":
      return setChatWorkspaceVisibility(state, action.target, action.at);
    case "selection.welcome":
      return selectChatWelcome(state);
    case "selection.draft":
      return selectLocalChatDraft(state, action.draftId);
    case "selection.thread":
      return selectDurableChatThread(state, action.threadId);
    case "thread.rename-confirmed":
      return confirmDurableChatThreadRename(
        state,
        action.threadId,
        action.title,
        action.updatedAt,
      );
    case "thread.read-state-confirmed":
      return confirmDurableChatThreadReadState(
        state,
        action.threadId,
        action.unread,
        action.lastReadAt,
      );
    case "run.start":
      return startChatWorkspaceLifecycleRun(state, action);
    case "run.accept":
      return acceptChatWorkspaceLifecycleRun(state, action);
    case "run.rollback":
      return rollbackChatWorkspaceLifecycleRun(state, action);
    case "run.message-update":
      return updateChatWorkspaceLifecycleRunMessage(state, action);
    case "run.finish":
      return finishChatWorkspaceLifecycleRun(state, action);
  }
}

function getLoadedChatWorkspaceTarget(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): LocalChatDraft | DurableChatThreadDetail | undefined {
  if (state.draft?.id === threadId) return state.draft;
  return getLoadedDurableChatThread(state, threadId);
}

function replaceLoadedChatWorkspaceTarget(
  state: ChatWorkspaceLifecycleState,
  target: LocalChatDraft | DurableChatThreadDetail,
): ChatWorkspaceLifecycleState {
  if (target.lifecycle === "draft") {
    if (state.draft?.id !== target.id) return state;
    return { ...state, draft: target };
  }
  if (!state.durableThreads.some((thread) => thread.id === target.id)) return state;
  return {
    ...state,
    durableThreads: state.durableThreads.map((thread) =>
      thread.id === target.id ? target : thread,
    ),
  };
}

function updateDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
  update: (thread: DurableChatThread) => DurableChatThread,
): ChatWorkspaceLifecycleState {
  const existing = getDurableChatThread(state, threadId);
  if (!existing) return state;
  const next = update(existing);
  if (next === existing) return state;
  return {
    ...state,
    durableThreads: state.durableThreads.map((thread) =>
      thread.id === threadId ? next : thread,
    ),
  };
}

function withChatWorkspaceActivity<T extends LocalChatDraft | DurableChatThreadDetail>(
  state: ChatWorkspaceLifecycleState,
  target: T,
  at: string,
): T {
  if (target.lifecycle === "draft") return { ...target, updatedAt: at };
  const visible = getVisibleDurableChatThreadId(state) === target.id;
  return {
    ...target,
    updatedAt: at,
    unread: !visible,
    lastReadAt: visible ? at : target.lastReadAt,
  };
}

function matchingChatWorkspaceLifecycleRun(
  state: ChatWorkspaceLifecycleState,
  action: { clientRunId: string; threadId: string; assistantMessageId: string },
): ChatWorkspaceLifecycleRun | undefined {
  const run = state.activeRun;
  return run?.clientRunId === action.clientRunId &&
    run.threadId === action.threadId &&
    run.assistantMessageId === action.assistantMessageId
    ? run
    : undefined;
}

function assertUniqueThreadIds(threads: readonly Pick<ChatThreadSummary, "id">[]): void {
  const ids = new Set<string>();
  for (const thread of threads) {
    if (ids.has(thread.id)) throw new Error(`Duplicate durable chat thread ID: ${thread.id}`);
    ids.add(thread.id);
  }
}

function assertNoDraftDurableIdCollision(
  draft: Pick<LocalChatDraft, "id"> | null,
  durableThreads: readonly Pick<ChatThreadSummary, "id">[],
): void {
  if (draft && durableThreads.some((thread) => thread.id === draft.id)) {
    throw new Error(`Local draft ID collides with durable chat thread ID: ${draft.id}`);
  }
}

function messagePatchChanges(
  message: ChatMessage,
  patch: Partial<Pick<ChatMessage, "content" | "toolCalls" | "error">>,
): boolean {
  if ("content" in patch && patch.content !== message.content) return true;
  if ("error" in patch && patch.error !== message.error) return true;
  if ("toolCalls" in patch && !jsonValuesEqual(patch.toolCalls, message.toolCalls)) return true;
  return false;
}

function chatModelsEqual(
  left: ChatModelSnapshot | null,
  right: ChatModelSnapshot | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.id === right.id &&
      left.displayName === right.displayName &&
      left.provider === right.provider)
  );
}

function durableChatThreadsEqual(
  left: DurableChatThread,
  right: DurableChatThread,
): boolean {
  return jsonValuesEqual(left, right);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function visibleTargetMatchesSelection(
  target: ChatWorkspaceVisibleTarget,
  selection: ChatWorkspaceSelection,
): boolean {
  return (
    (target.kind === "draft" &&
      selection.kind === "draft" &&
      target.draftId === selection.draftId) ||
    (target.kind === "thread" &&
      selection.kind === "thread" &&
      target.threadId === selection.threadId)
  );
}

function visibleTargetsEqual(
  left: ChatWorkspaceVisibleTarget | null,
  right: ChatWorkspaceVisibleTarget,
): boolean {
  return left !== null && visibleTargetMatchesSelection(left, right);
}

function finalizeAssistantMessage(
  message: ChatMessage,
  outcome: Exclude<ChatRunStatus, "idle" | "streaming">,
  error: string | undefined,
  at: string,
): ChatMessage {
  const toolStatus = outcome === "complete" ? "completed" : "error";
  const fallbackError =
    outcome === "interrupted"
      ? "Response stopped before completion."
      : outcome === "error"
        ? "The response failed before completion."
        : undefined;
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) =>
      toolCall.status === "running" ? { ...toolCall, status: toolStatus } : toolCall,
    ),
    error: error ?? message.error ?? fallbackError,
    updatedAt: at,
  };
}
