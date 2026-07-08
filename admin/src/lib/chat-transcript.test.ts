import { describe, expect, it } from "bun:test";
import { formatChatTranscript, type ChatTranscriptMessage } from "./chat-transcript";

const copiedAt = new Date("2026-07-08T12:34:56.000Z");

describe("formatChatTranscript", () => {
  it("formats conversation metadata and messages", () => {
    const transcript = formatChatTranscript(
      [
        { role: "user", content: "What can you do?" },
        { role: "assistant", content: "I can help debug **runtime state**." },
      ],
      {
        agentName: "Concierge DX",
        previewModeLabel: "Verified creator",
        threadId: "thread-123",
        copiedAt,
      },
    );

    expect(transcript).toContain("# Auggy console chat transcript");
    expect(transcript).toContain("Agent: Concierge DX");
    expect(transcript).toContain("Preview mode: Verified creator");
    expect(transcript).toContain("Thread ID: thread-123");
    expect(transcript).toContain("Copied at: 2026-07-08T12:34:56.000Z");
    expect(transcript).toContain("### 1. User\n\nWhat can you do?");
    expect(transcript).toContain(
      "### 2. Concierge DX\n\nI can help debug **runtime state**.",
    );
  });

  it("includes tool calls and errors without leaking UI-only fields", () => {
    const messages: ChatTranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "memory_search",
            args: '{"query":"visitor"}',
            result: "[]",
            status: "completed",
          },
        ],
        error: "Agent error",
      },
    ];

    const transcript = formatChatTranscript(messages, {
      agentName: "Agent",
      previewModeLabel: "Anonymous",
      threadId: "thread-456",
      copiedAt,
    });

    expect(transcript).toContain("#### Tool call 1: memory_search (completed)");
    expect(transcript).toContain("Args:\n\n```text\n{\"query\":\"visitor\"}\n```");
    expect(transcript).toContain("Result:\n\n```text\n[]\n```");
    expect(transcript).toContain("Error:\n\n```text\nAgent error\n```");
    expect(transcript).not.toContain("csrf");
    expect(transcript).not.toContain("visitorToken");
  });

  it("uses a longer code fence when tool output contains backticks", () => {
    const transcript = formatChatTranscript(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              name: "fs_read",
              args: "```ts\nconst x = 1;\n```",
              status: "running",
            },
          ],
        },
      ],
      {
        agentName: "Agent",
        previewModeLabel: "Verified visitor",
        threadId: "thread-789",
        copiedAt,
      },
    );

    expect(transcript).toContain("````text\n```ts\nconst x = 1;\n```\n````");
  });
});
