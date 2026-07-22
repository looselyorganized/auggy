import {
  createChatThread,
  deriveChatThreadTitle,
  validateRenamedChatThreadTitle,
  type ChatThread,
  type ChatThreadSummary,
  type ChatMessage,
  type ChatModelSnapshot,
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

export interface ChatWorkspaceLifecycleState {
  durableThreads: readonly DurableChatThread[];
  draft: LocalChatDraft | null;
  /** Server durability observed before the matching POST response was accepted locally. */
  deferredDraftSummary: ChatThreadSummary | null;
  selection: ChatWorkspaceSelection;
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
  | { type: "thread.deleted"; threadId: string }
  | { type: "draft.set"; draft: LocalChatDraft }
  | { type: "draft.rename"; title: string; at: string }
  | { type: "draft.cleared" }
  | { type: "selection.welcome" }
  | { type: "selection.draft"; draftId: string }
  | { type: "selection.thread"; threadId: string }
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
    };

const WELCOME_SELECTION: ChatWorkspaceSelection = { kind: "welcome" };

/** Start with no implicit draft and no implicit durable selection. */
export function createChatWorkspaceLifecycleState(): ChatWorkspaceLifecycleState {
  return {
    durableThreads: [],
    draft: null,
    deferredDraftSummary: null,
    selection: WELCOME_SELECTION,
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
  durableThreads[index] = { ...thread, lifecycle: "detail" };
  return { ...state, durableThreads };
}

/** Add or replace the local draft without changing the current selection. */
export function setLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  draft: LocalChatDraft,
): ChatWorkspaceLifecycleState {
  assertNoDraftDurableIdCollision(draft, state.durableThreads);
  if (state.activeRun?.targetKind === "draft") return state;
  if (state.draft === draft) return state;
  return {
    ...state,
    draft,
    deferredDraftSummary: null,
    selection:
      state.selection.kind === "draft" && state.selection.draftId !== draft.id
        ? WELCOME_SELECTION
        : state.selection,
  };
}

export function clearLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
): ChatWorkspaceLifecycleState {
  if (state.activeRun?.targetKind === "draft") return state;
  if (!state.draft) return state;
  return {
    ...state,
    draft: null,
    deferredDraftSummary: null,
    selection: state.selection.kind === "draft" ? WELCOME_SELECTION : state.selection,
  };
}

export function renameLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  title: string,
  at: string,
): ChatWorkspaceLifecycleState {
  const validation = validateRenamedChatThreadTitle(title);
  if (!state.draft || !validation.valid || state.activeRun?.targetKind === "draft") return state;
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
    const detail: DurableChatThreadDetail = { ...thread, lifecycle: "detail" };
    const durableThreads = [...state.durableThreads, detail];
    return {
      ...state,
      durableThreads,
      draft: null,
      deferredDraftSummary: null,
      selection:
        state.selection.kind === "draft" && state.selection.draftId === detail.id
          ? { kind: "thread", threadId: detail.id }
          : state.selection,
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
      selection:
        state.selection.kind === "draft" && state.selection.draftId === target.id
          ? { kind: "thread", threadId: target.id }
          : state.selection,
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
    rolledBack = { ...run.deferredSummary, messages, lifecycle: "detail" };
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
  return { ...next, activeRun: null };
}

export function selectChatWelcome(
  state: ChatWorkspaceLifecycleState,
): ChatWorkspaceLifecycleState {
  return state.selection.kind === "welcome"
    ? state
    : { ...state, selection: WELCOME_SELECTION };
}

export function selectLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
  draftId: string,
): ChatWorkspaceLifecycleState {
  if (state.draft?.id !== draftId) return state;
  if (state.selection.kind === "draft" && state.selection.draftId === state.draft.id) {
    return state;
  }
  return { ...state, selection: { kind: "draft", draftId: state.draft.id } };
}

export function selectDurableChatThread(
  state: ChatWorkspaceLifecycleState,
  threadId: string,
): ChatWorkspaceLifecycleState {
  if (!getDurableChatThread(state, threadId)) return state;
  if (state.selection.kind === "thread" && state.selection.threadId === threadId) return state;
  return { ...state, selection: { kind: "thread", threadId } };
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
  return { ...state, durableThreads, selection };
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
    case "thread.deleted":
      return deleteDurableChatThread(state, action.threadId);
    case "draft.set":
      return setLocalChatDraft(state, action.draft);
    case "draft.rename":
      return renameLocalChatDraft(state, action.title, action.at);
    case "draft.cleared":
      return clearLocalChatDraft(state);
    case "selection.welcome":
      return selectChatWelcome(state);
    case "selection.draft":
      return selectLocalChatDraft(state, action.draftId);
    case "selection.thread":
      return selectDurableChatThread(state, action.threadId);
    case "run.start":
      return startChatWorkspaceLifecycleRun(state, action);
    case "run.accept":
      return acceptChatWorkspaceLifecycleRun(state, action);
    case "run.rollback":
      return rollbackChatWorkspaceLifecycleRun(state, action);
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
