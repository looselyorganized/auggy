import { describe, expect, it } from "bun:test";
import {
  chatWorkspaceLifecycleReducer,
  clearLocalChatDraft,
  createChatWorkspaceLifecycleState,
  createLocalChatDraft,
  deleteDurableChatThread,
  getDurableChatThread,
  getLoadedDurableChatThread,
  getSelectedChatWorkspaceTarget,
  hydrateDurableChatThreads,
  mergeDurableChatThreadDetail,
  selectDurableChatThread,
  selectLocalChatDraft,
  setActiveChatRun,
  setLocalChatDraft,
} from "./chat-workspace-state";
import {
  createChatThread,
  type ActiveChatRun,
  type ChatMessage,
  type ChatThread,
  type ChatThreadSummary,
} from "./chat-workspace";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T10:01:00.000Z";

function summary(id: string, title = id, updatedAt = T0): ChatThreadSummary {
  const { messages: _messages, ...value } = createChatThread({
    id,
    title,
    previewMode: "creator",
    now: T0,
  });
  return { ...value, updatedAt };
}

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: T0,
    updatedAt: T0,
  };
}

function detail(id: string, title = id, messages = [message(`${id}-message`, "hello")]): ChatThread {
  return { ...summary(id, title), messages };
}

describe("explicit chat workspace lifecycle state", () => {
  it("starts at welcome with no implicit draft, durable thread, or run", () => {
    const state = createChatWorkspaceLifecycleState();

    expect(state).toEqual({
      durableThreads: [],
      draft: null,
      selection: { kind: "welcome" },
      activeRun: null,
    });
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "welcome" });
  });

  it("keeps draft creation and draft selection explicit across hydration", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "anonymous", now: T0 });
    let state = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);

    expect(state.selection).toEqual({ kind: "welcome" });
    state = hydrateDurableChatThreads(state, [summary("saved")]);
    expect(state.draft).toBe(draft);
    expect(state.selection).toEqual({ kind: "welcome" });

    state = selectLocalChatDraft(state);
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "draft", draft });

    state = hydrateDurableChatThreads(state, [summary("saved", "Refreshed", T1)]);
    expect(state.draft).toBe(draft);
    expect(state.selection).toEqual({ kind: "draft" });
  });

  it("replaces the durable list while preserving loaded transcripts and refreshing metadata", () => {
    const transcript = [message("message-1", "preserve me")];
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("loaded", "Old title"),
      summary("removed"),
    ]);
    state = mergeDurableChatThreadDetail(state, detail("loaded", "Old title", transcript));
    state = hydrateDurableChatThreads(state, [summary("loaded", "Server title", T1)]);

    expect(state.durableThreads.map(({ id }) => id)).toEqual(["loaded"]);
    expect(getLoadedDurableChatThread(state, "loaded")).toMatchObject({
      lifecycle: "detail",
      title: "Server title",
      updatedAt: T1,
    });
    expect(getLoadedDurableChatThread(state, "loaded")?.messages).toBe(transcript);
  });

  it("never infers draft lifecycle from an empty durable transcript", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("empty-durable", "New chat"),
    ]);
    state = mergeDurableChatThreadDetail(state, detail("empty-durable", "New chat", []));
    state = hydrateDurableChatThreads(state, [summary("empty-durable", "Still durable", T1)]);

    expect(state.draft).toBeNull();
    expect(getDurableChatThread(state, "empty-durable")).toMatchObject({
      lifecycle: "detail",
      title: "Still durable",
      messages: [],
    });
  });

  it("falls back to welcome when hydration removes a selection, never to the existing draft", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 });
    let state = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);
    state = hydrateDurableChatThreads(state, [summary("selected")]);
    state = selectDurableChatThread(state, "selected");
    state = hydrateDurableChatThreads(state, []);

    expect(state.selection).toEqual({ kind: "welcome" });
    expect(state.draft).toBe(draft);
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "welcome" });
  });

  it("deletes durable state without changing draft identity", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "visitor", now: T0 });
    let state = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);
    state = hydrateDurableChatThreads(state, [summary("delete-me"), summary("keep-me")]);
    state = selectDurableChatThread(state, "delete-me");
    state = deleteDurableChatThread(state, "delete-me");

    expect(state.durableThreads.map(({ id }) => id)).toEqual(["keep-me"]);
    expect(state.draft).toBe(draft);
    expect(state.selection).toEqual({ kind: "welcome" });

    state = selectLocalChatDraft(state);
    const afterOtherDelete = deleteDurableChatThread(state, "keep-me");
    expect(afterOtherDelete.draft).toBe(draft);
    expect(afterOtherDelete.selection).toEqual({ kind: "draft" });
  });

  it("does not resurrect a deleted thread from delayed detail", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [summary("gone")]);
    state = deleteDurableChatThread(state, "gone");

    const afterLateDetail = mergeDurableChatThreadDetail(state, detail("gone"));
    expect(afterLateDetail).toBe(state);
    expect(afterLateDetail.durableThreads).toEqual([]);
  });

  it("keeps an active run explicit and blocks deletion of its durable owner", () => {
    const run: ActiveChatRun = {
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "assistant-1",
    };
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("running"),
    ]);
    state = setActiveChatRun(state, run);

    expect(state.activeRun).toBe(run);
    expect(deleteDurableChatThread(state, "running")).toBe(state);
    expect(setActiveChatRun(state, null).activeRun).toBeNull();
  });

  it("exposes the same invariants through reducer actions", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 });
    let state = chatWorkspaceLifecycleReducer(createChatWorkspaceLifecycleState(), {
      type: "draft.set",
      draft,
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "server.hydrated",
      summaries: [summary("saved")],
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "selection.thread",
      threadId: "saved",
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "thread.detail-loaded",
      thread: detail("saved"),
    });

    expect(getSelectedChatWorkspaceTarget(state)).toMatchObject({
      kind: "thread",
      thread: { id: "saved", lifecycle: "detail" },
    });

    state = chatWorkspaceLifecycleReducer(state, { type: "thread.deleted", threadId: "saved" });
    state = chatWorkspaceLifecycleReducer(state, { type: "selection.draft" });
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "draft", draft });

    state = clearLocalChatDraft(state);
    expect(state.selection).toEqual({ kind: "welcome" });
  });

  it("rejects duplicate server IDs rather than creating ambiguous durable identity", () => {
    expect(() =>
      hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
        summary("duplicate"),
        summary("duplicate"),
      ]),
    ).toThrow("Duplicate durable chat thread ID: duplicate");
  });

  it("rejects assigning a draft whose ID is already durable", () => {
    const state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("collision"),
    ]);
    const draft = createLocalChatDraft({
      id: "collision",
      previewMode: "creator",
      now: T0,
    });

    expect(() => setLocalChatDraft(state, draft)).toThrow(
      "Local draft ID collides with durable chat thread ID: collision",
    );
  });

  it("rejects hydration that collides with the current local draft", () => {
    const draft = createLocalChatDraft({
      id: "collision",
      previewMode: "creator",
      now: T0,
    });
    const state = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);

    expect(() => hydrateDurableChatThreads(state, [summary("collision")])).toThrow(
      "Local draft ID collides with durable chat thread ID: collision",
    );
    expect(state.draft).toBe(draft);
    expect(state.durableThreads).toEqual([]);
  });
});
