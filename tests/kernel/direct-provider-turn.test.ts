import { expect, test } from "bun:test";
import { z } from "zod";
import { createAnthropicEngine } from "@auggy/anthropic";
import { createOpenAIEngine } from "@auggy/openai";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createTokenizer } from "@/tokenizer";
import type { TurnTrigger, ModelClient } from "@/types";

const ids = ["native_first", "native_second"];
const opaque = "provider-private-signature";
const usage = { input_tokens: 100, output_tokens: 10 };

function openAIReply(final: boolean) {
  return Response.json({
    id: "resp_test",
    status: "completed",
    service_tier: "default",
    usage: {
      ...usage,
      input_tokens_details: {
        cached_tokens: 20,
        cache_write_tokens: 10,
        cache_write_tokens_details: { ttl_30m_tokens: 4, ttl_12h_tokens: 6 },
      },
      output_tokens_details: { reasoning_tokens: 8 },
    },
    output: final
      ? [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Finished" }],
          },
        ]
      : [
          { type: "reasoning", id: "rs_test", summary: [], encrypted_content: opaque },
          ...ids.map((id, index) => ({
            type: "function_call",
            id: `fc_${index}`,
            call_id: id,
            name: "lookup",
            arguments: JSON.stringify({ value: index }),
          })),
        ],
  });
}

function claudeReply(final: boolean) {
  const blocks = final
    ? [{ type: "text", text: "Finished" }]
    : [
        { type: "thinking", thinking: "", signature: opaque },
        ...ids.map((id, value) => ({ type: "tool_use", id, name: "lookup", input: { value } })),
      ];
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        role: "assistant",
        type: "message",
        content: [],
        usage: {
          ...usage,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
          service_tier: "standard",
        },
      },
    },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: final ? "end_turn" : "tool_use" },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function trigger(): TurnTrigger {
  const peer = {
    id: "tester",
    kind: "human" as const,
    trustLevel: "agent" as const,
    sourceAugment: "test",
  };
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    timestamp: 0,
    source: "test",
    peer,
    payload: {
      parts: [{ kind: "text", text: "Look them up" }],
      sourceAugment: "test",
      peer,
      timestamp: 0,
    },
  };
}

for (const [model, cost] of [
  ["gpt-6.2-astra", (70 * 8 + 20 * 0.4 + 4 * 10 + 6 * 20 + 10 * 40) / 1e6],
  ["gpt-6.2-sol", (70 * 2 + 20 * 0.1 + 4 * 2.5 + 6 * 5 + 10 * 10) / 1e6],
  ["claude-fable-5-2", (100 * 8 + 20 * 0.2 + 4 * 10 + 6 * 16 + 10 * 40) / 1e6],
  ["claude-opus-5", (100 * 5 + 20 * 0.5 + 4 * 6.25 + 6 * 10 + 10 * 25) / 1e6],
] as const) {
  test(`${model} carries two tool results through the SDK and prices each inference`, async () => {
    const openai = model.startsWith("gpt-");
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const original = globalThis.fetch;
    let engine: ModelClient;
    try {
      globalThis.fetch = (async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push({
          path: new URL(request.url).pathname,
          body: (await request.json()) as Record<string, unknown>,
        });
        return openai ? openAIReply(requests.length > 1) : claudeReply(requests.length > 1);
      }) as typeof fetch;
      engine = (openai ? createOpenAIEngine : createAnthropicEngine)({ model, apiKey: "fixture" });
    } finally {
      globalThis.fetch = original;
    }
    const executed: number[] = [];
    const loop = createTurnLoop({
      model: engine,
      tokenizer: createTokenizer(),
      config: { name: "direct", model, augments: [] },
      augments: [
        {
          name: "orders",
          tools: [
            {
              name: "lookup",
              description: "Look up an order",
              category: "meta",
              input: z.object({ value: z.number() }),
              execute: async ({ value }) => {
                executed.push(value);
                return `order ${value}`;
              },
            },
          ],
        },
      ],
    });
    const turn = await loop.executeTurn(trigger(), "first-thread");
    expect(turn.success).toBe(true);
    expect(turn.response?.parts).toEqual([{ kind: "text", text: "Finished" }]);
    expect(executed).toEqual([0, 1]);
    expect(requests.map((r) => r.path)).toEqual(
      Array(2).fill(openai ? "/v1/responses" : "/v1/messages"),
    );
    for (const step of turn.trace.inferenceSteps) {
      expect(step.cost.priced).toBe(true);
      if (step.cost.priced) expect(step.cost.costUsd).toBeCloseTo(cost, 12);
    }
    const second = requests[1]!.body;
    if (openai) {
      expect(second).toMatchObject({
        model,
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      expect(second.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ encrypted_content: opaque }),
          ...ids.map((id, i) => ({
            type: "function_call_output",
            call_id: id,
            output: `order ${i}`,
          })),
        ]),
      );
    } else {
      expect(second).toMatchObject({ model, stream: true, tool_choice: { type: "auto" } });
      expect(second.messages).toEqual(
        expect.arrayContaining([
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: opaque },
              ...ids.map((id, value) => ({
                type: "tool_use",
                id,
                name: "lookup",
                input: { value },
              })),
            ],
          },
          {
            role: "user",
            content: ids.map((id, i) => ({
              type: "tool_result",
              tool_use_id: id,
              content: `order ${i}`,
            })),
          },
        ]),
      );
    }
    expect(
      JSON.stringify([turn, loop.getHistoryManager("first-thread").getHistory(10000)]),
    ).not.toContain(opaque);
    await loop.executeTurn(trigger(), "other-thread");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2])).not.toContain(opaque);
  });
}
