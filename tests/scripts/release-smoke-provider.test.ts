import { afterEach, describe, expect, test } from "bun:test";
import { createAnthropicEngine } from "../../packages/anthropic/src";
import type { AssembledPrompt, Message } from "../../src/types";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_ANSWER_TEXT,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
  type ProviderFixture,
  type ProviderFixtureOptions,
} from "../../scripts/release-smoke/provider-fixture";

const SENTINEL = "fixture-file-result-7a26";
const PATH = "workspace/acceptance.txt";
const fixtures: ProviderFixture[] = [];

function fixture(options: Partial<ProviderFixtureOptions> = {}): ProviderFixture {
  const result = createProviderFixture({ toolResultSentinel: SENTINEL, ...options });
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.stop()));
});

function requestBody(
  stream = false,
  messages: unknown[] = [{ role: "user", content: "Read file." }],
) {
  return {
    model: "claude-sonnet-4-6",
    stream,
    max_tokens: 256,
    tools: [
      {
        name: "fs_read",
        description: "Read a mounted file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    messages,
  };
}

function resultMessages(
  content = SENTINEL,
  path: string | number = PATH,
  resultId = "kernel-call",
) {
  return [
    { role: "user", content: "Read file." },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "kernel-call", name: "fs_read", input: { path } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: resultId, content }] },
  ];
}

function post(server: ProviderFixture, body: unknown, key = PROVIDER_FIXTURE_API_KEY) {
  return fetch(`${server.baseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
}

describe("packed release Anthropic provider fixture", () => {
  test.each([false, true])(
    "answer-only scenario needs no tools and responds once (stream=%s)",
    async (stream) => {
      const server = fixture({ scenario: "answer-only" });
      const body = { ...requestBody(stream), tools: [] };
      const response = await post(server, body);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(PROVIDER_FIXTURE_ANSWER_TEXT);
      expect(text).not.toContain("tool_use");
      expect(server.evidence()).toMatchObject({
        calls: 1,
        toolRequests: 0,
        validatedToolResults: 0,
        finalResponses: 1,
        rejectedRequests: 0,
      });
      expect((await post(server, body)).status).toBe(400);
    },
  );

  test("explicit application tool runs through the real adapter with exact nested input validation", async () => {
    const input = { id: "order-17", options: { include: ["status", "total"], currency: "USD" } };
    const server = fixture({ tool: { name: "orders_lookup", input, invalidInput: { id: 17 } } });
    input.id = "mutated-after-start";
    const model = createAnthropicEngine({
      model: "claude-sonnet-4-6",
      apiKey: PROVIDER_FIXTURE_API_KEY,
      baseURL: server.baseURL,
      costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
      requestTimeoutMs: 2_000,
    });
    const message = (role: Message["role"], content: string, toolCallId?: string): Message => ({
      id: crypto.randomUUID(),
      role,
      content,
      ...(toolCallId ? { toolCallId } : {}),
      timestamp: 1,
      tokenCount: 1,
    });
    const prompt: AssembledPrompt = {
      systemBlocks: [],
      contextBlocks: [],
      totalTokens: 1,
      evictions: [],
      messages: [message("user", "Lookup the fixture order.")],
      tools: [
        { name: "orders_lookup", description: "Fixture lookup", inputSchema: { type: "object" } },
      ],
    };
    const first = await model.complete(prompt);
    expect(first.toolCalls).toEqual([
      {
        name: "orders_lookup",
        arguments: { id: "order-17", options: { currency: "USD", include: ["status", "total"] } },
      },
    ]);
    prompt.messages.push(
      message("tool_use", JSON.stringify(first.toolCalls![0]), "custom-call"),
      message("tool_result", SENTINEL, "custom-call"),
    );
    expect((await model.complete(prompt)).content).toBe(PROVIDER_FIXTURE_FINAL_TEXT);
    expect(server.evidence()).toMatchObject({
      calls: 2,
      validatedToolResults: 1,
      rejectedRequests: 0,
    });
  });

  test("explicit invalid input and wrong returned custom tool cannot manufacture a successful result", async () => {
    const server = fixture({
      scenario: "invalid-tool-arguments",
      maxCalls: 8,
      tool: { name: "orders_lookup", input: { id: "17" }, invalidInput: { id: 17 } },
    });
    const initial = {
      ...requestBody(),
      tools: [{ name: "orders_lookup", input_schema: { type: "object" } }],
    };
    expect(await (await post(server, initial)).json()).toMatchObject({
      content: [{ name: "orders_lookup", input: { id: 17 } }],
    });
    const messages = (name: string, id: string | number, content: string) => [
      { role: "assistant", content: [{ type: "tool_use", name, id: "custom-id", input: { id } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "custom-id", content }] },
    ];
    for (const values of [
      messages("wrong_tool", 17, "Validation error: id"),
      messages("orders_lookup", "17", "Validation error: id"),
      messages("orders_lookup", 17, SENTINEL),
    ]) {
      expect((await post(server, { ...initial, messages: values })).status).toBe(400);
    }
    expect(
      (
        await post(server, {
          ...initial,
          messages: messages("orders_lookup", 17, "Validation error: id"),
        })
      ).status,
    ).toBe(200);
    expect(server.evidence().summaries.at(-1)?.outcome).toBe("verified-validation-error");
  });

  test("rejects ambiguous, non-JSON and indistinguishable custom scenarios before listening", () => {
    const tool = { name: "orders_lookup", input: { id: "17" }, invalidInput: { id: 17 } };
    expect(() => fixture({ tool, toolPath: "workspace/test" })).toThrow("cannot both");
    expect(() => fixture({ tool: { ...tool, input: { nested: undefined } } })).toThrow(
      "finite JSON",
    );
    expect(() => fixture({ tool: { ...tool, invalidInput: { id: "17" } } })).toThrow("differ");
    expect(() => fixture({ tool: { ...tool, name: "../escape" } })).toThrow("tool name");
  });

  test.each([false, true])(
    "works through the real Anthropic adapter (streaming=%s)",
    async (streaming) => {
      const server = fixture();
      const model = createAnthropicEngine({
        model: "claude-sonnet-4-6",
        apiKey: PROVIDER_FIXTURE_API_KEY,
        baseURL: server.baseURL,
        costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
        requestTimeoutMs: 2_000,
      });
      const message = (role: Message["role"], content: string, toolCallId?: string): Message => ({
        id: crypto.randomUUID(),
        role,
        content,
        ...(toolCallId ? { toolCallId } : {}),
        timestamp: 1,
        tokenCount: 1,
      });
      const prompt: AssembledPrompt = {
        systemBlocks: [],
        contextBlocks: [],
        messages: [message("user", "Read file.")],
        tools: [
          {
            name: "fs_read",
            description: "Read file.",
            inputSchema: requestBody().tools[0]!.input_schema,
          },
        ],
        totalTokens: 1,
        evictions: [],
      };
      const deltas: string[] = [];
      const options = streaming
        ? {
            onDelta: (delta: { kind: string; text?: string }) => {
              if (delta.kind === "text_delta" && delta.text) deltas.push(delta.text);
            },
          }
        : undefined;
      const first = await model.complete(prompt, options);
      expect(first.toolCalls).toEqual([{ name: "fs_read", arguments: { path: PATH } }]);
      prompt.messages.push(
        message("tool_use", JSON.stringify(first.toolCalls![0]), "kernel-adapter-call"),
        message("tool_result", SENTINEL, "kernel-adapter-call"),
      );
      const second = await model.complete(prompt, options);
      expect(second.content).toBe(PROVIDER_FIXTURE_FINAL_TEXT);
      expect(second.finishReason).toBe("end_turn");
      if (streaming) expect(deltas.join("")).toBe(PROVIDER_FIXTURE_FINAL_TEXT);
      expect(server.evidence().validatedToolResults).toBe(1);
    },
  );

  test("buffers a tool request then requires its returned result before the final answer", async () => {
    const server = fixture();
    expect(new URL(server.baseURL).hostname).toBe("127.0.0.1");
    expect(JSON.parse(JSON.stringify(server.ready))).toEqual({
      type: "provider-fixture-ready",
      baseURL: server.baseURL,
    });
    const first = await post(server, requestBody());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      content: [{ type: "tool_use", name: "fs_read", input: { path: PATH } }],
      stop_reason: "tool_use",
    });
    expect(server.evidence().finalResponses).toBe(0);
    const second = await post(server, requestBody(false, resultMessages()));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      content: [{ type: "text", text: PROVIDER_FIXTURE_FINAL_TEXT }],
      stop_reason: "end_turn",
    });
    expect(server.evidence()).toMatchObject({
      calls: 2,
      toolRequests: 1,
      validatedToolResults: 1,
      finalResponses: 1,
      rejectedRequests: 0,
    });
    expect((await post(server, requestBody())).status).toBe(400);
  });

  test("serves a finite Anthropic SSE sequence for tool arguments and final text", async () => {
    const server = fixture();
    const first = await post(server, requestBody(true));
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    const firstText = await first.text();
    const events = firstText
      .trim()
      .split("\n\n")
      .map((event) => JSON.parse(event.split("\ndata: ")[1]!));
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[2].delta).toEqual({
      type: "input_json_delta",
      partial_json: JSON.stringify({ path: PATH }),
    });
    expect(events[4]).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    });
    const second = await post(server, requestBody(true, resultMessages()));
    expect(await second.text()).toContain(PROVIDER_FIXTURE_FINAL_TEXT);
    expect(server.evidence().summaries.every((summary) => summary.streaming)).toBe(true);
  });

  test.each([
    ["missing result", [{ role: "user", content: SENTINEL }]],
    ["wrong returned tool ID", resultMessages(SENTINEL, PATH, "wrong-call")],
    ["wrong tool path", resultMessages(SENTINEL, "workspace/other.txt")],
    ["missing sentinel", resultMessages("unrelated file content")],
  ])("rejects %s instead of manufacturing a successful turn", async (_name, messages) => {
    const server = fixture();
    await post(server, requestBody());
    const response = await post(server, requestBody(false, messages as unknown[]));
    expect(response.status).toBe(400);
    expect(server.evidence().finalResponses).toBe(0);
    expect(server.evidence().validatedToolResults).toBe(0);
  });

  test("invalid arguments must return validation failure without the file sentinel", async () => {
    const server = fixture({ scenario: "invalid-tool-arguments" });
    const first = await post(server, requestBody());
    expect(await first.json()).toMatchObject({ content: [{ input: { path: 17 } }] });
    const successfulSideEffect = await post(
      server,
      requestBody(false, resultMessages(SENTINEL, 17)),
    );
    expect(successfulSideEffect.status).toBe(400);
    const rejected = await post(
      server,
      requestBody(false, resultMessages("Validation error: invalid path", 17)),
    );
    expect(rejected.status).toBe(200);
    expect(server.evidence().summaries.at(-1)?.outcome).toBe("verified-validation-error");
  });

  test("provider failure remains an error and reset isolates restart/replay evidence", async () => {
    const server = fixture({ scenario: "provider-failure" });
    const failure = await post(server, requestBody(true));
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({ error: { type: "overloaded_error" } });
    expect(server.evidence()).toMatchObject({ calls: 1, toolRequests: 0, finalResponses: 0 });
    server.setScenario("success");
    expect(server.evidence()).toMatchObject({
      scenario: "success",
      generation: 2,
      calls: 0,
      summaries: [],
    });
    await post(server, requestBody());
    await post(server, requestBody(false, resultMessages()));
    const snapshot = server.evidence();
    snapshot.summaries.length = 0;
    expect(server.evidence().summaries).toHaveLength(2);
    server.reset();
    expect(server.evidence()).toMatchObject({
      scenario: "success",
      generation: 3,
      calls: 0,
      summaries: [],
    });
  });

  test("rejects unauthorized requests without storing credentials or request contents", async () => {
    const server = fixture();
    const secret = "never-log-request-credential";
    expect((await post(server, requestBody(), secret)).status).toBe(401);
    expect(server.evidence()).toMatchObject({ calls: 0, rejectedRequests: 1 });
    const text = JSON.stringify(server.evidence());
    expect(text).not.toContain(secret);
    expect(text).not.toContain(PROVIDER_FIXTURE_API_KEY);
    expect(text).not.toContain(SENTINEL);
    expect((await fetch(`${server.baseURL}/control/reset`)).status).toBe(404);
  });

  test("bounds calls, body size, and retained evidence", async () => {
    const server = fixture({ maxCalls: 1, maxRequestBytes: 512 });
    expect((await post(server, { model: "test", messages: ["x".repeat(1_024)] })).ok).toBe(false);
    expect((await post(server, requestBody())).status).toBe(200);
    for (let index = 0; index < 4; index++) {
      expect((await post(server, requestBody())).status).toBe(429);
    }
    expect(server.evidence().summaries.length).toBeLessThanOrEqual(2);
    expect(server.evidence().finalResponses).toBe(0);
  });

  test("validates configuration and stops idempotently", async () => {
    expect(() => createProviderFixture({ toolResultSentinel: "" })).toThrow("sentinel");
    expect(() => createProviderFixture({ toolResultSentinel: SENTINEL, maxCalls: 0 })).toThrow(
      "call limit",
    );
    const server = fixture();
    await server.stop();
    await server.stop();
    expect(() => server.reset()).toThrow("stopped");
  });
});
