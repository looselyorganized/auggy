import { describe, expect, test } from "bun:test";
import type {
  PeerIdentity,
  RouteAuthContext,
  ToolExecuteContext,
  ToolResult,
  TurnState,
} from "auggy";
import orderSupport from "./index";
import { OrderSupportService } from "./domain";

const VERIFIED_PEER: PeerIdentity = {
  id: "vis_demo",
  kind: "human",
  trustLevel: "public",
  publicSubstate: "recognized",
  sourceAugment: "webTransport",
};

const ANONYMOUS_PEER: PeerIdentity = {
  id: "anon_demo",
  kind: "human",
  trustLevel: "public",
  publicSubstate: "anonymous",
  sourceAugment: "webTransport",
};

const VISITOR_AUTH: RouteAuthContext = {
  mode: "visitor",
  state: "recognized",
  visitorId: "vis_demo",
  agentId: "order-support",
  issuedAt: 1,
  expiresAt: 2,
  principal: {
    kind: "visitor",
    trustLevel: "public",
    publicSubstate: "recognized",
    visitorId: "vis_demo",
    agentId: "order-support",
  },
};

function context(peer = VERIFIED_PEER, threadId = "thread-1", turnId = "turn-1"):
  ToolExecuteContext {
  return { peer, threadId, turnId };
}

function tool(augment: ReturnType<typeof orderSupport>, name: string) {
  const match = augment.tools?.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing tool ${name}`);
  return match;
}

function route(augment: ReturnType<typeof orderSupport>, method: "GET" | "POST", path: string) {
  const match = augment.httpRoutes?.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!match) throw new Error(`Missing route ${method} ${path}`);
  return match;
}

function parsed(result: string | ToolResult): Record<string, unknown> {
  return JSON.parse(typeof result === "string" ? result : result.content) as Record<string, unknown>;
}

async function startTurn(
  augment: ReturnType<typeof orderSupport>,
  text: string,
  ctx: ToolExecuteContext,
): Promise<void> {
  const turn: TurnState = {
    turnId: ctx.turnId,
    threadId: ctx.threadId,
    peer: ctx.peer,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
    trigger: {
      type: "message",
      turnId: ctx.turnId,
      threadId: ctx.threadId,
      timestamp: Date.now(),
      peer: ctx.peer,
      payload: {
        parts: [{ kind: "text", text }],
        sourceAugment: "webTransport",
        peer: ctx.peer,
        timestamp: Date.now(),
      },
    },
  };
  await augment.onTurnStart?.(turn);
}

describe("order-support showcase", () => {
  test("declares private route and tool adapters", () => {
    const augment = orderSupport();
    expect(augment.httpRoutes?.map((candidate) => candidate.auth)).toEqual([
      "visitor.required",
      "visitor.required",
      "visitor.required",
    ]);
    expect(augment.httpRoutes?.every((candidate) => candidate.responseJsonSchema)).toBe(true);
    expect(augment.tools?.map((candidate) => candidate.name)).toEqual([
      "order_support_get_order",
      "order_support_prepare_address_change",
      "order_support_confirm_address_change",
    ]);
  });

  test("rejects anonymous tool access before order lookup", async () => {
    const augment = orderSupport();
    const result = await tool(augment, "order_support_get_order").execute(
      { orderId: "A-1042" },
      context(ANONYMOUS_PEER),
    );
    expect(parsed(result)).toMatchObject({
      status: "error",
      code: "verification_required",
    });
    expect(typeof result === "object" && result.isError).toBe(true);
  });

  test("a route-prepared change is confirmed deterministically and visible to the tool", async () => {
    const ids = ["route-change", "route-phrase", "route-audit"];
    const service = new OrderSupportService({
      now: () => new Date("2026-07-21T18:00:00.000Z"),
      createId: () => ids.shift() ?? "fallback",
    });
    const augment = orderSupport({ service });
    const prepare = route(
      augment,
      "POST",
      "/order-support/orders/:id/address-change/prepare",
    );
    const preparedResponse = await prepare.handler(
      new Request("http://localhost/order-support/orders/A-1042/address-change/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAddress: "500 Market Street, San Francisco, CA 94105" }),
      }),
      {
        signal: AbortSignal.timeout(1_000),
        auth: VISITOR_AUTH,
        params: { id: "A-1042" },
        routePath: "/order-support/orders/:id/address-change/prepare",
      },
    );
    const prepared = (await preparedResponse.json()) as {
      change: { changeId: string; confirmationPhrase: string };
    };

    const confirm = route(
      augment,
      "POST",
      "/order-support/orders/:id/address-change/confirm",
    );
    const confirmedResponse = await confirm.handler(
      new Request("http://localhost/order-support/orders/A-1042/address-change/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changeId: prepared.change.changeId,
          confirmationPhrase: prepared.change.confirmationPhrase,
        }),
      }),
      {
        signal: AbortSignal.timeout(1_000),
        auth: VISITOR_AUTH,
        params: { id: "A-1042" },
        routePath: "/order-support/orders/:id/address-change/confirm",
      },
    );
    const lookup = parsed(
      await tool(augment, "order_support_get_order").execute(
        { orderId: "A-1042" },
        context(),
      ),
    ) as { order: { shippingAddress: string } };

    expect(preparedResponse.status).toBe(201);
    expect(confirmedResponse.status).toBe(200);
    expect(lookup.order.shippingAddress).toBe("500 Market Street, San Francisco, CA 94105");
  });

  test("chat confirmation must be the exact current human message in a later turn", async () => {
    const ids = ["chat-change", "chat-phrase", "chat-audit"];
    const augment = orderSupport({
      createId: () => ids.shift() ?? "fallback",
      now: () => new Date("2026-07-21T18:00:00.000Z"),
    });
    const firstTurn = context(VERIFIED_PEER, "thread-1", "turn-1");
    const prepared = parsed(
      await tool(augment, "order_support_prepare_address_change").execute(
        {
          orderId: "A-1042",
          newAddress: "500 Market Street, San Francisco, CA 94105",
        },
        firstTurn,
      ),
    ) as { change: { confirmationPhrase: string } };

    const modelOnly = await tool(augment, "order_support_confirm_address_change").execute(
      { confirmationPhrase: prepared.change.confirmationPhrase },
      firstTurn,
    );
    expect(parsed(modelOnly)).toMatchObject({ code: "explicit_confirmation_required" });

    const laterTurn = context(VERIFIED_PEER, "thread-1", "turn-2");
    await startTurn(augment, prepared.change.confirmationPhrase, laterTurn);
    const confirmed = await tool(augment, "order_support_confirm_address_change").execute(
      { confirmationPhrase: prepared.change.confirmationPhrase },
      laterTurn,
    );
    expect(parsed(confirmed)).toMatchObject({
      result: {
        status: "success",
        audit: { action: "shipping_address.changed", actorId: "vis_demo" },
      },
    });

    const replay = await tool(augment, "order_support_confirm_address_change").execute(
      { confirmationPhrase: prepared.change.confirmationPhrase },
      laterTurn,
    );
    expect(parsed(replay)).toMatchObject({ code: "change_not_prepared" });
  });

  test("confirmation expires at the configured boundary", () => {
    let nowMs = Date.parse("2026-07-21T18:00:00.000Z");
    const ids = ["expiring-change", "expiring-phrase"];
    const service = new OrderSupportService({
      now: () => new Date(nowMs),
      createId: () => ids.shift() ?? "fallback",
      confirmationTtlMs: 1_000,
    });
    const actor = { key: "visitor:vis_demo", id: "vis_demo", type: "verified_visitor" } as const;
    const prepared = service.prepareAddressChange({
      actor,
      binding: "app",
      orderId: "A-1042",
      newAddress: "500 Market Street, San Francisco, CA 94105",
    });
    nowMs += 1_000;
    expect(() =>
      service.confirmAddressChange({
        actor,
        binding: "app",
        changeId: prepared.changeId,
        confirmationPhrase: prepared.confirmationPhrase,
        humanInput: prepared.confirmationPhrase,
      }),
    ).toThrow("confirmation expired");
  });
});
