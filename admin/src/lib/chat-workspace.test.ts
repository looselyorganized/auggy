import { describe, expect, it } from "bun:test";
import {
  canStartChatRun,
  chatWorkspaceReducer,
  createChatThread,
  createChatWorkspace,
  deriveChatThreadTitle,
  getActiveChatThread,
  getChatThread,
  validateRenamedChatThreadTitle,
  type ChatMessage,
  type ChatModelSnapshot,
  type ChatThread,
  type ChatWorkspaceState,
} from "./chat-workspace";

const T0 = "2026-07-20T10:00:00.000Z";
const T1 = "2026-07-20T10:01:00.000Z";
const T2 = "2026-07-20T10:02:00.000Z";
const MODEL: ChatModelSnapshot = {
  id: "claude-sonnet-4-5",
  displayName: "Claude Sonnet 4.5",
  provider: "anthropic",
};

function thread(id: string, now = T0): ChatThread {
  return createChatThread({ id, previewMode: "creator", now });
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  now = T0,
): ChatMessage {
  return { id, role, content, createdAt: now, updatedAt: now };
}

function startRun(
  state: ChatWorkspaceState,
  threadId: string,
  clientRunId = "run-1",
  at = T1,
): ChatWorkspaceState {
  return chatWorkspaceReducer(state, {
    type: "run.start",
    clientRunId,
    threadId,
    userMessage: message(`${clientRunId}-user`, "user", "  Review\n my agent  ", at),
    assistantMessage: message(`${clientRunId}-assistant`, "assistant", "", at),
    model: MODEL,
    at,
  });
}

describe("chat workspace titles", () => {
  it("normalizes generated titles, caps them at 60 code points, and preserves emoji", () => {
    expect(deriveChatThreadTitle("  Review\n\nmy   agent  ")).toBe("Review my agent");
    expect(deriveChatThreadTitle("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
    const emoji = deriveChatThreadTitle("🧪".repeat(70));
    expect(Array.from(emoji)).toHaveLength(60);
    expect(emoji).not.toContain("�");
    expect(deriveChatThreadTitle(" \n ")).toBe("New chat");
  });

  it("trims renames and rejects empty or overlong values", () => {
    expect(validateRenamedChatThreadTitle("  Debug auth  ")).toEqual({
      valid: true,
      title: "Debug auth",
    });
    expect(validateRenamedChatThreadTitle(" \n ")).toMatchObject({ valid: false, reason: "empty" });
    expect(validateRenamedChatThreadTitle("x".repeat(81))).toMatchObject({
      valid: false,
      reason: "too-long",
    });
    expect(validateRenamedChatThreadTitle("🧪".repeat(80))).toMatchObject({ valid: true });
  });
});

describe("chat workspace drafts and navigation", () => {
  it("starts with exactly one active draft and reuses it", () => {
    const initial = createChatWorkspace(thread("draft-one"));
    const state = chatWorkspaceReducer(initial, {
      type: "draft.activate",
      draft: createChatThread({ id: "unused", previewMode: "anonymous", now: T1 }),
    });
    expect(state.threads).toHaveLength(1);
    expect(state.activeThreadId).toBe("draft-one");
    expect(getActiveChatThread(state)?.previewMode).toBe("anonymous");
  });

  it("creates one new draft after a populated thread, then reuses it", () => {
    const populated = startRun(createChatWorkspace(thread("existing")), "existing");
    const withDraft = chatWorkspaceReducer(populated, {
      type: "draft.activate",
      draft: createChatThread({ id: "draft", previewMode: "visitor", now: T2 }),
    });
    const reused = chatWorkspaceReducer(withDraft, {
      type: "draft.activate",
      draft: createChatThread({ id: "unused", previewMode: "creator", now: T2 }),
    });
    expect(reused.threads.map(({ id }) => id)).toEqual(["existing", "draft"]);
    expect(reused.activeThreadId).toBe("draft");
    expect(getActiveChatThread(reused)?.previewMode).toBe("creator");
  });

  it("locks auth and model after the first message", () => {
    let state = createChatWorkspace(thread("one"));
    state = chatWorkspaceReducer(state, {
      type: "thread.preview-mode-set",
      threadId: "one",
      previewMode: "anonymous",
      at: T1,
    });
    state = startRun(state, "one");
    state = chatWorkspaceReducer(state, {
      type: "thread.preview-mode-set",
      threadId: "one",
      previewMode: "visitor",
      at: T2,
    });
    state = chatWorkspaceReducer(state, {
      type: "thread.model-set",
      threadId: "one",
      model: { id: "other", displayName: "Other" },
      at: T2,
    });
    expect(getActiveChatThread(state)).toMatchObject({ previewMode: "anonymous", model: MODEL });
  });

  it("selects a thread, clears unread, and supports explicitly marking active unread", () => {
    const state: ChatWorkspaceState = {
      threads: [thread("first"), { ...thread("second"), unread: true }],
      activeThreadId: "first",
      activeRun: null,
    };
    const selected = chatWorkspaceReducer(state, {
      type: "thread.select",
      threadId: "second",
      at: T1,
    });
    const unread = chatWorkspaceReducer(selected, {
      type: "thread.read-state-set",
      threadId: "second",
      unread: true,
      at: T2,
    });
    expect(getActiveChatThread(selected)?.unread).toBe(false);
    expect(getActiveChatThread(unread)?.unread).toBe(true);
  });

  it("deletes the active thread by MRU, creates a fallback for the last thread, and rejects deleting a run owner", () => {
    const state: ChatWorkspaceState = {
      threads: [thread("active"), thread("older", T1), thread("newer", T2)],
      activeThreadId: "active",
      activeRun: null,
    };
    const next = chatWorkspaceReducer(state, {
      type: "thread.delete",
      threadId: "active",
      fallbackDraft: thread("unused"),
    });
    expect(next.activeThreadId).toBe("newer");

    const lastDeleted = chatWorkspaceReducer(createChatWorkspace(thread("only")), {
      type: "thread.delete",
      threadId: "only",
      fallbackDraft: createChatThread({ id: "fallback", previewMode: "anonymous", now: T2 }),
    });
    expect(lastDeleted.activeThreadId).toBe("fallback");

    const running = startRun(createChatWorkspace(thread("running")), "running");
    expect(
      chatWorkspaceReducer(running, {
        type: "thread.delete",
        threadId: "running",
        fallbackDraft: thread("fallback"),
      }),
    ).toBe(running);
  });
});

describe("chat workspace run ownership", () => {
  it("atomically adds both messages, derives the title, freezes the model, and claims the run", () => {
    const state = startRun(createChatWorkspace(thread("one")), "one");
    expect(state.activeRun).toEqual({
      clientRunId: "run-1",
      threadId: "one",
      assistantMessageId: "run-1-assistant",
    });
    expect(getActiveChatThread(state)).toMatchObject({
      title: "Review my agent",
      model: MODEL,
      runStatus: "streaming",
    });
    expect(getActiveChatThread(state)?.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("allows only one global run", () => {
    const initial: ChatWorkspaceState = {
      threads: [thread("one"), thread("two")],
      activeThreadId: "one",
      activeRun: null,
    };
    const running = startRun(initial, "one");
    expect(canStartChatRun(running, "two")).toBe(false);
    expect(startRun(running, "two", "run-2", T2)).toBe(running);
  });

  it("routes background deltas to their owner and marks that thread unread", () => {
    let state: ChatWorkspaceState = {
      threads: [thread("one"), thread("two")],
      activeThreadId: "one",
      activeRun: null,
    };
    state = startRun(state, "one");
    state = chatWorkspaceReducer(state, { type: "thread.select", threadId: "two", at: T1 });
    state = chatWorkspaceReducer(state, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "one",
      messageId: "run-1-assistant",
      patch: { content: "Background reply" },
      at: T2,
    });
    expect(getChatThread(state, "one")?.messages.at(-1)?.content).toBe("Background reply");
    expect(getChatThread(state, "one")?.unread).toBe(true);
    expect(getChatThread(state, "two")?.messages).toHaveLength(0);
  });

  it("ignores stale, mismatched, and duplicate terminal events", () => {
    const running = startRun(createChatWorkspace(thread("one")), "one");
    const stale = chatWorkspaceReducer(running, {
      type: "run.message-update",
      clientRunId: "old-run",
      threadId: "one",
      messageId: "run-1-assistant",
      patch: { content: "Wrong" },
      at: T2,
    });
    expect(stale).toBe(running);

    const finished = chatWorkspaceReducer(running, {
      type: "run.finish",
      clientRunId: "run-1",
      threadId: "one",
      outcome: "complete",
      at: T2,
    });
    expect(finished.activeRun).toBeNull();
    expect(
      chatWorkspaceReducer(finished, {
        type: "run.finish",
        clientRunId: "run-1",
        threadId: "one",
        outcome: "error",
        at: T2,
      }),
    ).toBe(finished);
  });

  it("terminalizes stopped replies and running tools intelligibly", () => {
    let state = startRun(createChatWorkspace(thread("one")), "one");
    state = chatWorkspaceReducer(state, {
      type: "run.message-update",
      clientRunId: "run-1",
      threadId: "one",
      messageId: "run-1-assistant",
      patch: { toolCalls: [{ id: "tool", name: "memory_search", status: "running" }] },
      at: T1,
    });
    state = chatWorkspaceReducer(state, {
      type: "run.finish",
      clientRunId: "run-1",
      threadId: "one",
      outcome: "interrupted",
      at: T2,
    });
    expect(getActiveChatThread(state)).toMatchObject({ runStatus: "interrupted" });
    expect(getActiveChatThread(state)?.messages.at(-1)).toMatchObject({
      error: "Response stopped before completion.",
      toolCalls: [{ status: "error" }],
    });
  });
});
