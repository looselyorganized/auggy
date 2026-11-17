import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteAuthContext, ToolExecuteContext } from "auggy";
import { ordersAugment } from "../agent-integration/orders";
import { createOrdersServiceClient } from "../agent-integration/orders/service-client";
import {
  createSyntheticOrdersHandler,
  createSyntheticOrdersStore,
} from "../fixtures/synthetic-orders";
import type { CompanyAuthorization, OrderPrincipal } from "../agent-integration/orders/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const subject = (userId: string, roles: string[] = []) => ({
  provider: "fixture-app",
  userId,
  orgId: "synthetic-company",
  roles,
});
function auth(userId: string, authorization: CompanyAuthorization): RouteAuthContext {
  return {
    mode: "visitor",
    state: "recognized",
    visitorId: userId,
    agentId: "fixture-agent",
    issuedAt: 0,
    expiresAt: 8_000_000_000_000_000,
    principal: {
      kind: "visitor",
      trustLevel: "public",
      publicSubstate: "recognized",
      visitorId: userId,
      agentId: "fixture-agent",
    },
    externalAuth: {
      provider: "fixture-app",
      subject: userId,
      orgId: "synthetic-company",
      ...authorization,
    },
  };
}
function context(
  value: RouteAuthContext,
  operationId = "stable-tool-operation",
): ToolExecuteContext {
  return { auth: value, turnId: "turn", threadId: "thread", peer: null, operationId };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m5-company-orders-"));
  roots.push(root);
  const path = join(root, "company.sqlite");
  const store = createSyntheticOrdersStore(path);
  const handler = createSyntheticOrdersHandler(store, "synthetic-service-token");
  const calls: string[] = [];
  const transport = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new URL(String(input)).pathname);
      return handler(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
      );
    },
    { preconnect() {} },
  ) as typeof fetch;
  const service = createOrdersServiceClient({
    origin: "http://127.0.0.1:12345",
    token: "synthetic-service-token",
    fetch: transport,
  });
  const augment = ordersAugment(service);
  return { path, store, service, augment, calls };
}

test("authoritative company records grant exact orders; forged roles add no authority", async () => {
  const f = fixture();
  try {
    expect(
      (await f.service.authorizationFor(subject("customer-a", ["support", "admin", "creator"])))
        .grants,
    ).toEqual([{ action: "orders.read", resource: "order-a" }]);
    expect((await f.service.authorizationFor(subject("customer-b"))).grants).toEqual([
      { action: "orders.read", resource: "order-b" },
    ]);
    expect((await f.service.authorizationFor(subject("app-admin", ["admin"]))).grants).toEqual([
      { action: "orders.read", resource: "order-a" },
    ]);
    expect(
      (
        await f.service.authorizationFor({
          ...subject("support-agent"),
          provider: "forged-provider",
        })
      ).grants,
    ).toEqual([]);
    expect(
      (await f.service.authorizationFor({ ...subject("support-agent"), orgId: "other-company" }))
        .grants,
    ).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("tools and routes independently deny another customer's records before domain calls", async () => {
  const f = fixture();
  try {
    const a = auth("customer-a", await f.service.authorizationFor(subject("customer-a")));
    const b = auth("customer-b", await f.service.authorizationFor(subject("customer-b")));
    const tool = f.augment.tools!.find((tool) => tool.name === "read_order")!;
    expect(tool.requires).toEqual([
      { scope: "orders.read" },
      { action: "orders.read", resource: { input: "orderId" } },
    ]);
    expect(await tool.execute({ orderId: "order-a" }, context(a))).toContain(
      "customer-a-private-marker",
    );
    expect(await tool.execute({ orderId: "order-b" }, context(b))).toContain(
      "customer-b-private-marker",
    );
    const before = f.calls.length;
    await expect(tool.execute({ orderId: "order-b" }, context(a))).rejects.toThrow();
    await expect(tool.execute({ orderId: "order-a" }, context(b))).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    const route = f.augment.httpRoutes!.find((route) => route.method === "GET")!;
    expect(route.requires).toEqual([
      { scope: "orders.read" },
      { action: "orders.read", resource: { param: "id" } },
    ]);
    const forbidden = await route.handler(new Request("https://agent.example/orders/order-b"), {
      auth: a,
      params: { id: "order-b" },
      signal: new AbortController().signal,
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).not.toContain("customer-b-private-marker");
    expect(f.calls).toHaveLength(before);
    expect(f.store.journal()).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("support amount/resource grants are enforced on tools and routes; durable duplicate effects replay once", async () => {
  const f = fixture();
  const support = auth("support-agent", await f.service.authorizationFor(subject("support-agent")));
  const tool = f.augment.tools!.find((tool) => tool.name === "simulate_refund")!;
  const input = { orderId: "order-a", amountCents: 2500, reason: "Synthetic example" };
  try {
    const first = await tool.execute(input, context(support));
    expect(await tool.execute(input, context(support))).toBe(first);
    expect(f.store.journal()).toHaveLength(1);
    await expect(
      tool.execute({ ...input, orderId: "order-b" }, context(support, "wrong-resource")),
    ).rejects.toThrow();
    await expect(
      tool.execute({ ...input, amountCents: 5001 }, context(support, "over-amount")),
    ).rejects.toThrow();
    await expect(
      tool.execute(
        input,
        context(
          auth("support-agent", {
            grants: [],
            scopes: [],
            authzVersion: "synthetic-company-policy-v1",
          }),
          "missing-grants",
        ),
      ),
    ).rejects.toThrow();
    await expect(tool.execute({ ...input, amountCents: 3000 }, context(support))).rejects.toThrow();
    expect(f.store.journal()).toHaveLength(1);
    const route = f.augment.httpRoutes!.find((route) => route.method === "POST")!;
    const request = new Request("https://agent.example/orders/order-b/refund-simulations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amountCents: 2500,
        reason: "Synthetic example",
        operationId: "route-operation-no-effect",
      }),
    });
    expect(
      (
        await route.handler(request, {
          auth: support,
          params: { id: "order-b" },
          signal: new AbortController().signal,
        })
      ).status,
    ).toBe(403);
    expect(f.store.journal()).toHaveLength(1);
  } finally {
    f.store.close();
  }
  const restarted = createSyntheticOrdersStore(f.path);
  try {
    expect(restarted.journal()).toHaveLength(1);
    const claims =
      support.mode === "visitor" && support.state === "recognized"
        ? support.externalAuth!
        : undefined;
    const principal: OrderPrincipal = {
      provider: claims!.provider,
      subject: claims!.subject,
      orgId: claims!.orgId,
      grants: claims!.grants!,
      authzVersion: claims!.authzVersion!,
    };
    expect(
      restarted.simulateRefund(principal, { ...input, operationId: "stable-tool-operation" })
        .simulationId,
    ).toBe(restarted.journal()[0]!.receipt.simulationId);
    expect(restarted.journal()).toHaveLength(1);
  } finally {
    restarted.close();
  }
});

test("synthetic downstream checkpoint preserves exact idempotency across a separate fresh store", () => {
  const f = fixture();
  const current = f.store.authorizationFor(subject("support-agent"));
  const principal: OrderPrincipal = {
    provider: "fixture-app",
    subject: "support-agent",
    orgId: "synthetic-company",
    grants: current.grants,
    authzVersion: current.authzVersion,
  };
  const input = {
    orderId: "order-a",
    amountCents: 1250,
    reason: "checkpoint",
    operationId: "checkpoint-operation",
  };
  const first = f.store.simulateRefund(principal, input);
  const saved = f.store.checkpoint();
  f.store.close();
  const restored = createSyntheticOrdersStore(join(f.path, "..", "restored.sqlite"));
  try {
    expect(restored.restoreCheckpoint(saved.checkpoint, saved.sha256)).toBe(saved.sha256);
    expect(restored.simulateRefund(principal, input)).toEqual(first);
    expect(restored.journal()).toHaveLength(1);
    expect(restored.checkpoint()).toEqual(saved);
    expect(() => restored.simulateRefund(principal, { ...input, amountCents: 2500 })).toThrow();
    expect(() => restored.restoreCheckpoint(saved.checkpoint, saved.sha256)).toThrow(
      "fresh unused",
    );
    expect(restored.journal()).toHaveLength(1);
  } finally {
    restored.close();
  }
});

test("checkpoint import refuses altered identity, malformed tuples and nonempty or previously used stores", () => {
  const f = fixture();
  const authorization = f.store.authorizationFor(subject("support-agent"));
  f.store.simulateRefund(
    {
      provider: "fixture-app",
      subject: "support-agent",
      orgId: "synthetic-company",
      ...authorization,
    },
    {
      orderId: "order-a",
      amountCents: 1250,
      reason: "checkpoint",
      operationId: "checkpoint-one",
    },
  );
  const saved = f.store.checkpoint();
  try {
    expect(() => f.store.restoreCheckpoint(saved.checkpoint, saved.sha256)).toThrow("fresh unused");
    for (const [index, mutate] of [
      (value: typeof saved.checkpoint) => {
        value.effects[0]!.subject = "customer-a" as "support-agent";
      },
      (value: typeof saved.checkpoint) => {
        value.effects[0]!.receipt.simulationId = `simulation-${"0".repeat(24)}`;
      },
      (value: typeof saved.checkpoint) => {
        value.effects[0]!.bindingHash = "invalid";
      },
      (value: typeof saved.checkpoint) => {
        value.effects.push(value.effects[0]!);
      },
      (value: typeof saved.checkpoint) => {
        value.policyVersion = "forged-policy" as typeof value.policyVersion;
      },
    ].entries()) {
      const store = createSyntheticOrdersStore(join(f.path, "..", `invalid-${index}.sqlite`));
      try {
        const bad = structuredClone(saved.checkpoint);
        mutate(bad);
        expect(() => store.restoreCheckpoint(bad, saved.sha256)).toThrow();
        expect(store.journal()).toEqual([]);
      } finally {
        store.close();
      }
    }
    const used = createSyntheticOrdersStore(join(f.path, "..", "used.sqlite"));
    try {
      expect(() => used.restoreCheckpoint(saved.checkpoint, "0".repeat(64))).toThrow(
        "identity mismatch",
      );
      used.authorizationFor(subject("customer-a"));
      expect(() => used.restoreCheckpoint(saved.checkpoint, saved.sha256)).toThrow("fresh unused");
    } finally {
      used.close();
    }
  } finally {
    f.store.close();
  }
});

test("synthetic effect bound refuses new effects while replaying an existing operation", () => {
  const f = fixture();
  const authorization = f.store.authorizationFor(subject("support-agent"));
  const principal = {
    provider: "fixture-app",
    subject: "support-agent",
    orgId: "synthetic-company",
    ...authorization,
  };
  const input = { orderId: "order-a", amountCents: 1250, reason: "bounded" };
  try {
    for (let index = 0; index < 100; index++)
      f.store.simulateRefund(principal, { ...input, operationId: `bounded-${index}` });
    const first = f.store.journal()[0];
    expect(() =>
      f.store.simulateRefund(principal, { ...input, operationId: "overflow" }),
    ).toThrow();
    expect(f.store.simulateRefund(principal, { ...input, operationId: "bounded-0" })).toEqual(
      first!.receipt,
    );
    expect(f.store.checkpoint().checkpoint.effects).toHaveLength(100);
  } finally {
    f.store.close();
  }
});

test("authenticated synthetic handler bounds a stalled body without applying effects", async () => {
  const f = fixture();
  let cancelled = false;
  const handler = createSyntheticOrdersHandler(f.store, "bounded-token");
  try {
    const response = await handler(
      new Request("http://fixture/refunds/simulate", {
        method: "POST",
        headers: { authorization: "Bearer bounded-token" },
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(f.store.journal()).toEqual([]);
  } finally {
    f.store.close();
  }
});
