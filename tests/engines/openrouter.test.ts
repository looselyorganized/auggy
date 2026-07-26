import { describe, test, expect, mock, beforeEach } from "bun:test";
import type OpenAI from "openai";
import type { Message, AssembledPrompt } from "../../src/types";

// ---------------------------------------------------------------------------
// SDK mock — captures construction args + create() args
// ---------------------------------------------------------------------------

let lastCreateArgs: Record<string, unknown> | null = null;
let lastCreateOptions: { signal?: AbortSignal } | null = null;
let lastConstructorArgs: Record<string, unknown> | null = null;
let throwOnCreate: Error | null = null;
let nextResponse: OpenAI.Chat.ChatCompletion | null = null;
let providerDirectoryRequests = 0;
let createOverride: (() => Promise<OpenAI.Chat.ChatCompletion>) | null = null;
let createCalls = 0;

function providerDirectoryFetch(
  slugs: string[] = ["openai", "anthropic", "deepinfra"],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    providerDirectoryRequests += 1;
    expect(String(input)).toBe("https://openrouter.ai/api/v1/providers");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer sk-test",
    });
    return Response.json({ data: slugs.map((slug) => ({ slug })) });
  });
}

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
          options?: { signal?: AbortSignal },
        ): Promise<OpenAI.Chat.ChatCompletion> => {
          createCalls++;
          lastCreateArgs = params;
          lastCreateOptions = options ?? null;
          if (throwOnCreate) throw throwOnCreate;
          if (createOverride) return createOverride();
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

const { createOpenRouterEngine } = await import("@auggy/openrouter");

// Save / restore env between tests so the apiKey guard suite can manipulate it.
const ORIGINAL_OPENROUTER = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENAI = process.env.OPENAI_API_KEY;

beforeEach(() => {
  lastCreateArgs = null;
  lastCreateOptions = null;
  lastConstructorArgs = null;
  throwOnCreate = null;
  nextResponse = null;
  providerDirectoryRequests = 0;
  createOverride = null;
  createCalls = 0;
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
    expect(() => createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" })).toThrow(
      "OPENROUTER_API_KEY is not set",
    );
  });

  test("throws even when OPENAI_API_KEY is set (silent miswire prevention)", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-not-openrouter";
    expect(() => createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" })).toThrow(
      "OPENROUTER_API_KEY is not set",
    );
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
  test("sets one finite attempt and disables SDK retries", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      requestTimeoutMs: 45_000,
    });
    expect(lastConstructorArgs?.timeout).toBe(45_000);
    expect(lastConstructorArgs?.maxRetries).toBe(0);
  });

  test("uses OpenRouter baseURL by default", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    expect(lastConstructorArgs?.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  test("defaultHeaders includes X-Title", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    const headers = lastConstructorArgs?.defaultHeaders as Record<string, string>;
    expect(headers["X-Title"]).toBe("Auggy");
  });

  test("defaultHeaders does NOT include HTTP-Referer", () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    const headers = lastConstructorArgs?.defaultHeaders as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SDK call payload (extras shape)
// ---------------------------------------------------------------------------

describe("createOpenRouterEngine — SDK call payload", () => {
  test("does not query routing or dispatch when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller left", "AbortError"));
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
      providerRouting: { only: ["openai"] },
      providerDirectoryFetch: providerDirectoryFetch(),
    });
    await expect(engine.complete(emptyPrompt(), { signal: controller.signal })).rejects.toThrow();
    expect(providerDirectoryRequests).toBe(0);
    expect(lastCreateArgs).toBeNull();
  });

  test("forwards AbortSignal to the SDK request", async () => {
    const controller = new AbortController();
    createOverride = () => new Promise<OpenAI.Chat.ChatCompletion>(() => {});
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
    });
    const pending = engine.complete(emptyPrompt(), { signal: controller.signal });
    await Bun.sleep(0);
    expect(lastCreateOptions?.signal).toBeDefined();
    expect(lastCreateOptions?.signal).not.toBe(controller.signal);
    controller.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
    expect(lastCreateOptions?.signal?.aborted).toBe(true);
  });

  test("bounds the whole model completion and performs one ambiguous attempt", async () => {
    createOverride = () => new Promise<OpenAI.Chat.ChatCompletion>(() => {});
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
      requestTimeoutMs: 5,
    });

    await expect(engine.complete(emptyPrompt())).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
    });
    expect(createCalls).toBe(1);
    expect(lastCreateOptions?.signal?.aborted).toBe(true);
  });

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
      providerRouting: { only: ["openai"], sort: "price" },
      providerDirectoryFetch: providerDirectoryFetch(),
    });
    await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(lastCreateArgs?.provider).toEqual({
      only: ["openai"],
      sort: "price",
      allow_fallbacks: false,
    });
    expect(providerDirectoryRequests).toBe(1);
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

  test("rejects an unknown restrictive provider before model execution", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      providerRouting: { only: ["openai", "openaii"] },
      providerDirectoryFetch: providerDirectoryFetch(),
    });

    await expect(engine.complete(emptyPrompt())).rejects.toThrow(
      "OpenRouter provider allowlist could not be verified",
    );
    expect(lastCreateArgs).toBeNull();
  });

  test("fails closed when the authoritative directory is unavailable", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      providerRouting: { only: ["openai"] },
      providerDirectoryFetch: mock(async () => new Response("", { status: 503 })),
    });

    await expect(engine.complete(emptyPrompt())).rejects.toThrow(
      "OpenRouter provider allowlist could not be verified",
    );
    expect(lastCreateArgs).toBeNull();
  });

  test("redacts directory failures and credentials from the exposed error", async () => {
    const sentinel = "sk-directory-sentinel-do-not-leak";
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: sentinel,
      providerRouting: { only: ["openai"] },
      providerDirectoryFetch: mock(async () => {
        throw new Error(`request failed with ${sentinel}`);
      }),
    });

    try {
      await engine.complete(emptyPrompt());
      throw new Error("expected provider verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "OpenRouter provider allowlist could not be verified; no model request was sent",
      );
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(String(error)).not.toContain(sentinel);
    }
    expect(lastCreateArgs).toBeNull();
  });

  test("fails closed on redirects and malformed authoritative responses", async () => {
    for (const response of [
      Response.redirect("https://attacker.example/providers"),
      Response.json({ data: [{ name: "OpenAI" }] }),
      Response.json({ data: [] }),
    ]) {
      const engine = createOpenRouterEngine({
        model: "qwen/qwen3.5-397b-a17b",
        providerRouting: { only: ["openai"] },
        providerDirectoryFetch: mock(async () => response.clone() as unknown as Response),
      });

      await expect(engine.complete(emptyPrompt())).rejects.toThrow(
        "OpenRouter provider allowlist could not be verified",
      );
      expect(lastCreateArgs).toBeNull();
    }
  });

  test("fails closed before parsing an oversized provider directory", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
      providerRouting: { only: ["openai"] },
      providerDirectoryFetch: mock(
        async () =>
          new Response(JSON.stringify({ data: [{ slug: "openai" }] }), {
            headers: { "Content-Length": String(256 * 1024 + 1) },
          }),
      ),
    });

    await expect(engine.complete(emptyPrompt())).rejects.toThrow(
      "OpenRouter provider allowlist could not be verified",
    );
    expect(lastCreateArgs).toBeNull();
  });

  test("validates denylist slugs authoritatively without changing fallback policy", async () => {
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
      providerRouting: { ignore: ["anthropic"], sort: "latency" },
      providerDirectoryFetch: providerDirectoryFetch(),
    });

    await engine.complete(emptyPrompt());
    expect(lastCreateArgs?.provider).toEqual({
      ignore: ["anthropic"],
      sort: "latency",
    });
    expect(providerDirectoryRequests).toBe(1);
  });

  test("rejects malformed and duplicate restrictive slugs for direct callers", () => {
    for (const only of [
      [""],
      [" openai"],
      ["OpenAI"],
      ["openai", "openai"],
      ["deepinfra/turbo"],
      ["openai%2fother"],
    ]) {
      expect(() =>
        createOpenRouterEngine({
          model: "qwen/qwen3.5-397b-a17b",
          apiKey: "sk-test",
          providerRouting: { only },
          providerDirectoryFetch: providerDirectoryFetch(),
        }),
      ).toThrow("providerRouting.only");
    }
  });

  test("restrictive validation follows caller cancellation", async () => {
    const controller = new AbortController();
    const directoryFetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
      providerRouting: { only: ["openai"] },
      providerDirectoryFetch: directoryFetch,
    });

    const pending = engine.complete(emptyPrompt(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(lastCreateArgs).toBeNull();
  });

  test("restrictive validation obeys a shorter call-level deadline", async () => {
    let directorySignal: AbortSignal | undefined;
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      apiKey: "sk-test",
      requestTimeoutMs: 5,
      providerRouting: { only: ["openai"] },
      providerDirectoryFetch: mock((_input: string | URL | Request, init?: RequestInit) => {
        directorySignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    });

    await expect(engine.complete(emptyPrompt())).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
    });
    expect(directorySignal?.aborted).toBe(true);
    expect(lastCreateArgs).toBeNull();
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

  test("wraps SDK errors with stable engine + model context", async () => {
    throwOnCreate = new Error("upstream provider down");
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    await expect(
      engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] })),
    ).rejects.toThrow("OpenRouter engine (qwen/qwen3.5-397b-a17b) request failed.");
  });

  test("discards the original SDK error cause", async () => {
    const original = new Error("502 bad gateway");
    throwOnCreate = original;
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    try {
      await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(Bun.inspect(err)).not.toContain(original.message);
    }
  });

  test("empty choices from OpenRouter throws via shared buildOpenAIModelResponse", async () => {
    // Override the default response with an empty choices array.
    const originalCreate = throwOnCreate;
    // We can't easily re-stub the per-call response with this mock setup,
    // so we test buildOpenAIModelResponse directly with the openrouter label
    // — same code path as called from createOpenRouterEngine.
    const { buildOpenAIModelResponse } = await import("@auggy/openai");
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
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
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

// ---------------------------------------------------------------------------
// createOpenRouterEngine — costUsd population (slug-aware routing)
// ---------------------------------------------------------------------------

function mockCompletionWithTokens(
  inputTokens: number,
  outputTokens: number,
  model = "test-model",
): OpenAI.Chat.ChatCompletion {
  return {
    id: "chatcmpl-cost-test",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok", refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

describe("createOpenRouterEngine — costUsd", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  test("routes-to-anthropic slug populates costUsd", async () => {
    // anthropic/claude-sonnet-4-6 → lookupPricing("anthropic", "claude-sonnet-4-6")
    // $3.00/Mtok in, $15.00/Mtok out; 200 in + 100 out → 0.0006 + 0.0015 = 0.0021 USD
    nextResponse = mockCompletionWithTokens(200, 100, "anthropic/claude-sonnet-4-6");
    const engine = createOpenRouterEngine({ model: "anthropic/claude-sonnet-4-6" });
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.0021, 8);
  });

  test("routes-to-openai slug populates costUsd", async () => {
    // openai/gpt-5 → lookupPricing("openai", "gpt-5")
    // $5.00/Mtok in, $20.00/Mtok out; 400 in + 200 out → 0.002 + 0.004 = 0.006 USD
    nextResponse = mockCompletionWithTokens(400, 200, "openai/gpt-5");
    const engine = createOpenRouterEngine({ model: "openai/gpt-5" });
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.006, 8);
  });

  test("unknown provider slug leaves costUsd undefined", async () => {
    // qwen/qwen3.5-397b-a17b — no "qwen" provider in pricing tables
    nextResponse = mockCompletionWithTokens(100, 50, "qwen/qwen3.5-397b-a17b");
    const engine = createOpenRouterEngine({ model: "qwen/qwen3.5-397b-a17b" });
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(result.costUsd).toBeUndefined();
  });

  test("slug with no slash leaves costUsd undefined (openrouter table is empty)", async () => {
    nextResponse = mockCompletionWithTokens(100, 50, "somemodel");
    const engine = createOpenRouterEngine({ model: "somemodel" });
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(result.costUsd).toBeUndefined();
  });

  test("costOverride populates costUsd for unknown provider slug", async () => {
    // qwen/qwen3.5 is unknown in pricing table; costOverride should be used
    // $4/Mtok in, $16/Mtok out; 250 input + 125 output → 0.001 + 0.002 = 0.003
    nextResponse = mockCompletionWithTokens(250, 125, "qwen/qwen3.5-397b-a17b");
    const engine = createOpenRouterEngine({
      model: "qwen/qwen3.5-397b-a17b",
      costOverride: { inputUsdPerMtok: 4, outputUsdPerMtok: 16 },
    });
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(result.costUsd).toBeCloseTo(0.003, 8);
  });

  test("costOverride takes precedence over slug-routed pricing-table entry", async () => {
    // anthropic/claude-sonnet-4-6 resolves to $3/$15 in the table; costOverride wins ($2/$6)
    // 600 input + 300 output → (600/1e6)*2 + (300/1e6)*6 = 0.0012 + 0.0018 = 0.003
    nextResponse = mockCompletionWithTokens(600, 300, "anthropic/claude-sonnet-4-6");
    const engine = createOpenRouterEngine({
      model: "anthropic/claude-sonnet-4-6",
      costOverride: { inputUsdPerMtok: 2, outputUsdPerMtok: 6 },
    });
    const result = await engine.complete(emptyPrompt({ messages: [msg({ content: "hi" })] }));
    expect(result.costUsd).toBeCloseTo(0.003, 8);
  });

  test("fails missing or malformed usage closed as unpriced", async () => {
    const invalidUsage: unknown[] = [
      undefined,
      "not-an-object",
      { prompt_tokens: -1, completion_tokens: 5 },
      { prompt_tokens: 10, completion_tokens: Number.NaN },
    ];

    for (const usage of invalidUsage) {
      nextResponse = {
        ...defaultResponse(),
        usage,
      } as unknown as OpenAI.Chat.ChatCompletion;
      const result = await createOpenRouterEngine({
        apiKey: "sk-test",
        model: "openai/gpt-5",
      }).complete(emptyPrompt());
      expect(result.costUsd).toBeUndefined();
      expect(result.unpricedReason).toBe("Provider returned invalid accounting metadata.");
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    }
  });
});

describe("createOpenRouterEngine — credential-safe errors", () => {
  test("discards provider-echoed credentials from messages and causes", async () => {
    const sentinel = "openrouter-secret-sentinel";
    throwOnCreate = Object.assign(new Error(`upstream echoed ${sentinel}`), { status: 403 });
    const engine = createOpenRouterEngine({
      apiKey: sentinel,
      model: "qwen/qwen3.5-397b-a17b",
    });

    const error = await engine.complete(emptyPrompt()).catch((caught) => caught);
    expect(String(error)).toContain("OpenRouter engine");
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain(sentinel);
    expect(Bun.inspect(error)).not.toContain(sentinel);
    expect((error as Error).cause).toBeUndefined();
    expect((error as { status?: number }).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// createOpenRouterEngine — startup warnings
// ---------------------------------------------------------------------------

describe("createOpenRouterEngine — startup warnings", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  test("logs a warning mentioning 'anthropic/* and openai/*' for unknown provider slug", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      createOpenRouterEngine({ model: "qwen/qwen-7b" });
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      // Warning must call out the v0 scope limitation explicitly.
      expect(warnings.some((w) => w.includes("anthropic/* and openai/*"))).toBe(true);
      expect(warnings.some((w) => w.includes("qwen/qwen-7b"))).toBe(true);
      // Warning should NOT reference old _shared/pricing.ts
      expect(warnings.some((w) => w.includes("_shared/pricing.ts"))).toBe(false);
    } finally {
      console.warn = original;
    }
  });

  test("logs a warning for deepseek/* slug (unknown provider)", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      createOpenRouterEngine({ model: "deepseek/deepseek-r2" });
      expect(warnings.some((w) => w.includes("anthropic/* and openai/*"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  test("does NOT warn when costOverride is set, even for an unknown slug", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      createOpenRouterEngine({
        model: "qwen/qwen-7b",
        costOverride: { inputUsdPerMtok: 0.1, outputUsdPerMtok: 0.3 },
      });
      const pricingWarnings = warnings.filter(
        (w) =>
          w.includes("anthropic/* and openai/*") ||
          w.includes("No pricing entry") ||
          w.includes("Pricing table verifiedAt"),
      );
      expect(pricingWarnings).toHaveLength(0);
    } finally {
      console.warn = original;
    }
  });
});

describe("createOpenRouterEngine — response limits", () => {
  test("injects the bounded transport into the SDK", () => {
    createOpenRouterEngine({
      apiKey: "sk-test",
      model: "qwen/qwen3.5-397b-a17b",
      costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
    });
    expect(typeof lastConstructorArgs?.fetch).toBe("function");
  });

  test("fails a completed oversized response as a whole and retains accounting", async () => {
    const response = defaultResponse();
    nextResponse = {
      ...response,
      choices: [
        {
          ...response.choices[0]!,
          message: {
            ...response.choices[0]!.message,
            content: "oversized",
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
    };
    const engine = createOpenRouterEngine({
      apiKey: "sk-test",
      model: "qwen/qwen3.5-397b-a17b",
      costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
      responseLimits: { maxTextBytes: 4 },
    });

    const error = await engine.complete(emptyPrompt()).catch((cause) => cause);
    expect(error).toMatchObject({
      name: "ModelResponseLimitError",
      limit: "maxTextBytes",
      accounting: {
        inputTokens: 200,
        outputTokens: 100,
      },
    });
    expect(error.accounting.costUsd).toBeCloseTo(0.0004, 8);
  });

  test("retains valid usage when an empty-choice completion fails", async () => {
    nextResponse = {
      ...mockCompletionWithTokens(200, 100, "openai/gpt-5"),
      id: "sentinel-provider-id",
      choices: [],
    };
    const engine = createOpenRouterEngine({
      apiKey: "sk-test",
      model: "openai/gpt-5",
    });

    const error = await engine.complete(emptyPrompt()).catch((cause) => cause);

    expect(error).toMatchObject({
      name: "ModelResponseLimitError",
      accounting: { inputTokens: 200, outputTokens: 100 },
    });
    expect(error.accounting.costUsd).toBeCloseTo(0.003, 8);
    expect(error.message).not.toContain("sentinel-provider-id");
  });
});
