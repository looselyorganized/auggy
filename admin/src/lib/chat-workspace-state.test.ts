import { describe, expect, it } from "bun:test";
import {
  canStartChatWorkspaceLifecycleRun,
  chatWorkspaceLifecycleReducer,
  clearLocalChatDraft,
  clearLocalChatDraftAfterConfirmedServerDeletion,
  createChatWorkspaceLifecycleState,
  createLocalChatDraft,
  deleteDurableChatThread,
  getChatWorkspaceTargetById,
  getDurableChatThread,
  getLoadedDurableChatThread,
  getSelectedChatWorkspaceId,
  getSelectedRenderableChatWorkspaceThread,
  getSelectedChatWorkspaceTarget,
  getVisibleDurableChatThreadId,
  hasChatWorkspaceUserMessages,
  hasDurableChatThread,
  hydrateDurableChatThreads,
  mergeDurableChatThreadDetail,
  selectDurableChatThread,
  selectLocalChatDraft,
  setLocalChatDraft,
} from "./chat-workspace-state";
import {
  createChatThread,
  type ChatMessage,
  type ChatModelSnapshot,
  type ChatThread,
  type ChatThreadSummary,
} from "./chat-workspace";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T10:01:00.000Z";
const T2 = "2026-07-22T10:02:00.000Z";
const MODEL: ChatModelSnapshot = {
  id: "test-model",
  displayName: "Test model",
  provider: "test",
};

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

function startRun(
  state: ReturnType<typeof createChatWorkspaceLifecycleState>,
  threadId: string,
  title?: string,
) {
  return chatWorkspaceLifecycleReducer(state, {
    type: "run.start",
    clientRunId: "run-1",
    threadId,
    title,
    userMessage: message("user-1", "Review my agent"),
    assistantMessage: {
      ...message("assistant-1", ""),
      role: "assistant",
    },
    model: MODEL,
    at: T1,
  });
}

function acceptRun(
  state: ReturnType<typeof createChatWorkspaceLifecycleState>,
  threadId: string,
) {
  return chatWorkspaceLifecycleReducer(state, {
    type: "run.accept",
    clientRunId: "run-1",
    threadId,
    assistantMessageId: "assistant-1",
  });
}

function acceptedDurableRun(threadId = "running") {
  let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
    summary(threadId),
  ]);
  state = mergeDurableChatThreadDetail(state, detail(threadId, threadId, []));
  state = startRun(state, threadId);
  return acceptRun(state, threadId);
}

describe("explicit chat workspace lifecycle state", () => {
  it("starts at welcome with no implicit draft, durable thread, or run", () => {
    const state = createChatWorkspaceLifecycleState();

    expect(state).toEqual({
      durableThreads: [],
      draft: null,
      deferredDraftSummary: null,
      unconfirmedDraftRun: null,
      selection: { kind: "welcome" },
      chatVisible: false,
      visibleTarget: null,
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

    state = selectLocalChatDraft(state, "draft");
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "draft", draft });

    state = hydrateDurableChatThreads(state, [summary("saved", "Refreshed", T1)]);
    expect(state.draft).toBe(draft);
    expect(state.selection).toEqual({ kind: "draft", draftId: "draft" });
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

    state = selectLocalChatDraft(state, "draft");
    const afterOtherDelete = deleteDurableChatThread(state, "keep-me");
    expect(afterOtherDelete.draft).toBe(draft);
    expect(afterOtherDelete.selection).toEqual({ kind: "draft", draftId: "draft" });
  });

  it("discards a confirmed-local selected draft atomically to welcome", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    state = selectLocalChatDraft(state, "draft");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "draft", draftId: "draft" },
      at: T1,
    });

    state = clearLocalChatDraft(state, "draft");

    expect(state).toMatchObject({
      draft: null,
      deferredDraftSummary: null,
      unconfirmedDraftRun: null,
      selection: { kind: "welcome" },
      chatVisible: false,
      visibleTarget: null,
    });
  });

  it("preserves an ambiguously durable draft until server deletion is confirmed", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    state = selectLocalChatDraft(state, "draft");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "draft", draftId: "draft" },
      at: T1,
    });
    state = startRun(state, "draft");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
      durability: "unknown",
    });

    expect(state.unconfirmedDraftRun?.threadId).toBe("draft");
    expect(clearLocalChatDraft(state, "draft")).toBe(state);
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "draft.cleared",
        draftId: "draft",
      }),
    ).toBe(state);

    const confirmed = clearLocalChatDraftAfterConfirmedServerDeletion(state, "draft");
    expect(confirmed).toMatchObject({
      draft: null,
      unconfirmedDraftRun: null,
      selection: { kind: "welcome" },
      chatVisible: false,
      visibleTarget: null,
    });
  });

  it("deletes the selected durable thread to welcome without an MRU fallback", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 });
    let state = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);
    state = hydrateDurableChatThreads(state, [
      summary("selected", "Selected", T0),
      summary("newest", "Newest", T2),
      summary("older", "Older", T1),
    ]);
    state = selectDurableChatThread(state, "selected");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "selected" },
      at: T2,
    });

    state = deleteDurableChatThread(state, "selected");

    expect(state.durableThreads.map(({ id }) => id)).toEqual(["newest", "older"]);
    expect(state.draft).toBe(draft);
    expect(state.selection).toEqual({ kind: "welcome" });
    expect(state.chatVisible).toBeFalse();
    expect(state.visibleTarget).toBeNull();
  });

  it("preserves exact draft and other durable selections when deleting in the background", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 });
    let draftSelected = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);
    draftSelected = hydrateDurableChatThreads(draftSelected, [summary("background")]);
    draftSelected = selectLocalChatDraft(draftSelected, "draft");
    draftSelected = chatWorkspaceLifecycleReducer(draftSelected, {
      type: "workspace.visibility-set",
      target: { kind: "draft", draftId: "draft" },
      at: T1,
    });
    const afterDraftBackgroundDelete = deleteDurableChatThread(draftSelected, "background");
    expect(afterDraftBackgroundDelete.selection).toBe(draftSelected.selection);
    expect(afterDraftBackgroundDelete.visibleTarget).toBe(draftSelected.visibleTarget);
    expect(afterDraftBackgroundDelete.chatVisible).toBeTrue();

    let durableSelected = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("selected"),
      summary("background"),
    ]);
    durableSelected = selectDurableChatThread(durableSelected, "selected");
    durableSelected = chatWorkspaceLifecycleReducer(durableSelected, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "selected" },
      at: T1,
    });
    const afterDurableBackgroundDelete = deleteDurableChatThread(durableSelected, "background");
    expect(afterDurableBackgroundDelete.selection).toBe(durableSelected.selection);
    expect(afterDurableBackgroundDelete.visibleTarget).toBe(durableSelected.visibleTarget);
    expect(afterDurableBackgroundDelete.chatVisible).toBeTrue();
  });

  it("does not resurrect a deleted thread from delayed detail", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [summary("gone")]);
    state = deleteDurableChatThread(state, "gone");

    const afterLateDetail = mergeDurableChatThreadDetail(state, detail("gone"));
    expect(afterLateDetail).toBe(state);
    expect(afterLateDetail.durableThreads).toEqual([]);
  });

  it("keeps an active run explicit and blocks deletion of its durable owner", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("running"),
    ]);
    state = mergeDurableChatThreadDetail(state, detail("running", "Running", []));
    state = startRun(state, "running");

    expect(state.activeRun).toMatchObject({
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "assistant-1",
      phase: "pending",
      targetKind: "thread",
    });
    expect(deleteDurableChatThread(state, "running")).toBe(state);
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "assistant-1",
    });
    expect(state.activeRun).toBeNull();
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
    state = chatWorkspaceLifecycleReducer(state, {
      type: "selection.draft",
      draftId: "draft",
    });
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "draft", draft });

    state = clearLocalChatDraft(state, "draft");
    expect(state.selection).toEqual({ kind: "welcome" });
  });

  it("promotes an accepted draft atomically and defers its racing server summary", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "anonymous", now: T0 }),
    );
    state = selectLocalChatDraft(state, "draft");
    state = startRun(state, "draft");

    expect(state.draft).toMatchObject({
      id: "draft",
      lifecycle: "draft",
      title: "Review my agent",
      titleSource: "default",
      runStatus: "streaming",
    });
    expect(state.draft?.messages.map(({ id }) => id)).toEqual(["user-1", "assistant-1"]);
    expect(state.durableThreads).toEqual([]);

    const whilePending = hydrateDurableChatThreads(state, [
      { ...summary("draft", "Server saw it", T1), runStatus: "streaming" },
    ]);
    expect(whilePending.draft?.id).toBe("draft");
    expect(whilePending.durableThreads).toEqual([]);

    const accepted = chatWorkspaceLifecycleReducer(whilePending, {
      type: "run.accept",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
      promoteToVisitor: true,
    });
    expect(accepted.draft).toBeNull();
    expect(accepted.selection).toEqual({ kind: "thread", threadId: "draft" });
    expect(accepted.activeRun).toMatchObject({ phase: "accepted", targetKind: "thread" });
    expect(accepted.durableThreads).toHaveLength(1);
    expect(getLoadedDurableChatThread(accepted, "draft")).toMatchObject({
      lifecycle: "detail",
      previewMode: "visitor",
      title: "Review my agent",
      runStatus: "streaming",
    });
    expect(getLoadedDurableChatThread(accepted, "draft")?.messages).toHaveLength(2);

    expect(
      chatWorkspaceLifecycleReducer(accepted, {
        type: "run.accept",
        clientRunId: "run-1",
        threadId: "draft",
        assistantMessageId: "assistant-1",
      }),
    ).toBe(accepted);
    expect(
      chatWorkspaceLifecycleReducer(accepted, {
        type: "run.rollback",
        clientRunId: "run-1",
        threadId: "draft",
        assistantMessageId: "assistant-1",
      }),
    ).toBe(accepted);
  });

  it("preserves an explicit draft title through start, rejection, and acceptance", () => {
    const initialDraft = createLocalChatDraft({
      id: "draft",
      previewMode: "creator",
      now: T0,
    });
    let state = setLocalChatDraft(createChatWorkspaceLifecycleState(), initialDraft);
    state = chatWorkspaceLifecycleReducer(state, {
      type: "draft.rename",
      draftId: "draft",
      title: "  Deliberate title  ",
      at: T1,
    });
    expect(state.draft).toMatchObject({ title: "Deliberate title", titleSource: "explicit" });

    const pending = startRun(state, "draft", "Conflicting generated title");
    expect(pending.draft?.title).toBe("Deliberate title");
    const rejected = chatWorkspaceLifecycleReducer(pending, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
    });
    expect(rejected.draft).toMatchObject({
      title: "Deliberate title",
      titleSource: "explicit",
      messages: [],
      runStatus: "idle",
    });

    const retried = startRun(rejected, "draft");
    const accepted = chatWorkspaceLifecycleReducer(retried, {
      type: "run.accept",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
    });
    expect(getLoadedDurableChatThread(accepted, "draft")?.title).toBe("Deliberate title");
  });

  it("constrains accepted identity promotion to anonymous drafts", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    state = startRun(state, "draft");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.accept",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
      promoteToVisitor: true,
    });

    expect(getLoadedDurableChatThread(state, "draft")?.previewMode).toBe("creator");
  });

  it("restores a default draft exactly when the request is rejected before acceptance", () => {
    const original = createLocalChatDraft({
      id: "draft",
      previewMode: "creator",
      model: null,
      now: T0,
    });
    const pending = startRun(
      setLocalChatDraft(createChatWorkspaceLifecycleState(), original),
      "draft",
    );
    const rejected = chatWorkspaceLifecycleReducer(pending, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
    });

    expect(rejected.draft).toEqual(original);
    expect(rejected.durableThreads).toEqual([]);
    expect(rejected.activeRun).toBeNull();
  });

  it("starts a loaded empty durable thread but rejects a summary-only thread", () => {
    let summaryOnly = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("empty"),
    ]);
    expect(startRun(summaryOnly, "empty")).toBe(summaryOnly);

    summaryOnly = mergeDurableChatThreadDetail(
      summaryOnly,
      detail("empty", "Explicit durable title", []),
    );
    const pending = startRun(summaryOnly, "empty", "Conflicting generated title");
    expect(pending).not.toBe(summaryOnly);
    expect(getLoadedDurableChatThread(pending, "empty")).toMatchObject({
      lifecycle: "detail",
      messages: [{ id: "user-1" }, { id: "assistant-1" }],
      runStatus: "streaming",
      title: "Explicit durable title",
    });
    expect(pending.draft).toBeNull();
  });

  it("rolls back only run-owned fields and preserves newer server metadata", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("saved", "Old title"),
    ]);
    state = mergeDurableChatThreadDetail(state, detail("saved", "Old title", []));
    state = startRun(state, "saved", "Optimistic title");
    state = hydrateDurableChatThreads(state, [
      {
        ...summary("saved", "Server title", T2),
        unread: true,
        lastReadAt: null,
        runStatus: "idle",
      },
    ]);
    const rolledBack = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "saved",
      assistantMessageId: "assistant-1",
    });

    expect(getLoadedDurableChatThread(rolledBack, "saved")).toMatchObject({
      title: "Server title",
      model: null,
      unread: true,
      lastReadAt: null,
      runStatus: "idle",
      updatedAt: T2,
      messages: [],
    });
    expect(rolledBack.activeRun).toBeNull();
  });

  it("preserves newer metadata even when its values equal the optimistic fields", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("saved", "Old title"),
    ]);
    state = mergeDurableChatThreadDetail(state, detail("saved", "Old title", []));
    state = startRun(state, "saved", "Ignored for durable");
    state = hydrateDurableChatThreads(state, [
      {
        ...summary("saved", "Old title", T2),
        model: MODEL,
        runStatus: "idle",
      },
    ]);
    const rolledBack = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "saved",
      assistantMessageId: "assistant-1",
    });

    expect(getLoadedDurableChatThread(rolledBack, "saved")).toMatchObject({
      title: "Old title",
      model: MODEL,
      updatedAt: T2,
      messages: [],
    });
  });

  it("preserves a locally owned stream against stale summary and detail responses", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("saved", "Saved", T2),
    ]);
    state = mergeDurableChatThreadDetail(state, {
      ...detail("saved", "Saved", []),
      updatedAt: T2,
    });
    state = startRun(state, "saved");

    // Server and client clocks are not causal: this pre-run summary has a
    // later wall-clock timestamp than the local optimistic start.
    const afterSummary = hydrateDurableChatThreads(state, [summary("saved", "Stale", T2)]);
    expect(getLoadedDurableChatThread(afterSummary, "saved")).toMatchObject({
      title: "Saved",
      runStatus: "streaming",
      messages: [{ id: "user-1" }, { id: "assistant-1" }],
    });
    expect(mergeDurableChatThreadDetail(afterSummary, detail("saved", "Stale", []))).toBe(
      afterSummary,
    );
  });

  it("recovers observed server durability when the matching HTTP response is lost", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    state = selectLocalChatDraft(state, "draft");
    state = startRun(state, "draft");
    state = hydrateDurableChatThreads(state, [
      { ...summary("draft", "Durable", T2), runStatus: "streaming" },
    ]);
    expect(state.deferredDraftSummary?.id).toBe("draft");

    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
    });
    expect(state.draft).toBeNull();
    expect(state.activeRun).toBeNull();
    expect(state.selection).toEqual({ kind: "thread", threadId: "draft" });
    expect(getDurableChatThread(state, "draft")).toMatchObject({
      lifecycle: "summary",
      title: "Durable",
    });

    const repeated = hydrateDurableChatThreads(state, [summary("draft", "Durable", T2)]);
    expect(repeated.durableThreads).toHaveLength(1);
  });

  it("recovers durability observed only after an ambiguous draft rollback", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    state = selectLocalChatDraft(state, "draft");
    state = startRun(state, "draft");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
      durability: "unknown",
    });

    expect(state.draft?.id).toBe("draft");
    expect(state.unconfirmedDraftRun).toMatchObject({
      threadId: "draft",
      clientRunId: "run-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
    });

    state = setLocalChatDraft(
      state,
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T1 }),
    );
    expect(state.unconfirmedDraftRun?.clientRunId).toBe("run-1");

    state = hydrateDurableChatThreads(state, [summary("draft", "Recovered", T2)]);
    expect(state.draft).toBeNull();
    expect(state.unconfirmedDraftRun).toBeNull();
    expect(state.selection).toEqual({ kind: "thread", threadId: "draft" });
    expect(getDurableChatThread(state, "draft")).toMatchObject({
      lifecycle: "summary",
      title: "Recovered",
    });
  });

  it("binds draft selection to its exact identity", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "first", previewMode: "creator", now: T0 }),
    );
    state = selectLocalChatDraft(state, "first");
    state = setLocalChatDraft(
      state,
      createLocalChatDraft({ id: "second", previewMode: "creator", now: T1 }),
    );

    expect(state.selection).toEqual({ kind: "welcome" });
    expect(getSelectedChatWorkspaceTarget(state)).toEqual({ kind: "welcome" });
    const staleSelection = chatWorkspaceLifecycleReducer(state, {
      type: "selection.draft",
      draftId: "first",
    });
    expect(staleSelection).toBe(state);
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "selection.draft",
        draftId: "second",
      }).selection,
    ).toEqual({ kind: "draft", draftId: "second" });
  });

  it("ignores stale run ownership and invalid optimistic messages", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    const invalid = chatWorkspaceLifecycleReducer(state, {
      type: "run.start",
      clientRunId: "run-invalid",
      threadId: "draft",
      userMessage: { ...message("same", "Hello"), role: "assistant" },
      assistantMessage: { ...message("same", ""), role: "assistant" },
      model: MODEL,
      at: T1,
    });
    expect(invalid).toBe(state);

    state = startRun(state, "draft");
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "run.rollback",
        clientRunId: "stale",
        threadId: "draft",
        assistantMessageId: "assistant-1",
      }),
    ).toBe(state);
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "run.accept",
        clientRunId: "run-1",
        threadId: "other",
        assistantMessageId: "assistant-1",
      }),
    ).toBe(state);

    const rolledBack = chatWorkspaceLifecycleReducer(state, {
      type: "run.rollback",
      clientRunId: "run-1",
      threadId: "draft",
      assistantMessageId: "assistant-1",
    });
    const replacement = chatWorkspaceLifecycleReducer(rolledBack, {
      type: "run.start",
      clientRunId: "run-1",
      threadId: "draft",
      userMessage: message("user-2", "Try again"),
      assistantMessage: { ...message("assistant-2", ""), role: "assistant" },
      model: MODEL,
      at: T2,
    });
    expect(
      chatWorkspaceLifecycleReducer(replacement, {
        type: "run.accept",
        clientRunId: "run-1",
        threadId: "draft",
        assistantMessageId: "assistant-1",
      }),
    ).toBe(replacement);
  });

  it("admits runs only for one loaded, idle target at a time", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("first"),
      { ...summary("remote"), runStatus: "streaming" },
    ]);
    state = mergeDurableChatThreadDetail(state, detail("first", "First", []));
    state = mergeDurableChatThreadDetail(state, {
      ...detail("remote", "Remote", []),
      runStatus: "streaming",
    });
    state = setLocalChatDraft(
      state,
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );

    expect(canStartChatWorkspaceLifecycleRun(state, "first")).toBe(true);
    expect(canStartChatWorkspaceLifecycleRun(state, "remote")).toBe(false);
    expect(canStartChatWorkspaceLifecycleRun(state, "draft")).toBe(true);

    const running = startRun(state, "first");
    expect(canStartChatWorkspaceLifecycleRun(running, "draft")).toBe(false);
    expect(startRun(running, "draft")).toBe(running);
  });

  it("attributes a continuing durable conversation to the latest run model", () => {
    const previousMessage = message("previous", "Earlier question");
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      { ...summary("saved", "Saved"), model: { id: "old", displayName: "Old" } },
    ]);
    state = mergeDurableChatThreadDetail(state, {
      ...detail("saved", "Saved", [previousMessage]),
      model: { id: "old", displayName: "Old" },
    });

    state = startRun(state, "saved");
    expect(getLoadedDurableChatThread(state, "saved")).toMatchObject({
      title: "Saved",
      model: MODEL,
      messages: [previousMessage, { id: "user-1" }, { id: "assistant-1" }],
    });
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

  it("clears unread only for the exact selected durable route proven visible", () => {
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      { ...summary("selected"), unread: true, lastReadAt: null },
      { ...summary("other"), unread: true, lastReadAt: null },
    ]);
    state = selectDurableChatThread(state, "selected");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "other" },
      at: T1,
    });
    expect(getDurableChatThread(state, "selected")?.unread).toBe(true);
    expect(getDurableChatThread(state, "other")?.unread).toBe(true);

    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "selected" },
      at: T1,
    });
    expect(getDurableChatThread(state, "selected")).toMatchObject({
      unread: false,
      lastReadAt: T1,
    });
    expect(getDurableChatThread(state, "other")?.unread).toBe(true);
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "workspace.visibility-set",
        target: { kind: "thread", threadId: "selected" },
        at: T1,
      }),
    ).toBe(state);

    state = selectDurableChatThread(state, "other");
    expect(state).toMatchObject({ chatVisible: false, visibleTarget: null });
    const delayedVisibility = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "selected" },
      at: T2,
    });
    expect(delayedVisibility).toBe(state);
    expect(getDurableChatThread(delayedVisibility, "other")?.unread).toBe(true);

    state = chatWorkspaceLifecycleReducer(state, { type: "selection.welcome" });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: null,
      at: T1,
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "thread.read-state-confirmed",
      threadId: "selected",
      unread: true,
      lastReadAt: T1,
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "selected" },
      at: T2,
    });
    expect(getDurableChatThread(state, "selected")?.unread).toBe(true);
  });

  it("routes an accepted stream to its exact owner after selection changes", () => {
    let state = acceptedDurableRun("one");
    state = hydrateDurableChatThreads(state, [summary("one"), summary("two")]);
    state = selectDurableChatThread(state, "two");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "two" },
      at: T1,
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "one",
      assistantMessageId: "assistant-1",
      patch: { content: "Background answer" },
      at: T2,
    });

    expect(getLoadedDurableChatThread(state, "one")).toMatchObject({
      unread: true,
      messages: [{ id: "user-1" }, { id: "assistant-1", content: "Background answer" }],
    });
    expect(getDurableChatThread(state, "two")?.unread).toBe(false);
  });

  it("marks hidden activity unread and keeps the exactly visible owner read", () => {
    let visible = acceptedDurableRun("visible");
    visible = selectDurableChatThread(visible, "visible");
    visible = chatWorkspaceLifecycleReducer(visible, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "visible" },
      at: T1,
    });
    visible = chatWorkspaceLifecycleReducer(visible, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "visible",
      assistantMessageId: "assistant-1",
      patch: { content: "Visible answer" },
      at: T2,
    });
    expect(getLoadedDurableChatThread(visible, "visible")).toMatchObject({
      unread: false,
      lastReadAt: T2,
    });

    let hidden = acceptedDurableRun("hidden");
    hidden = selectDurableChatThread(hidden, "hidden");
    hidden = chatWorkspaceLifecycleReducer(hidden, {
      type: "workspace.visibility-set",
      target: null,
      at: T1,
    });
    hidden = chatWorkspaceLifecycleReducer(hidden, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "hidden",
      assistantMessageId: "assistant-1",
      patch: { content: "Hidden answer" },
      at: T2,
    });
    expect(getLoadedDurableChatThread(hidden, "hidden")).toMatchObject({
      unread: true,
      lastReadAt: T0,
    });
  });

  it("rejects stale run tuples, pending finishes, and duplicate terminal callbacks", () => {
    let pending = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("running"),
    ]);
    pending = mergeDurableChatThreadDetail(pending, detail("running", "running", []));
    pending = startRun(pending, "running");
    expect(
      chatWorkspaceLifecycleReducer(pending, {
        type: "run.message-update",
        clientRunId: "run-1",
        threadId: "running",
        assistantMessageId: "assistant-1",
        patch: { content: "Too early" },
        at: T2,
      }),
    ).toBe(pending);
    expect(
      chatWorkspaceLifecycleReducer(pending, {
        type: "run.finish",
        clientRunId: "run-1",
        threadId: "running",
        assistantMessageId: "assistant-1",
        outcome: "complete",
        at: T2,
      }),
    ).toBe(pending);

    const accepted = acceptRun(pending, "running");
    const staleUpdate = chatWorkspaceLifecycleReducer(accepted, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "other-assistant",
      patch: { content: "Wrong owner" },
      at: T2,
    });
    expect(staleUpdate).toBe(accepted);
    expect(
      chatWorkspaceLifecycleReducer(accepted, {
        type: "run.message-update",
        clientRunId: "run-1",
        threadId: "running",
        assistantMessageId: "assistant-1",
        patch: { content: "" },
        at: T2,
      }),
    ).toBe(accepted);
    expect(
      chatWorkspaceLifecycleReducer(accepted, {
        type: "run.finish",
        clientRunId: "stale-run",
        threadId: "running",
        assistantMessageId: "assistant-1",
        outcome: "error",
        at: T2,
      }),
    ).toBe(accepted);

    const finished = chatWorkspaceLifecycleReducer(accepted, {
      type: "run.finish",
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "assistant-1",
      outcome: "complete",
      at: T2,
    });
    expect(finished.activeRun).toBeNull();
    expect(
      chatWorkspaceLifecycleReducer(finished, {
        type: "run.finish",
        clientRunId: "run-1",
        threadId: "running",
        assistantMessageId: "assistant-1",
        outcome: "error",
        at: T2,
      }),
    ).toBe(finished);
  });

  it("terminalizes the owned assistant message and every running tool", () => {
    let state = acceptedDurableRun("running");
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "assistant-1",
      patch: {
        toolCalls: [
          { id: "active", name: "search", status: "running" },
          { id: "done", name: "read", status: "completed" },
        ],
      },
      at: T1,
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "run.finish",
      clientRunId: "run-1",
      threadId: "running",
      assistantMessageId: "assistant-1",
      outcome: "interrupted",
      at: T2,
    });

    expect(getLoadedDurableChatThread(state, "running")).toMatchObject({
      runStatus: "interrupted",
      messages: [
        { id: "user-1" },
        {
          id: "assistant-1",
          error: "Response stopped before completion.",
          toolCalls: [{ status: "error" }, { status: "completed" }],
        },
      ],
    });
  });

  it("keeps canonical summary status when detail reconciliation fails", () => {
    const transcript = [
      message("user", "Question"),
      { ...message("assistant", "Partial"), role: "assistant" as const },
    ];
    let state = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      { ...summary("remote"), runStatus: "streaming" },
    ]);
    state = mergeDurableChatThreadDetail(state, {
      ...detail("remote", "Remote", transcript),
      runStatus: "streaming",
    });
    const canonical = { ...summary("remote", "Canonical", T2), runStatus: "complete" as const };
    state = chatWorkspaceLifecycleReducer(state, {
      type: "thread.reconciliation-failed",
      thread: canonical,
      error: "Saved transcript unavailable.",
    });
    expect(getLoadedDurableChatThread(state, "remote")).toMatchObject({
      title: "Canonical",
      runStatus: "complete",
      detailError: "Saved transcript unavailable.",
    });
    expect(getLoadedDurableChatThread(state, "remote")?.messages).toBe(transcript);
    expect(getLoadedDurableChatThread(state, "remote")?.messages[1]?.error).toBeUndefined();
    expect(canStartChatWorkspaceLifecycleRun(state, "remote")).toBe(true);

    state = chatWorkspaceLifecycleReducer(state, {
      type: "thread.detail-loaded",
      thread: { ...detail("remote", "Canonical", transcript), runStatus: "complete" },
    });
    expect(getLoadedDurableChatThread(state, "remote")?.detailError).toBeNull();
  });

  it("limits draft settings to the exact idle draft and applies confirmed metadata durably", () => {
    let state = setLocalChatDraft(
      createChatWorkspaceLifecycleState(),
      createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 }),
    );
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "draft.rename",
        draftId: "stale-draft",
        title: "Wrong draft",
        at: T1,
      }),
    ).toBe(state);
    expect(
      chatWorkspaceLifecycleReducer(state, {
        type: "draft.cleared",
        draftId: "stale-draft",
      }),
    ).toBe(state);
    state = chatWorkspaceLifecycleReducer(state, {
      type: "draft.preview-mode-set",
      draftId: "draft",
      previewMode: "anonymous",
      at: T1,
    });
    state = chatWorkspaceLifecycleReducer(state, {
      type: "draft.model-set",
      draftId: "draft",
      model: MODEL,
      at: T1,
    });
    expect(state.draft).toMatchObject({ previewMode: "anonymous", model: MODEL });

    const running = startRun(state, "draft");
    expect(
      chatWorkspaceLifecycleReducer(running, {
        type: "draft.preview-mode-set",
        draftId: "draft",
        previewMode: "visitor",
        at: T2,
      }),
    ).toBe(running);
    expect(
      chatWorkspaceLifecycleReducer(running, {
        type: "draft.model-set",
        draftId: "draft",
        model: null,
        at: T2,
      }),
    ).toBe(running);

    const durableRun = acceptedDurableRun("owned");
    expect(
      chatWorkspaceLifecycleReducer(durableRun, {
        type: "thread.rename-confirmed",
        threadId: "owned",
        title: "Late rename",
        updatedAt: T2,
      }),
    ).toBe(durableRun);
    const readDuringRun = chatWorkspaceLifecycleReducer(durableRun, {
      type: "thread.read-state-confirmed",
      threadId: "owned",
      unread: true,
      lastReadAt: T1,
    });
    expect(getDurableChatThread(readDuringRun, "owned")).toMatchObject({
      title: "owned",
      unread: true,
      lastReadAt: T1,
    });

    let durable = hydrateDurableChatThreads(createChatWorkspaceLifecycleState(), [
      summary("saved", "Before"),
    ]);
    durable = chatWorkspaceLifecycleReducer(durable, {
      type: "thread.rename-confirmed",
      threadId: "saved",
      title: "Server title",
      updatedAt: T2,
    });
    durable = chatWorkspaceLifecycleReducer(durable, {
      type: "thread.read-state-confirmed",
      threadId: "saved",
      unread: true,
      lastReadAt: T1,
    });
    expect(getDurableChatThread(durable, "saved")).toMatchObject({
      lifecycle: "summary",
      title: "Server title",
      updatedAt: T2,
      unread: true,
      lastReadAt: T1,
    });
  });

  it("exposes lifecycle-safe selectors for provider rendering and ownership", () => {
    const draft = createLocalChatDraft({ id: "draft", previewMode: "creator", now: T0 });
    let state = setLocalChatDraft(createChatWorkspaceLifecycleState(), draft);
    state = hydrateDurableChatThreads(state, [summary("summary"), summary("loaded")]);
    state = mergeDurableChatThreadDetail(state, detail("loaded"));

    expect(getChatWorkspaceTargetById(state, "draft")).toBe(draft);
    expect(hasDurableChatThread(state, "summary")).toBe(true);
    expect(hasDurableChatThread(state, "draft")).toBe(false);
    state = selectDurableChatThread(state, "summary");
    expect(getSelectedChatWorkspaceId(state)).toBe("summary");
    expect(getSelectedRenderableChatWorkspaceThread(state)).toBeUndefined();
    state = selectDurableChatThread(state, "loaded");
    expect(getSelectedRenderableChatWorkspaceThread(state)?.id).toBe("loaded");
    expect(hasChatWorkspaceUserMessages(getSelectedRenderableChatWorkspaceThread(state)!)).toBe(
      true,
    );
    expect(getVisibleDurableChatThreadId(state)).toBeNull();
    state = chatWorkspaceLifecycleReducer(state, {
      type: "workspace.visibility-set",
      target: { kind: "thread", threadId: "loaded" },
      at: T2,
    });
    expect(getVisibleDurableChatThreadId(state)).toBe("loaded");
  });
});
