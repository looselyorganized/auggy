import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import { webTransport } from "@/transports/web-transport";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { ModelClient } from "@/types";

const bearer = "console-persistence-test-token";

async function sendConsoleMessage(port: number, threadId: string, message: string) {
  const csrf = await generateCsrfToken({
    bearer,
    agentName: "console-persistence-test",
    actionId: "console-chat",
  });
  return fetch(`http://127.0.0.1:${port}/console/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, threadId, message, chatMode: "creator" }),
  });
}

async function readThread(port: number, threadId: string) {
  const response = await fetch(
    `http://127.0.0.1:${port}/console/api/chat/threads/${encodeURIComponent(threadId)}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    thread: {
      runStatus: string;
      unread: boolean;
      messages: Array<{ role: string; content: string; error?: string }>;
    };
  };
}

describe("webTransport console persistence boundary", () => {
  it("restores a file-backed transcript and kernel history after a full agent restart", async () => {
    const firstPort = 39444;
    const secondPort = 39445;
    const directory = await createTempDir();
    const dbPath = join(directory.path, "console-chat.db");
    const firstModel = createMockModel({ response: "first persisted reply" });
    const firstTransport = webTransport({
      port: firstPort,
      auth: { type: "bearer", token: bearer },
      consoleChat: { dbPath },
    });
    const firstAgent = defineAgent(
      { name: "console-persistence-test", model: "mock", augments: [firstTransport] },
      firstModel,
    );
    let firstStarted = false;
    let secondAgent: ReturnType<typeof defineAgent> | null = null;

    try {
      await firstAgent.start();
      firstStarted = true;
      const first = await sendConsoleMessage(firstPort, "restart-thread", "first question");
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("first persisted reply");
      expect(firstModel.calls[0]?.messages.map((message) => message.content)).toEqual([
        "first question",
      ]);

      await firstAgent.stop();
      firstStarted = false;

      const secondModel = createMockModel({ response: "second persisted reply" });
      const secondTransport = webTransport({
        port: secondPort,
        auth: { type: "bearer", token: bearer },
        consoleChat: { dbPath },
      });
      secondAgent = defineAgent(
        { name: "console-persistence-test", model: "mock", augments: [secondTransport] },
        secondModel,
      );
      await secondAgent.start();

      const restoredBeforeTurn = (await readThread(secondPort, "restart-thread")).thread;
      expect(restoredBeforeTurn.runStatus).toBe("complete");
      expect(restoredBeforeTurn.messages.map((message) => [message.role, message.content])).toEqual(
        [
          ["user", "first question"],
          ["assistant", "first persisted reply"],
        ],
      );

      const second = await sendConsoleMessage(secondPort, "restart-thread", "second question");
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("second persisted reply");
      expect(secondModel.calls).toHaveLength(1);
      expect(secondModel.calls[0]?.messages.map((message) => message.content)).toEqual([
        "first question",
        "first persisted reply",
        "second question",
      ]);

      const restoredAfterTurn = (await readThread(secondPort, "restart-thread")).thread;
      expect(restoredAfterTurn.runStatus).toBe("complete");
      expect(restoredAfterTurn.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "first question"],
        ["assistant", "first persisted reply"],
        ["user", "second question"],
        ["assistant", "second persisted reply"],
      ]);
    } finally {
      if (firstStarted) await firstAgent.stop();
      if (secondAgent) await secondAgent.stop();
      await directory.cleanup();
    }
  });

  it("durably finishes the transcript before exposing RUN_FINISHED and blocks direct reuse", async () => {
    const port = 19441;
    const model = createMockModel({ response: "persisted assistant reply" });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: bearer },
      allowAnonymous: true,
      consoleChat: { dbPath: null },
    });
    const agent = defineAgent(
      { name: "console-persistence-test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const response = await sendConsoleMessage(port, "managed-thread", "persist this");
      expect(response.status).toBe(200);
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { type: string });
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");

      const { thread } = await readThread(port, "managed-thread");
      expect(thread.runStatus).toBe("complete");
      expect(thread.unread).toBe(true);
      expect(thread.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "persist this"],
        ["assistant", "persisted assistant reply"],
      ]);

      const callsBefore = model.calls.length;
      const direct = await fetch(`http://127.0.0.1:${port}/agent/run`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: "managed-thread",
          messages: [{ role: "user", content: "steal history" }],
        }),
      });
      expect(direct.status).toBe(403);
      expect(model.calls).toHaveLength(callsBefore);
    } finally {
      await agent.stop();
    }
  });

  it("releases a failed run lease so the same persisted thread can be retried", async () => {
    const port = 19442;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      async complete() {
        throw new Error("provider exploded");
      },
      countTokens(text) {
        return Math.ceil(text.length / 4);
      },
    };
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: bearer },
      consoleChat: { dbPath: null },
    });
    const agent = defineAgent(
      { name: "console-persistence-test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const first = await sendConsoleMessage(port, "retry-thread", "first");
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("RUN_FINISHED");
      expect((await readThread(port, "retry-thread")).thread.runStatus).toBe("error");

      const retry = await sendConsoleMessage(port, "retry-thread", "retry");
      expect(retry.status).toBe(200);
      await retry.text();
      const { thread } = await readThread(port, "retry-thread");
      expect(thread.runStatus).toBe("error");
      expect(thread.messages).toHaveLength(4);
    } finally {
      await agent.stop();
    }
  });

  it("abandons an oversized transcript update without stranding the run lease", async () => {
    const port = 19443;
    let callCount = 0;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      async complete() {
        const content = callCount++ === 0 ? "x".repeat(16 * 1024 * 1024 + 1) : "recovered";
        return {
          content,
          inputTokens: 1,
          outputTokens: 1,
          finishReason: "end_turn",
        };
      },
      countTokens(text) {
        return Math.ceil(text.length / 4);
      },
    };
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: bearer },
      consoleChat: { dbPath: null },
    });
    const agent = defineAgent(
      { name: "console-persistence-test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const first = await sendConsoleMessage(port, "oversized-thread", "make it huge");
      expect(first.status).toBe(200);
      const firstText = await first.text();
      const terminal = firstText
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              type: string;
              threadId?: string;
              runId?: string;
              result?: { status: string };
            },
        )
        .at(-1);
      expect(terminal).toEqual({
        type: "RUN_FINISHED",
        threadId: "oversized-thread",
        runId: expect.any(String),
        result: { status: "failed" },
      });
      expect(firstText).toContain("Internal error.");

      const abandoned = (await readThread(port, "oversized-thread")).thread;
      expect(abandoned.runStatus).toBe("error");
      expect(abandoned.messages[1]?.content).toBe("");
      expect(abandoned.messages[1]?.error).toBe("Console response could not be fully persisted.");

      const retry = await sendConsoleMessage(port, "oversized-thread", "retry small");
      expect(retry.status).toBe(200);
      const retryText = await retry.text();
      expect(callCount).toBe(2);
      expect(retryText).toContain("recovered");
      expect((await readThread(port, "oversized-thread")).thread.runStatus).toBe("complete");
    } finally {
      await agent.stop();
    }
  });
});
