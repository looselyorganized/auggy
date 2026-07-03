import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createExternalAuthAssertion,
  defineAgent,
  defineAugment,
  defineTool,
  webTransport,
} from "@/index";
import { createMockModel } from "@tests/fixtures/mock-model";
import type { AgentHandle, RouteAuthContext } from "@/types";

type SseEvent = {
  type: string;
  delta?: string;
  content?: string;
  result?: { status?: string; message?: string };
  threadId?: string;
};

const PORT_BASE = 19640;
const APP_AUTH_SECRET = "app-auth-secret";
const AUDIENCE = "storefront-agent";

describe("integration: delegated authz over /agent/run", () => {
  let agent: AgentHandle | undefined;

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore — the test may have failed before start completed
    }
    agent = undefined;
  });

  it("executes a protected tool when an app assertion grants its input-bound resource", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { orderId: "order_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Refund started.", finishReason: "end_turn" });

    let executeCalls = 0;
    let observedAuth: RouteAuthContext | undefined;
    const orders = defineAugment({
      name: "orders",
      tools: [
        defineTool({
          name: "refund_order",
          description: "Refund an order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: {
            action: "refund.issue",
            resource: { input: "orderId" },
            constraints: { maxAmountCents: 5000, currency: "USD" },
          },
          execute: async ({ orderId }, context) => {
            executeCalls += 1;
            observedAuth = context?.auth;
            return `refund-authorized:${orderId}:${context?.auth?.principal.kind ?? "unknown"}`;
          },
        }),
      ],
    });

    const port = PORT_BASE;
    agent = defineAgent(
      {
        name: "storefront-agent",
        purpose: "tests delegated app authorization",
        model: "mock",
        augments: [orders, appAuthWebTransport(port)],
      },
      model,
    );
    await agent.start();

    const assertion = mintAppAssertion({
      grants: [
        {
          action: "refund.issue",
          resource: "order_123",
          constraints: { maxAmountCents: 5000, currency: "USD" },
        },
      ],
    });
    const events = await runAgent(port, assertion);

    expect(executeCalls).toBe(1);
    expect(observedAuth).toMatchObject({
      mode: "visitor",
      state: "recognized",
      externalAuth: {
        provider: "supabase",
        subject: "user_123",
        orgId: "org_abc",
      },
    });
    expect(events.map((event) => event.type)).toContain("TOOL_CALL_RESULT");
    expect(events.find((event) => event.type === "TOOL_CALL_RESULT")?.content).toBe(
      "refund-authorized:order_123:visitor",
    );
    expect(textContent(events)).toContain("Refund started.");
    expect(events.find((event) => event.type === "RUN_FINISHED")?.result?.status).toBe("completed");
  });

  it("denies a protected tool before execution when the app assertion lacks the resource grant", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { orderId: "order_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "I cannot refund that order.", finishReason: "end_turn" });

    let executeCalls = 0;
    const orders = defineAugment({
      name: "orders",
      tools: [
        defineTool({
          name: "refund_order",
          description: "Refund an order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: { action: "refund.issue", resource: { input: "orderId" } },
          execute: async () => {
            executeCalls += 1;
            return "should-not-run";
          },
        }),
      ],
    });

    const port = PORT_BASE + 1;
    agent = defineAgent(
      {
        name: "storefront-agent",
        purpose: "tests delegated app authorization",
        model: "mock",
        augments: [orders, appAuthWebTransport(port)],
      },
      model,
    );
    await agent.start();

    const assertion = mintAppAssertion({
      grants: [{ action: "refund.issue", resource: "order_999" }],
    });
    const events = await runAgent(port, assertion);

    expect(executeCalls).toBe(0);
    expect(textContent(events)).toContain("I cannot refund that order.");
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.map((message) => message.content).join("\n")).toContain(
      'Tool "refund_order" authorization denied: authorization-grant-missing',
    );
  });
});

function appAuthWebTransport(port: number) {
  return webTransport({
    port,
    allowAnonymous: true,
    auth: { type: "bearer", token: "creator-token" },
    externalAuth: {
      secret: APP_AUTH_SECRET,
      audience: AUDIENCE,
      allowedProviders: ["supabase"],
      maxTtlSeconds: 60,
    },
  });
}

function mintAppAssertion(opts: {
  grants: Array<{
    action: string;
    resource?: string;
    constraints?: Record<string, string | number | boolean>;
  }>;
}): string {
  return createExternalAuthAssertion({
    secret: APP_AUTH_SECRET,
    audience: AUDIENCE,
    provider: "supabase",
    subject: "user_123",
    ttlSeconds: 60,
    orgId: "org_abc",
    roles: ["customer"],
    grants: opts.grants,
    authzVersion: "test-authz-v1",
  });
}

async function runAgent(port: number, assertion: string): Promise<SseEvent[]> {
  const resp = await fetch(`http://127.0.0.1:${port}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-auggy-auth-assertion": assertion,
    },
    body: JSON.stringify({
      threadId: `thread-${crypto.randomUUID()}`,
      messages: [{ role: "user", content: "refund order_123" }],
    }),
  });

  expect(resp.status).toBe(200);
  expect(resp.headers.get("content-type")).toContain("text/event-stream");

  const body = await resp.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as SseEvent);
}

function textContent(events: readonly SseEvent[]): string {
  return events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta ?? "")
    .join("");
}
