import { describe, test, expect, mock, beforeEach } from "bun:test";
import type OpenAI from "openai";
import type { Message, AssembledPrompt } from "../../src/types";

// ---------------------------------------------------------------------------
// SDK mock — captures construction args + create() args
// ---------------------------------------------------------------------------

let lastCreateArgs: Record<string, unknown> | null = null;
let lastConstructorArgs: Record<string, unknown> | null = null;
let throwOnCreate: Error | null = null;

const defaultResponse = (): OpenAI.Chat.ChatCompletion => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 0,
  model: "qwen/qwen3.5-397b-a17b",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok", refusal: null },
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
          return defaultResponse();
        },
      },
    };
    constructor(opts: Record<string, unknown>) {
      lastConstructorArgs = opts;
    }
  }
  return { default: FakeOpenAI };
});

const { createOpenRouterEngine } = await import(
  "../../src/engines/openrouter"
);

// Save / restore env between tests so the apiKey guard suite can manipulate it.
const ORIGINAL_OPENROUTER = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENAI = process.env.OPENAI_API_KEY;

beforeEach(() => {
  lastCreateArgs = null;
  lastConstructorArgs = null;
  throwOnCreate = null;
  // Restore env to original values before each test.
  if (ORIGINAL_OPENROUTER === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  if (ORIGINAL_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI;
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
// apiKey guard — the M5 risk regression suite
// ---------------------------------------------------------------------------

describe("createOpenRouterEngine — apiKey guard", () => {
  test("throws when neither opts.apiKey nor env is set", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(() =>
      createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" }),
    ).toThrow("OPENROUTER_API_KEY is not set");
  });

  test("throws even when OPENAI_API_KEY is set (silent miswire prevention)", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-not-openrouter";
    expect(() =>
      createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" }),
    ).toThrow("OPENROUTER_API_KEY is not set");
  });

  test("uses opts.apiKey when explicitly provided (overrides env)", () => {
    process.env.OPENROUTER_API_KEY = "sk-from-env";
    createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-explicit",
    });
    expect(lastConstructorArgs?.apiKey).toBe("sk-explicit");
  });

  test("falls back to OPENROUTER_API_KEY when opts.apiKey absent", () => {
    process.env.OPENROUTER_API_KEY = "sk-from-env";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    expect(lastConstructorArgs?.apiKey).toBe("sk-from-env");
  });
});

// ---------------------------------------------------------------------------
// SDK construction (baseURL, defaultHeaders)
// ---------------------------------------------------------------------------

describe("createOpenRouterEngine — SDK construction", () => {
  test("uses OpenRouter baseURL by default", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    expect(lastConstructorArgs?.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  test("defaultHeaders includes X-Title", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    const headers = lastConstructorArgs?.defaultHeaders as Record<
      string,
      string
    >;
    expect(headers["X-Title"]).toBe("Auggy");
  });

  test("defaultHeaders does NOT include HTTP-Referer", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    const headers = lastConstructorArgs?.defaultHeaders as Record<
      string,
      string
    >;
    expect(headers["HTTP-Referer"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SDK call payload (extras shape)
// ---------------------------------------------------------------------------

describe("createOpenRouterEngine — SDK call payload", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  test("sends max_completion_tokens (NOT max_tokens)", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      maxTokens: 2048,
    });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.max_completion_tokens).toBe(2048);
    expect(lastCreateArgs?.max_tokens).toBeUndefined();
  });

  test("reasoning serialized into reasoning.effort (not reasoning_effort)", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      reasoningEffort: "high",
    });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.reasoning).toEqual({ effort: "high" });
    expect(lastCreateArgs?.reasoning_effort).toBeUndefined();
  });

  test("provider routing serialized into provider field", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      providerRouting: { only: ["OpenAI"], sort: "price" },
    });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.provider).toEqual({
      only: ["OpenAI"],
      sort: "price",
    });
  });

  test("combined reasoning + routing both appear in params", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      reasoningEffort: "medium",
      providerRouting: { sort: "throughput" },
    });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.reasoning).toEqual({ effort: "medium" });
    expect(lastCreateArgs?.provider).toEqual({ sort: "throughput" });
  });

  test("neither reasoning nor provider in params when neither option set", async () => {
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.reasoning).toBeUndefined();
    expect(lastCreateArgs?.provider).toBeUndefined();
  });

  test("never sends stream: true (buffered only)", async () => {
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.stream).toBeUndefined();
  });

  test("propagates SDK errors wrapped with engine + model context", async () => {
    throwOnCreate = new Error("upstream provider down");
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    await expect(
      engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] })),
    ).rejects.toThrow(
      "OpenRouter engine (qwen/qwen3.5-397b-a17b) failed: upstream provider down",
    );
  });

  test("preserves original SDK error as `cause`", async () => {
    const original = new Error("502 bad gateway");
    throwOnCreate = original;
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    try {
      await engine.complete(
        emptyPrompt({ messages: [msg({ content: "hi" })] }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { cause?: unknown }).cause).toBe(original);
    }
  });

  test("empty choices from OpenRouter throws via shared buildOpenAIModelResponse", async () => {
    // Override the default response with an empty choices array.
    const originalCreate = throwOnCreate;
    // We can't easily re-stub the per-call response with this mock setup,
    // so we test buildOpenAIModelResponse directly with the openrouter label
    // — same code path as called from createOpenRouterEngine.
    const { buildOpenAIModelResponse } = await import(
      "../../src/engines/openai"
    );
    expect(() =>
      buildOpenAIModelResponse(
        {
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "qwen/qwen3.5-397b-a17b",
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        "openrouter:qwen/qwen3.5-397b-a17b",
      ),
    ).toThrow(/openrouter:qwen\/qwen3\.5-397b-a17b/);
    void originalCreate;
  });

  test("response shape parses through buildOpenAIModelResponse correctly", async () => {
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    const result = await engine.complete(
      emptyPrompt({ messages: [msg({ content: "hi" })] }),
    );
    expect(result.content).toBe("ok");
    expect(result.finishReason).toBe("end_turn");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Defaults and interface shape
// ---------------------------------------------------------------------------

describe("createOpenRouterEngine — defaults", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  test("declares maxContextTokens default of 128_000", () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
    });
    expect(engine.maxContextTokens).toBe(128_000);
  });

  test("declares custom maxContextTokens when provided", () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      maxContextTokens: 262_000,
    });
    expect(engine.maxContextTokens).toBe(262_000);
  });

  test("countTokens uses char/4 approximation", () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
    });
    expect(engine.countTokens("hello world")).toBe(3);
  });

  test("returns ModelClient interface shape", () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
    });
    expect(typeof engine.complete).toBe("function");
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.maxContextTokens).toBe("number");
  });
});
