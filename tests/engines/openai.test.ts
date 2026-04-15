import { describe, test, expect, mock, beforeEach } from "bun:test";
import type OpenAI from "openai";
import type { Message, ToolDefinition, AssembledPrompt } from "../../src/types";

// ---------------------------------------------------------------------------
// SDK mock — captures calls to chat.completions.create so we can assert on
// the request payload (max_completion_tokens vs max_tokens, reasoning_effort
// placement, no stream:true, etc).
// ---------------------------------------------------------------------------

let lastCreateArgs: Record<string, unknown> | null = null;
let lastConstructorArgs: Record<string, unknown> | null = null;
let nextResponse: OpenAI.Chat.ChatCompletion | null = null;
let throwOnCreate: Error | null = null;

const defaultResponse = (): OpenAI.Chat.ChatCompletion => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 0,
  model: "gpt-5",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "ok",
        refusal: null,
      },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

mock.module("openai", () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async (
          params: Record<string, unknown>,
        ): Promise<OpenAI.Chat.ChatCompletion> => {
          lastCreateArgs = params;
          if (throwOnCreate) throw throwOnCreate;
          return nextResponse ?? defaultResponse();
        },
      },
    };
    constructor(opts: Record<string, unknown>) {
      lastConstructorArgs = opts;
    }
  }
  return { default: FakeOpenAI };
});

// Imports must come AFTER mock.module to ensure the mocked module is used.
const {
  createOpenAIEngine,
  assembleOpenAISystemMessage,
  safeParseToolCall,
  convertOpenAIMessages,
  convertOpenAITools,
  safeParseJson,
  buildOpenAIModelResponse,
} = await import("../../src/engines/openai");

beforeEach(() => {
  lastCreateArgs = null;
  lastConstructorArgs = null;
  nextResponse = null;
  throwOnCreate = null;
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
// assembleOpenAISystemMessage
// ---------------------------------------------------------------------------

describe("assembleOpenAISystemMessage", () => {
  test("returns null when all blocks empty", () => {
    expect(assembleOpenAISystemMessage(emptyPrompt())).toBeNull();
  });

  test("joins systemBlocks", () => {
    const result = assembleOpenAISystemMessage(
      emptyPrompt({ systemBlocks: ["a", "b"] }),
    );
    expect(result).toEqual({ role: "system", content: "a\n\nb" });
  });

  test("includes contextBlocks and assistantPreamble", () => {
    const result = assembleOpenAISystemMessage(
      emptyPrompt({
        systemBlocks: ["sys"],
        contextBlocks: ["ctx"],
        assistantPreamble: ["pre"],
      }),
    );
    expect(result).toEqual({ role: "system", content: "sys\n\nctx\n\npre" });
  });
});

// ---------------------------------------------------------------------------
// safeParseToolCall
// ---------------------------------------------------------------------------

describe("safeParseToolCall", () => {
  test("parses well-formed payload", () => {
    const result = safeParseToolCall(
      JSON.stringify({ name: "fs_read", arguments: { path: "/foo" } }),
    );
    expect(result).toEqual({ name: "fs_read", arguments: { path: "/foo" } });
  });

  test("returns null on malformed JSON", () => {
    expect(safeParseToolCall("not json")).toBeNull();
  });

  test("returns null on missing name", () => {
    expect(safeParseToolCall(JSON.stringify({ arguments: {} }))).toBeNull();
  });

  test("returns null on missing arguments", () => {
    expect(safeParseToolCall(JSON.stringify({ name: "x" }))).toBeNull();
  });

  test("returns null when arguments is an array (typeof array === 'object' bypass)", () => {
    expect(
      safeParseToolCall(JSON.stringify({ name: "x", arguments: [1, 2, 3] })),
    ).toBeNull();
  });

  test("returns null when arguments is null", () => {
    expect(
      safeParseToolCall(JSON.stringify({ name: "x", arguments: null })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// convertOpenAIMessages
// ---------------------------------------------------------------------------

describe("convertOpenAIMessages", () => {
  test("maps user message to user role", () => {
    const result = convertOpenAIMessages([
      msg({ role: "user", content: "hello" }),
    ]);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  test("folds assistant text + tool_use into single assistant message", () => {
    const result = convertOpenAIMessages([
      msg({ role: "assistant", content: "let me check" }),
      msg({
        role: "tool_use",
        toolCallId: "t1",
        content: JSON.stringify({
          name: "memory_read",
          arguments: { label: "self" },
        }),
      }),
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: {
              name: "memory_read",
              arguments: JSON.stringify({ label: "self" }),
            },
          },
        ],
      },
    ]);
  });

  test("folds multiple consecutive tool_use into single assistant turn", () => {
    const result = convertOpenAIMessages([
      msg({ role: "assistant", content: "thinking" }),
      msg({
        role: "tool_use",
        toolCallId: "t1",
        content: JSON.stringify({ name: "a", arguments: {} }),
      }),
      msg({
        role: "tool_use",
        toolCallId: "t2",
        content: JSON.stringify({ name: "b", arguments: {} }),
      }),
    ]);
    expect(result).toHaveLength(1);
    const assistant =
      result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.tool_calls).toHaveLength(2);
    expect(assistant.tool_calls?.[0]?.id).toBe("t1");
    expect(assistant.tool_calls?.[1]?.id).toBe("t2");
  });

  test("emits standalone assistant for orphaned tool_use", () => {
    const result = convertOpenAIMessages([
      msg({
        role: "tool_use",
        toolCallId: "t1",
        content: JSON.stringify({ name: "x", arguments: {} }),
      }),
    ]);
    expect(result).toHaveLength(1);
    const assistant =
      result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(1);
  });

  test("maps tool_result to role: tool with tool_call_id", () => {
    const result = convertOpenAIMessages([
      msg({ role: "tool_result", toolCallId: "t1", content: "result body" }),
    ]);
    expect(result).toEqual([
      { role: "tool", tool_call_id: "t1", content: "result body" },
    ]);
  });

  test("keeps consecutive tool_results as separate tool messages", () => {
    const result = convertOpenAIMessages([
      msg({ role: "tool_result", toolCallId: "t1", content: "a" }),
      msg({ role: "tool_result", toolCallId: "t2", content: "b" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("tool");
    expect(result[1]?.role).toBe("tool");
  });

  test("coalesces consecutive user messages with double newline", () => {
    const result = convertOpenAIMessages([
      msg({ role: "user", content: "first" }),
      msg({ role: "user", content: "second" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "first\n\nsecond" });
  });

  test("does not coalesce alternating user/assistant", () => {
    const result = convertOpenAIMessages([
      msg({ role: "user", content: "a" }),
      msg({ role: "assistant", content: "b" }),
      msg({ role: "user", content: "c" }),
    ]);
    expect(result).toHaveLength(3);
  });

  test("skips assistant messages with empty content and no tool_calls", () => {
    const result = convertOpenAIMessages([
      msg({ role: "user", content: "hi" }),
      msg({ role: "assistant", content: "" }),
      msg({ role: "user", content: "still there?" }),
    ]);
    // Empty assistant is dropped; the two users then coalesce.
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });

  test("drops tool_use with valid parse but missing toolCallId, with warning", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (s: string) => warnings.push(s);
    try {
      const result = convertOpenAIMessages([
        msg({ role: "assistant", content: "checking" }),
        msg({
          role: "tool_use",
          // No toolCallId set
          content: JSON.stringify({ name: "x", arguments: {} }),
        }),
      ]);
      // Assistant text remains, tool_calls array is empty (so omitted).
      expect(result).toHaveLength(1);
      const a = result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      expect(a.content).toBe("checking");
      expect(a.tool_calls).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/missing toolCallId/);
    } finally {
      console.warn = original;
    }
  });

  test("drops tool_use with malformed JSON content, with warning", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (s: string) => warnings.push(s);
    try {
      convertOpenAIMessages([
        msg({
          role: "tool_use",
          toolCallId: "t1",
          content: "this is not valid json",
        }),
      ]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/parse failed/);
      expect(warnings[0]).toMatch(/\[Auggy:openai\]/);
    } finally {
      console.warn = original;
    }
  });
});

// ---------------------------------------------------------------------------
// convertOpenAITools
// ---------------------------------------------------------------------------

describe("convertOpenAITools", () => {
  test("wraps tool in function shape", () => {
    const td: ToolDefinition = {
      name: "search",
      description: "search the web",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    };
    const result = convertOpenAITools([td]);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "search the web",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      },
    ]);
  });

  test("strips $schema and $id from parameters", () => {
    const td: ToolDefinition = {
      name: "x",
      description: "y",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "abc",
        type: "object",
        properties: {},
      },
    };
    const result = convertOpenAITools([td]);
    const tool = result[0]!;
    if (tool.type !== "function") throw new Error("expected function tool");
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.$schema).toBeUndefined();
    expect(params.$id).toBeUndefined();
    expect(params.type).toBe("object");
  });

  test("returns empty array for empty input", () => {
    expect(convertOpenAITools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// safeParseJson
// ---------------------------------------------------------------------------

describe("safeParseJson", () => {
  test("parses well-formed object JSON", () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns {} on malformed JSON", () => {
    expect(safeParseJson("not json")).toEqual({});
  });

  test("returns {} for arrays (object expected)", () => {
    expect(safeParseJson("[1,2]")).toEqual({});
  });

  test("returns {} for primitives", () => {
    expect(safeParseJson("42")).toEqual({});
    expect(safeParseJson('"hi"')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildOpenAIModelResponse — finishReason mapping table + edge cases
// ---------------------------------------------------------------------------

function mockCompletion(over: {
  content?: string | null;
  finishReason?: OpenAI.Chat.ChatCompletion.Choice["finish_reason"];
  toolCalls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  emptyChoices?: boolean;
}): OpenAI.Chat.ChatCompletion {
  if (over.emptyChoices) {
    return {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "gpt-5",
      choices: [],
      usage: {
        prompt_tokens: over.inputTokens ?? 0,
        completion_tokens: over.outputTokens ?? 0,
        total_tokens: 0,
      },
    };
  }
  const message: OpenAI.Chat.ChatCompletionMessage = {
    role: "assistant",
    content: over.content ?? null,
    refusal: null,
    ...(over.toolCalls ? { tool_calls: over.toolCalls } : {}),
  };
  return {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "gpt-5",
    choices: [
      {
        index: 0,
        message,
        finish_reason: over.finishReason ?? "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: over.inputTokens ?? 7,
      completion_tokens: over.outputTokens ?? 3,
      total_tokens: 10,
    },
  };
}

describe("buildOpenAIModelResponse", () => {
  test("maps finish_reason 'stop' to end_turn", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ content: "hi", finishReason: "stop" }),
    );
    expect(r.finishReason).toBe("end_turn");
    expect(r.content).toBe("hi");
  });

  test("maps finish_reason 'tool_calls' to tool_use", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ finishReason: "tool_calls" }),
    );
    expect(r.finishReason).toBe("tool_use");
  });

  test("maps finish_reason 'function_call' to tool_use (legacy)", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({
        finishReason:
          "function_call" as OpenAI.Chat.ChatCompletion.Choice["finish_reason"],
      }),
    );
    expect(r.finishReason).toBe("tool_use");
  });

  test("maps finish_reason 'length' to max_tokens", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ finishReason: "length" }),
    );
    expect(r.finishReason).toBe("max_tokens");
  });

  test("maps finish_reason 'content_filter' to end_turn", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ finishReason: "content_filter" }),
    );
    expect(r.finishReason).toBe("end_turn");
  });

  test("extracts token counts from usage", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ inputTokens: 100, outputTokens: 25 }),
    );
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(25);
  });

  test("extracts tool calls and parses arguments back to object", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: {
              name: "search",
              arguments: JSON.stringify({ q: "hello" }),
            },
          },
        ],
      }),
    );
    expect(r.toolCalls).toEqual([{ name: "search", arguments: { q: "hello" } }]);
  });

  test("handles missing tool_calls (returns undefined)", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ content: "no tools" }),
    );
    expect(r.toolCalls).toBeUndefined();
  });

  test("handles malformed tool arguments JSON (defaults to {})", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "x", arguments: "not json" },
          },
        ],
      }),
    );
    expect(r.toolCalls).toEqual([{ name: "x", arguments: {} }]);
  });

  test("throws on empty choices array (visible failure not silent empty turn)", () => {
    expect(() =>
      buildOpenAIModelResponse(mockCompletion({ emptyChoices: true })),
    ).toThrow(/returned no choices/);
  });

  test("empty-choices error includes model label", () => {
    expect(() =>
      buildOpenAIModelResponse(mockCompletion({ emptyChoices: true }), "gpt-5"),
    ).toThrow(/gpt-5/);
  });

  test("empty-choices error mentions content policy as likely cause", () => {
    expect(() =>
      buildOpenAIModelResponse(mockCompletion({ emptyChoices: true })),
    ).toThrow(/content-policy/);
  });

  test("treats null content as empty string", () => {
    const r = buildOpenAIModelResponse(
      mockCompletion({ content: null, finishReason: "tool_calls" }),
    );
    expect(r.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// SDK call payload assertions — uses the mocked openai module
// ---------------------------------------------------------------------------

describe("createOpenAIEngine — SDK call payload", () => {
  test("sends max_completion_tokens (NOT max_tokens)", async () => {
    const engine = createOpenAIEngine({ model: "gpt-5", maxTokens: 1024 });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.max_completion_tokens).toBe(1024);
    expect(lastCreateArgs?.max_tokens).toBeUndefined();
  });

  test("sends reasoning_effort at top level when set", async () => {
    const engine = createOpenAIEngine({
      model: "gpt-5",
      reasoningEffort: "high",
    });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.reasoning_effort).toBe("high");
  });

  test("omits reasoning_effort when not set", async () => {
    const engine = createOpenAIEngine({ model: "gpt-5" });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.reasoning_effort).toBeUndefined();
  });

  test("never sends stream: true (buffered only)", async () => {
    const engine = createOpenAIEngine({ model: "gpt-5" });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.stream).toBeUndefined();
  });

  test("omits tools when toolDefs is empty", async () => {
    const engine = createOpenAIEngine({ model: "gpt-5" });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.tools).toBeUndefined();
  });

  test("includes tools when toolDefs has entries", async () => {
    const engine = createOpenAIEngine({ model: "gpt-5" });
    await engine.complete(
      emptyPrompt({
        messages: [msg({ content: "hi" })],
        tools: [{ name: "t", description: "d", inputSchema: {} }],
      }),
    );
    const tools = lastCreateArgs?.tools as unknown[];
    expect(tools).toHaveLength(1);
  });

  test("propagates SDK errors wrapped with engine + model context", async () => {
    throwOnCreate = new Error("rate limited");
    const engine = createOpenAIEngine({ model: "gpt-5" });
    await expect(
      engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] })),
    ).rejects.toThrow("OpenAI engine (gpt-5) failed: rate limited");
  });

  test("preserves original SDK error as `cause`", async () => {
    const original = new Error("503 service unavailable");
    throwOnCreate = original;
    const engine = createOpenAIEngine({ model: "o3" });
    try {
      await engine.complete(
        emptyPrompt({ messages: [msg({ content: "hi" })] }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  test("countTokens uses char/4 approximation", () => {
    const engine = createOpenAIEngine({ model: "gpt-5" });
    expect(engine.countTokens("hello")).toBe(2);
    expect(engine.countTokens("")).toBe(0);
  });

  test("declares maxContextTokens default of 128_000", () => {
    const engine = createOpenAIEngine({ model: "gpt-5" });
    expect(engine.maxContextTokens).toBe(128_000);
  });

  test("declares custom maxContextTokens when provided", () => {
    const engine = createOpenAIEngine({
      model: "gpt-5",
      maxContextTokens: 200_000,
    });
    expect(engine.maxContextTokens).toBe(200_000);
  });

  test("passes baseURL to SDK constructor", async () => {
    createOpenAIEngine({
      model: "gpt-5",
      baseURL: "https://proxy.example.com/v1",
    });
    expect(lastConstructorArgs?.baseURL).toBe("https://proxy.example.com/v1");
  });

  test("passes apiKey to SDK constructor", async () => {
    createOpenAIEngine({ model: "gpt-5", apiKey: "sk-test" });
    expect(lastConstructorArgs?.apiKey).toBe("sk-test");
  });
});
