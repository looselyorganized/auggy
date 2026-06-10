import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineAugment, defineRoute, defineTool, json } from "@/helpers";
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
      handler: ({ query, route }) => json({ method: route.method, need: query.need, tag: query.tag }),
    });

    expect(route.method).toBe("GET");
    expect(route.path).toBe("/services");
    expect(route.auth).toBe("none");

    const res = await route.handler(
      new Request("http://localhost/services?need=gifting&tag=a&tag=b"),
      { signal: AbortSignal.timeout(1000) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ method: "GET", need: "gifting", tag: ["a", "b"] });
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
      handler: ({ body }) => json({ saved: true, email: body.email }, 201),
    });

    expect(route.method).toBe("POST");
    expect(route.auth).toBe("bearer");

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
