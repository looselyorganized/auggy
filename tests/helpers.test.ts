import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineAugment, defineRoute, defineTool, json, webhook } from "@/helpers";
import type { ContextBlock, TurnState } from "@/types";

const stubTurn: TurnState = {
  turnId: "t1",
  threadId: "th1",
  trigger: {
    type: "message",
    turnId: "t1",
    timestamp: Date.now(),
    payload: {},
  },
  peer: null,
  toolCallsSoFar: 0,
  turnStartedAt: Date.now(),
  metadata: {},
};

describe("defineTool", () => {
  it("creates a typed tool from a Zod schema", async () => {
    const tool = defineTool({
      name: "greet",
      description: "Greet someone",
      category: "meta",
      input: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    expect(tool.name).toBe("greet");
    expect(tool.category).toBe("meta");
    const result = await tool.execute({ name: "Alice" });
    expect(result).toBe("Hello, Alice!");
  });

  it("preserves delegated authorization requirements", () => {
    const tool = defineTool({
      name: "read_orders",
      description: "Read orders",
      category: "search",
      input: z.object({}),
      requires: { scope: "orders.read" },
      execute: async () => "ok",
    });

    expect(tool.requires).toEqual({ scope: "orders.read" });
  });
});

describe("defineAugment", () => {
  it("creates an augment and passes through all fields", () => {
    const aug = defineAugment({ name: "test" });
    expect(aug.name).toBe("test");
  });

  it("preserves string-returning context (kernel handles wrapping)", async () => {
    const aug = defineAugment({
      name: "notes",
      context: async () => "Some notes",
    });

    const result = await aug.context!(stubTurn, undefined);
    // defineAugment passes through — the string is returned as-is
    expect(result).toBe("Some notes");
  });

  it("passes through ContextBlock[] return unchanged", async () => {
    const block: ContextBlock = {
      source: "custom",
      content: "Custom content",
      placement: "system",
      provenance: "identity",
      priority: "required",
      eviction: "never",
      origin: "operator",
    };

    const aug = defineAugment({
      name: "custom",
      context: async () => [block],
    });

    const result = await aug.context!(stubTurn, undefined);
    expect(result).toEqual([block]);
  });
});

describe("defineRoute", () => {
  it("creates a GET route that validates query params and returns JSON", async () => {
    const route = defineRoute.get("/services", {
      auth: "none",
      query: z.object({
        need: z.string().min(1),
        tag: z.union([z.string(), z.array(z.string())]).optional(),
      }),
      response: z.object({
        method: z.literal("GET"),
        need: z.string(),
        tag: z.union([z.string(), z.array(z.string())]).optional(),
        bodyIsUndefined: z.boolean(),
      }),
      handler: ({ query, body, route }) =>
        json({
          method: route.method,
          need: query.need,
          tag: query.tag,
          bodyIsUndefined: body === undefined,
        }),
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/services");
    expect(route.auth).toBe("none");
    expect(route.requestJsonSchema?.query).toMatchObject({
      type: "object",
      properties: {
        need: { type: "string", minLength: 1 },
      },
      required: ["need"],
    });
    expect(route.responseJsonSchema).toMatchObject({
      type: "object",
      properties: {
        method: { const: "GET" },
        need: { type: "string" },
        bodyIsUndefined: { type: "boolean" },
      },
      required: ["method", "need", "bodyIsUndefined"],
    });

    const res = await route.handler(
      new Request("http://localhost/services?need=gifting&tag=a&tag=b"),
      { signal: AbortSignal.timeout(1000) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      method: "GET",
      need: "gifting",
      tag: ["a", "b"],
      bodyIsUndefined: true,
    });
  });

  it("supplies auth context when a helper route is invoked directly", async () => {
    const route = defineRoute.get("/private", {
      auth: "bearer",
      handler: ({ auth }) => json({ auth: auth.mode, principal: auth.principal }),
    });

    const res = await route.handler(new Request("http://localhost/private"), {
      signal: AbortSignal.timeout(1000),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auth: "bearer",
      principal: {
        kind: "creator",
        trustLevel: "creator",
        peerId: "creator",
      },
    });
  });

  it("supplies creator auth context for semantic creator routes invoked directly", async () => {
    const route = defineRoute.get("/creator", {
      auth: "creator",
      handler: ({ auth }) => json({ auth: auth.mode, principal: auth.principal }),
    });

    const res = await route.handler(new Request("http://localhost/creator"), {
      signal: AbortSignal.timeout(1000),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auth: "creator",
      principal: {
        kind: "creator",
        trustLevel: "creator",
        peerId: "creator",
      },
    });
  });

  it("supplies agent auth context for agent routes invoked directly", async () => {
    const route = defineRoute.get("/agent-api/search", {
      auth: "agent.required",
      handler: ({ auth }) => json({ auth: auth.mode, principal: auth.principal }),
    });

    const res = await route.handler(new Request("http://localhost/agent-api/search"), {
      signal: AbortSignal.timeout(1000),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auth: "agent",
      principal: {
        kind: "agent",
        trustLevel: "agent",
        agentId: "agent",
        peerId: "agent:agent",
      },
    });
  });

  it("creates a GET route that validates path params", async () => {
    const route = defineRoute.get("/services/:id", {
      auth: "none",
      params: z.object({ id: z.string().regex(/^svc_/) }),
      handler: ({ params, route }) =>
        json({ id: params.id, routePath: route.path, routeParams: route.params }),
    });

    const ok = await route.handler(new Request("http://localhost/services/svc_123"), {
      signal: AbortSignal.timeout(1000),
      params: { id: "svc_123" },
      routePath: "/services/:id",
    });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      id: "svc_123",
      routePath: "/services/:id",
      routeParams: { id: "svc_123" },
    });

    const invalid = await route.handler(new Request("http://localhost/services/bad"), {
      signal: AbortSignal.timeout(1000),
      params: { id: "bad" },
      routePath: "/services/:id",
    });

    expect(invalid.status).toBe(400);
  });

  it("groups routes under a prefix without losing handler route context", async () => {
    const [route] = defineRoute.group("/services", [
      defineRoute.get("/:id", {
        auth: "none",
        handler: ({ route, params }) => json({ path: route.path, id: params.id }),
      }),
    ]);

    expect(route?.path).toBe("/services/:id");

    const res = await route!.handler(new Request("http://localhost/services/design"), {
      signal: AbortSignal.timeout(1000),
      params: { id: "design" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/services/:id", id: "design" });
  });

  it("returns a 400 response when GET query validation fails", async () => {
    const route = defineRoute.get("/services", {
      auth: "none",
      query: z.object({ need: z.string().min(1) }),
      handler: () => json({ ok: true }),
    });

    const res = await route.handler(new Request("http://localhost/services"), {
      signal: AbortSignal.timeout(1000),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-request", message: "Invalid request" });
  });

  it("creates a POST route that validates JSON body", async () => {
    const route = defineRoute.post("/leads/create", {
      auth: "bearer",
      body: z.object({
        email: z.string().email(),
        serviceId: z.string().min(1),
      }),
      response: z.object({
        saved: z.boolean(),
        email: z.string().email(),
      }),
      handler: ({ body }) => json({ saved: true, email: body.email }, 201),
    });

    expect(route.method).toBe("POST");
    expect(route.auth).toBe("bearer");
    expect(route.requestJsonSchema?.body).toMatchObject({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        serviceId: { type: "string", minLength: 1 },
      },
      required: ["email", "serviceId"],
    });
    expect(route.responseJsonSchema).toMatchObject({
      type: "object",
      properties: {
        saved: { type: "boolean" },
        email: { type: "string", format: "email" },
      },
      required: ["saved", "email"],
    });

    const res = await route.handler(
      new Request("http://localhost/leads/create", {
        method: "POST",
        body: JSON.stringify({ email: "ada@example.com", serviceId: "gifting" }),
      }),
      { signal: AbortSignal.timeout(1000) },
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ saved: true, email: "ada@example.com" });
  });

  it("attaches webhook policy metadata to helper routes", () => {
    const route = defineRoute.post("/webhooks/stripe", {
      auth: "none",
      policy: webhook.signature("stripe", {
        secretEnv: "STRIPE_WEBHOOK_SECRET",
        timestampToleranceSeconds: 120,
      }),
      handler: () => json({ ok: true }),
    });

    expect(route.policy).toEqual({
      kind: "webhook.signature",
      provider: "stripe",
      secretEnv: "STRIPE_WEBHOOK_SECRET",
      timestampToleranceSeconds: 120,
    });
  });

  it("attaches delegated authorization requirements to helper routes", () => {
    const route = defineRoute.post("/orders/:id/refund", {
      auth: "visitor.required",
      requires: { action: "refund.issue", resource: { param: "id" } },
      handler: () => json({ ok: true }),
    });

    expect(route.requires).toEqual({
      action: "refund.issue",
      resource: { param: "id" },
    });
  });

  it("creates a POST route that validates query params and JSON body", async () => {
    const route = defineRoute.post("/leads/create/:source", {
      auth: "none",
      params: z.object({ source: z.string().min(1) }),
      query: z.object({ dryRun: z.enum(["true", "false"]).optional() }),
      body: z.object({
        email: z.string().email(),
        serviceId: z.string().min(1),
      }),
      handler: ({ body, query, params, route }) =>
        json({
          email: body.email,
          dryRun: query.dryRun,
          source: params.source,
          routePath: route.path,
        }),
    });

    const res = await route.handler(
      new Request("http://localhost/leads/create/referral?dryRun=true", {
        method: "POST",
        body: JSON.stringify({ email: "ada@example.com", serviceId: "gifting" }),
      }),
      {
        signal: AbortSignal.timeout(1000),
        params: { source: "referral" },
        routePath: "/leads/create/:source",
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: "ada@example.com",
      dryRun: "true",
      source: "referral",
      routePath: "/leads/create/:source",
    });

    const invalidQuery = await route.handler(
      new Request("http://localhost/leads/create/referral?dryRun=maybe", {
        method: "POST",
        body: JSON.stringify({ email: "ada@example.com", serviceId: "gifting" }),
      }),
      { signal: AbortSignal.timeout(1000), params: { source: "referral" } },
    );

    expect(invalidQuery.status).toBe(400);
  });

  it("returns a 400 response when POST body is invalid JSON or fails schema validation", async () => {
    const route = defineRoute.post("/leads/create", {
      auth: "none",
      body: z.object({ email: z.string().email() }),
      handler: () => json({ ok: true }),
    });

    const invalidJson = await route.handler(
      new Request("http://localhost/leads/create", { method: "POST", body: "{" }),
      { signal: AbortSignal.timeout(1000) },
    );
    expect(invalidJson.status).toBe(400);

    const invalidShape = await route.handler(
      new Request("http://localhost/leads/create", {
        method: "POST",
        body: JSON.stringify({ email: "not-email" }),
      }),
      { signal: AbortSignal.timeout(1000) },
    );
    expect(invalidShape.status).toBe(400);
    expect(await invalidShape.json()).toEqual({
      error: "bad-request",
      message: "Invalid request",
    });
  });
});
