import {
  createChatThread,
  type ActiveChatRun,
  type ChatThread,
  type ChatThreadSummary,
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
};

export type ChatWorkspaceSelection =
  | { kind: "welcome" }
  | { kind: "draft" }
  | { kind: "thread"; threadId: string };

export interface ChatWorkspaceLifecycleState {
  durableThreads: readonly DurableChatThread[];
  draft: LocalChatDraft | null;
  selection: ChatWorkspaceSelection;
  activeRun: ActiveChatRun | null;
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
  | { type: "draft.cleared" }
  | { type: "selection.welcome" }
  | { type: "selection.draft" }
  | { type: "selection.thread"; threadId: string }
  | { type: "run.set"; run: ActiveChatRun | null };

const WELCOME_SELECTION: ChatWorkspaceSelection = { kind: "welcome" };

/** Start with no implicit draft and no implicit durable selection. */
export function createChatWorkspaceLifecycleState(): ChatWorkspaceLifecycleState {
  return {
    durableThreads: [],
    draft: null,
    selection: WELCOME_SELECTION,
    activeRun: null,
  };
}

/** Draft creation is the only operation that assigns the draft lifecycle. */
export function createLocalChatDraft(options: CreateChatThreadOptions): LocalChatDraft {
  return { ...createChatThread(options), lifecycle: "draft" };
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
    return state.draft ? { kind: "draft", draft: state.draft } : { kind: "welcome" };
  }
  if (state.selection.kind === "thread") {
    const thread = getDurableChatThread(state, state.selection.threadId);
    return thread ? { kind: "thread", thread } : { kind: "welcome" };
  }
  return { kind: "welcome" };
}

/**
 * Replace the durable list with the authoritative server snapshot. Loaded
 * transcripts survive for matching IDs while every summary field is refreshed.
 */
export function hydrateDurableChatThreads(
  state: ChatWorkspaceLifecycleState,
  summaries: readonly ChatThreadSummary[],
): ChatWorkspaceLifecycleState {
  assertUniqueThreadIds(summaries);
  assertNoDraftDurableIdCollision(state.draft, summaries);
  const existingById = new Map(state.durableThreads.map((thread) => [thread.id, thread]));
  const durableThreads = summaries.map<DurableChatThread>((summary) => {
    const existing = existingById.get(summary.id);
    if (existing?.lifecycle === "detail") {
      return {
        ...summary,
        messages: existing.messages,
        lifecycle: "detail",
      };
    }
    return { ...summary, lifecycle: "summary" };
  });
  const durableIds = new Set(durableThreads.map((thread) => thread.id));
  const selection =
    state.selection.kind === "thread" && !durableIds.has(state.selection.threadId)
      ? WELCOME_SELECTION
      : state.selection;

  return { ...state, durableThreads, selection };
}

/**
 * Enrich an existing durable summary with server detail. Unknown IDs are
 * ignored so a delayed detail response cannot resurrect a deleted thread.
 */
export function mergeDurableChatThreadDetail(
  state: ChatWorkspaceLifecycleState,
  thread: ChatThread,
): ChatWorkspaceLifecycleState {
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
  return state.draft === draft ? state : { ...state, draft };
}

export function clearLocalChatDraft(
  state: ChatWorkspaceLifecycleState,
): ChatWorkspaceLifecycleState {
  if (!state.draft) return state;
  return {
    ...state,
    draft: null,
    selection: state.selection.kind === "draft" ? WELCOME_SELECTION : state.selection,
  };
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
): ChatWorkspaceLifecycleState {
  if (!state.draft || state.selection.kind === "draft") return state;
  return { ...state, selection: { kind: "draft" } };
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
  const durableThreads = state.durableThreads.filter((thread) => thread.id !== threadId);
  if (durableThreads.length === state.durableThreads.length) return state;
  const selection =
    state.selection.kind === "thread" && state.selection.threadId === threadId
      ? WELCOME_SELECTION
      : state.selection;
  return { ...state, durableThreads, selection };
}

export function setActiveChatRun(
  state: ChatWorkspaceLifecycleState,
  run: ActiveChatRun | null,
): ChatWorkspaceLifecycleState {
  if (run) {
    const targetExists =
      state.draft?.id === run.threadId || getDurableChatThread(state, run.threadId) !== undefined;
    if (!targetExists) return state;
  }
  return state.activeRun === run ? state : { ...state, activeRun: run };
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
    case "draft.cleared":
      return clearLocalChatDraft(state);
    case "selection.welcome":
      return selectChatWelcome(state);
    case "selection.draft":
      return selectLocalChatDraft(state);
    case "selection.thread":
      return selectDurableChatThread(state, action.threadId);
    case "run.set":
      return setActiveChatRun(state, action.run);
  }
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
