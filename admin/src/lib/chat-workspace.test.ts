import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CHAT_THREAD_TITLE,
  GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH,
  RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH,
  createChatThread,
  deriveChatThreadTitle,
  validateRenamedChatThreadTitle,
  type ChatModelSnapshot,
} from "./chat-workspace";

const NOW = "2026-07-22T10:00:00.000Z";
const MODEL: ChatModelSnapshot = {
  id: "claude-sonnet-4-5",
  displayName: "Claude Sonnet 4.5",
  provider: "anthropic",
};

describe("chat thread domain", () => {
  it("creates an idle, read thread with deterministic defaults", () => {
    expect(
      createChatThread({
        id: "thread-1",
        previewMode: "creator",
        now: NOW,
      }),
    ).toEqual({
      id: "thread-1",
      title: DEFAULT_CHAT_THREAD_TITLE,
      previewMode: "creator",
      model: null,
      messages: [],
      createdAt: NOW,
      updatedAt: NOW,
      lastReadAt: NOW,
      unread: false,
      runStatus: "idle",
    });
  });

  it("normalizes a supplied title and preserves the initial model snapshot", () => {
    const thread = createChatThread({
      id: "thread-1",
      title: "  Diagnose checkout  ",
      previewMode: "visitor",
      model: MODEL,
      now: NOW,
    });

    expect(thread.title).toBe("Diagnose checkout");
    expect(thread.model).toBe(MODEL);
    expect(
      createChatThread({
        id: "thread-2",
        title: " \n ",
        previewMode: "anonymous",
        now: NOW,
      }).title,
    ).toBe(DEFAULT_CHAT_THREAD_TITLE);
  });
});

describe("generated chat titles", () => {
  it("normalizes whitespace and falls back for an empty prompt", () => {
    expect(deriveChatThreadTitle("  Review\n\nmy   agent  ")).toBe("Review my agent");
    expect(deriveChatThreadTitle(" \n ")).toBe(DEFAULT_CHAT_THREAD_TITLE);
  });

  it("caps titles by Unicode code points without splitting emoji", () => {
    const ascii = deriveChatThreadTitle("x".repeat(GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH + 20));
    const emoji = deriveChatThreadTitle("🧪".repeat(GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH + 10));

    expect(ascii).toBe(`${"x".repeat(GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH - 1)}…`);
    expect(Array.from(emoji)).toHaveLength(GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH);
    expect(emoji).not.toContain("�");
  });
});

describe("renamed chat title validation", () => {
  it("accepts and trims a title at the Unicode code-point limit", () => {
    const title = "🧪".repeat(RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH);

    expect(validateRenamedChatThreadTitle(`  ${title}  `)).toEqual({
      valid: true,
      title,
    });
  });

  it("returns actionable reasons for empty and overlong titles", () => {
    expect(validateRenamedChatThreadTitle(" \n ")).toEqual({
      valid: false,
      reason: "empty",
      message: "Chat title cannot be empty.",
    });
    expect(
      validateRenamedChatThreadTitle("x".repeat(RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH + 1)),
    ).toEqual({
      valid: false,
      reason: "too-long",
      message: `Chat title must be ${RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH} characters or fewer.`,
    });
  });
});
