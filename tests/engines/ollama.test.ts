import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ChatRequest, ChatResponse, Message as OllamaMessage } from "ollama";
import type { Message, ToolDefinition, AssembledPrompt } from "../../src/types";

// ---------------------------------------------------------------------------
// SDK mock — captures calls to Ollama.chat so we can assert on the request
// payload (model, messages translation, tools translation, options.num_predict,
// keep_alive) and the constructor (host / baseURL).
// ---------------------------------------------------------------------------

let lastChatArgs: ChatRequest | null = null;
let lastConstructorArgs: { host?: string } | null = null;
let nextResponse: ChatResponse | null = null;
let nextStreamChunks: ChatResponse[] | null = null;
let throwOnChat: Error | null = null;

const defaultResponse = (): ChatResponse => ({
  model: "llama3.2",
  created_at: new Date(0),
  message: { role: "assistant", content: "ok" },
  done: true,
  done_reason: "stop",
  total_duration: 0,
  load_duration: 0,
  prompt_eval_count: 10,
  prompt_eval_duration: 0,
  eval_count: 5,
  eval_duration: 0,
});

mock.module("ollama", () => {
  class FakeOllama {
    constructor(config?: { host?: string }) {
      lastConstructorArgs = config ?? null;
    }
    async chat(req: ChatRequest): Promise<ChatResponse | AsyncIterable<ChatResponse>> {
      lastChatArgs = req;
      if (throwOnChat) throw throwOnChat;
      if (req.stream === true) {
        const chunks = nextStreamChunks ?? [defaultResponse()];
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      }
      return nextResponse ?? defaultResponse();
    }
  }
  return { Ollama: FakeOllama };
});

// Import must come AFTER mock.module so the mocked module is used.
const { createOllamaEngine } = await import("@auggy/ollama");

beforeEach(() => {
  lastChatArgs = null;
  lastConstructorArgs = null;
  nextResponse = null;
  nextStreamChunks = null;
  throwOnChat = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? crypto.randomUUID(),
    role: partial.role ?? "user",
    content: partial.content ?? "",
    timestamp: partial.timestamp ?? Date.now(),
    tokenCount: partial.tokenCount ?? 0,
    toolCallId: partial.toolCallId,
    peerId: partial.peerId,
  };
}

function emptyPrompt(over: Partial<AssembledPrompt> = {}): AssembledPrompt {
  return {
    systemBlocks: [],
    contextBlocks: [],
    messages: [],
    tools: [],
    totalTokens: 0,
    evictions: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Constructor / baseURL
// ---------------------------------------------------------------------------

describe("createOllamaEngine — constructor", () => {
  test("defaults host to http://localhost:11434 when baseURL omitted", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastConstructorArgs?.host).toBe("http://localhost:11434");
  });

  test("uses explicit baseURL when provided", async () => {
    const engine = createOllamaEngine({ model: "llama3.2", baseURL: "http://other:9999" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastConstructorArgs?.host).toBe("http://other:9999");
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("createOllamaEngine — request shape", () => {
  test("forwards model + keep_alive default '5m'", async () => {
    const engine = createOllamaEngine({ model: "qwen2.5" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.model).toBe("qwen2.5");
    expect(lastChatArgs?.keep_alive).toBe("5m");
  });

  test("forwards explicit keep_alive override", async () => {
    const engine = createOllamaEngine({ model: "llama3.2", keepAlive: "30m" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.keep_alive).toBe("30m");
  });

  test("forwards numeric keep_alive (0 = unload immediately)", async () => {
    const engine = createOllamaEngine({ model: "llama3.2", keepAlive: 0 });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.keep_alive).toBe(0);
  });

  test("sets options.num_predict from maxTokens (default 2048)", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.options?.num_predict).toBe(2048);
  });

  test("uses explicit maxTokens for num_predict", async () => {
    const engine = createOllamaEngine({ model: "llama3.2", maxTokens: 512 });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.options?.num_predict).toBe(512);
  });

  test("merges operator-provided options with num_predict", async () => {
    const engine = createOllamaEngine({
      model: "llama3.2",
      maxTokens: 1024,
      options: { temperature: 0.7, seed: 42 },
    });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.options?.num_predict).toBe(1024);
    expect(lastChatArgs?.options?.temperature).toBe(0.7);
    expect(lastChatArgs?.options?.seed).toBe(42);
  });

  test("omits tools field when no tools defined", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

describe("createOllamaEngine — message translation", () => {
  test("prepends system message from systemBlocks", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(
      emptyPrompt({
        systemBlocks: ["you are helpful"],
        messages: [msg({ role: "user", content: "hi" })],
      }),
    );
    expect(lastChatArgs?.messages?.[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(lastChatArgs?.messages?.[1]).toEqual({ role: "user", content: "hi" });
  });

  test("no system message when systemBlocks empty", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }));
    expect(lastChatArgs?.messages?.[0]).toEqual({ role: "user", content: "hi" });
    expect(lastChatArgs?.messages).toHaveLength(1);
  });

  test("translates assistant + consecutive tool_use into one assistant message with tool_calls", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(
      emptyPrompt({
        messages: [
          msg({ role: "user", content: "do it" }),
          msg({ role: "assistant", content: "ok, calling" }),
          msg({
            role: "tool_use",
            toolCallId: "call_1",
            content: JSON.stringify({ name: "fs_read", arguments: { path: "/x" } }),
          }),
        ],
      }),
    );
    const assistantMsg = lastChatArgs?.messages?.[1] as OllamaMessage;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("ok, calling");
    expect(assistantMsg.tool_calls).toEqual([
      { function: { name: "fs_read", arguments: { path: "/x" } } },
    ]);
  });

  test("translates tool_result into role: 'tool' message", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(
      emptyPrompt({
        messages: [
          msg({ role: "user", content: "do it" }),
          msg({ role: "assistant", content: "" }),
          msg({
            role: "tool_use",
            toolCallId: "call_1",
            content: JSON.stringify({ name: "fs_read", arguments: { path: "/x" } }),
          }),
          msg({ role: "tool_result", toolCallId: "call_1", content: "file contents" }),
        ],
      }),
    );
    const toolResult = lastChatArgs?.messages?.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toBe("file contents");
  });

  test("skips empty assistant messages with no content and no tool calls", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    await engine.complete(
      emptyPrompt({
        messages: [
          msg({ role: "user", content: "hi" }),
          msg({ role: "assistant", content: "" }),
          msg({ role: "user", content: "still there?" }),
        ],
      }),
    );
    const roles = lastChatArgs?.messages?.map((m) => m.role);
    expect(roles).toEqual(["user", "user"]);
  });
});

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

describe("createOllamaEngine — tool translation", () => {
  test("translates ToolDefinition into Ollama Tool with type: 'function'", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    const tools: ToolDefinition[] = [
      {
        name: "fs_read",
        description: "read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];
    await engine.complete(
      emptyPrompt({ tools, messages: [msg({ role: "user", content: "read /etc/hosts" })] }),
    );
    expect(lastChatArgs?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "fs_read",
          description: "read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Response translation — non-streaming
// ---------------------------------------------------------------------------

describe("createOllamaEngine — response translation", () => {
  test("buffered response → ModelResponse with content + finishReason 'end_turn'", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextResponse = {
      ...defaultResponse(),
      message: { role: "assistant", content: "hello world" },
      done_reason: "stop",
      prompt_eval_count: 42,
      eval_count: 18,
    };
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }),
    );
    expect(result.content).toBe("hello world");
    expect(result.finishReason).toBe("end_turn");
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(18);
    expect(result.toolCalls).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });

  test("extracts tool_calls from message → ModelResponse.toolCalls with finishReason 'tool_use'", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextResponse = {
      ...defaultResponse(),
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "fs_read", arguments: { path: "/etc/hosts" } } },
          { function: { name: "web_fetch", arguments: { url: "https://example.com" } } },
        ],
      },
    };
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "do things" })] }),
    );
    expect(result.toolCalls).toEqual([
      { name: "fs_read", arguments: { path: "/etc/hosts" } },
      { name: "web_fetch", arguments: { url: "https://example.com" } },
    ]);
    expect(result.finishReason).toBe("tool_use");
  });

  test("maps done_reason 'length' → finishReason 'max_tokens'", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextResponse = { ...defaultResponse(), done_reason: "length" };
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }),
    );
    expect(result.finishReason).toBe("max_tokens");
  });

  test("costUsd is always undefined (free local runtime)", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }),
    );
    expect(result.costUsd).toBeUndefined();
  });

  test("empty message content yields empty content ModelResponse", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextResponse = {
      ...defaultResponse(),
      message: { role: "assistant", content: "" },
    };
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }),
    );
    expect(result.content).toBe("");
    expect(result.finishReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("createOllamaEngine — streaming", () => {
  test("does not start a request when the AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = createOllamaEngine({ model: "llama3.2" });

    await expect(
      engine.complete(emptyPrompt(), { onDelta: () => {}, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(lastChatArgs).toBeNull();
  });

  test("does not start a buffered request when the AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = createOllamaEngine({ model: "llama3.2" });

    await expect(
      engine.complete(emptyPrompt(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(lastChatArgs).toBeNull();
  });

  test("uses Ollama's abortable stream when a buffered call has a signal", async () => {
    const controller = new AbortController();
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextStreamChunks = [
      { ...defaultResponse(), message: { role: "assistant", content: "buffered" } },
    ];

    const result = await engine.complete(emptyPrompt(), { signal: controller.signal });

    expect(lastChatArgs?.stream).toBe(true);
    expect(result.content).toBe("buffered");
  });

  test("emits text_delta for each chunk + buffers final ModelResponse", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextStreamChunks = [
      { ...defaultResponse(), message: { role: "assistant", content: "hello " }, done: false },
      { ...defaultResponse(), message: { role: "assistant", content: "world" }, done: false },
      {
        ...defaultResponse(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 7,
      },
    ];
    const deltas: string[] = [];
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }),
      {
        onDelta: (d) => {
          if (d.kind === "text_delta") deltas.push(d.text);
        },
      },
    );
    expect(deltas).toEqual(["hello ", "world"]);
    expect(result.content).toBe("hello world");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(7);
  });

  test("throws if stream yields no chunks", async () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextStreamChunks = [];
    await expect(
      engine.complete(emptyPrompt({ messages: [msg({ role: "user", content: "hi" })] }), {
        onDelta: () => {},
      }),
    ).rejects.toThrow("Ollama stream returned no chunks");
  });

  test("extracts tool_calls from intermediate chunk (not the final done:true chunk)", async () => {
    // Regression guard for the streaming + tool-call bug found during G35
    // manual integration: Ollama emits the entire tool_calls array in an
    // intermediate chunk (typically the FIRST chunk for a tool-using turn)
    // with done:false. The final done:true chunk does NOT repeat them.
    // Earlier code only consulted the final chunk's message.tool_calls —
    // which is always undefined for tool-using turns — silently producing
    // empty turns ("completed" status, no text, no tool calls executed).
    //
    // This shape mirrors what `llama3.2` actually returns for a tool-using
    // turn (captured via direct ollama API call against the SDK).
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextStreamChunks = [
      {
        ...defaultResponse(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "memory_write",
                arguments: { label: "hi", value: "user said hi" },
              },
            },
          ],
        },
        done: false,
      },
      {
        ...defaultResponse(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 100,
        eval_count: 22,
      },
    ];
    const deltas: string[] = [];
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "say hi" })] }),
      {
        onDelta: (d) => {
          if (d.kind === "text_delta") deltas.push(d.text);
        },
      },
    );
    expect(deltas).toEqual([]);
    expect(result.toolCalls).toEqual([
      { name: "memory_write", arguments: { label: "hi", value: "user said hi" } },
    ]);
    expect(result.finishReason).toBe("tool_use");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(22);
  });

  test("accumulates tool_calls across multiple intermediate chunks", async () => {
    // Defensive: even though llama3.2 emits all tool_calls in a single
    // chunk, the adapter should handle a model that spreads them across
    // multiple chunks (some future Ollama model might).
    const engine = createOllamaEngine({ model: "llama3.2" });
    nextStreamChunks = [
      {
        ...defaultResponse(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "first_tool", arguments: { x: 1 } } }],
        },
        done: false,
      },
      {
        ...defaultResponse(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "second_tool", arguments: { y: 2 } } }],
        },
        done: false,
      },
      { ...defaultResponse(), message: { role: "assistant", content: "" }, done: true },
    ];
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ role: "user", content: "do two things" })] }),
      { onDelta: () => {} },
    );
    expect(result.toolCalls).toEqual([
      { name: "first_tool", arguments: { x: 1 } },
      { name: "second_tool", arguments: { y: 2 } },
    ]);
    expect(result.finishReason).toBe("tool_use");
  });
});

// ---------------------------------------------------------------------------
// ModelClient surface
// ---------------------------------------------------------------------------

describe("createOllamaEngine — ModelClient surface", () => {
  test("countTokens uses char/4 approximation", () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    expect(engine.countTokens("hello")).toBe(2); // 5 chars / 4 = 1.25 → ceil = 2
    expect(engine.countTokens("a".repeat(100))).toBe(25);
  });

  test("maxContextTokens default is 8192", () => {
    const engine = createOllamaEngine({ model: "llama3.2" });
    expect(engine.maxContextTokens).toBe(8192);
  });

  test("maxContextTokens honors explicit setting", () => {
    const engine = createOllamaEngine({ model: "llama3.2", maxContextTokens: 131072 });
    expect(engine.maxContextTokens).toBe(131072);
  });
});
