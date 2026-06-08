import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { isLoopback, normalizeIp, webTransport } from "@/transports/web-transport";
import { defineAgent } from "@/agent";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createIdentityAugment } from "@tests/fixtures/mock-augment";
import { routeFixtureAugment } from "@tests/fixtures/route-fixture-augment";
import { createVisitorToken, deriveSigningKey } from "@/transports/visitor-token";
import type { Augment } from "@/types";

// ---------------------------------------------------------------------------
// Structure tests
// ---------------------------------------------------------------------------

describe("webTransport structure", () => {
  it("returns an augment with a transport field and correct name", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    expect(aug.name).toBe("web");
    expect(aug.capabilities).toContain("transport");
    expect(aug.transport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Identity resolver — four path tests (called directly, no server boot)
// ---------------------------------------------------------------------------

describe("webTransport identity — four paths", () => {
  // Path 1: Creator — bearer-only, no agent headers, no visitor token
  it("Path 1: bearer-validated request (no agent headers, no visitor token) → creator", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {},
      __threadId: "thread-123",
      __bearerValidated: true,
    });
    expect(identity).not.toBeNull();
    expect(identity?.trustLevel).toBe("creator");
    expect(identity?.id).toBe("creator");
    expect(identity?.sourceAugment).toBe("web");
  });

  it("Path 1: creator identity has no publicSubstate", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {},
      __threadId: "thread-abc",
      __bearerValidated: true,
    });
    expect(identity?.publicSubstate).toBeUndefined();
  });

  // G3: explicit security gate — Path 1 MUST require bearer validation.
  // Without this guard, an allowAnonymous bypass (no bearer) would silently
  // resolve to creator trust, defeating the safety story. Covered by codex
  // adversarial review #1.
  it("Path 1: bare request without __bearerValidated → public:anonymous, NOT creator", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {},
      __threadId: "thread-no-auth",
      // __bearerValidated intentionally absent — simulates the
      // allowAnonymous bypass path where no bearer was validated
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon-thread-no-auth");
  });

  it("Path 1: __bearerValidated=false explicitly → public:anonymous (no silent creator)", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {},
      __threadId: "thread-explicit-false",
      __bearerValidated: false,
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon-thread-explicit-false");
  });

  // Path 2: Agent — x-agent-id + x-agent-secret
  it("Path 2: valid agent credentials → agent trust", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "summarizer", sharedSecret: "s3cr3t" }],
      },
    });
    const identity = aug.transport!.identify({
      headers: {
        "x-agent-id": "summarizer",
        "x-agent-secret": "s3cr3t",
      },
      __threadId: "thread-xyz",
    });
    expect(identity).not.toBeNull();
    expect(identity?.trustLevel).toBe("agent");
    expect(identity?.id).toBe("agent:summarizer");
    expect(identity?.kind).toBe("agent");
    expect(identity?.publicSubstate).toBeUndefined();
  });

  it("Path 2: wrong agent secret → null (causes 401 in HTTP handler)", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "summarizer", sharedSecret: "correct-secret" }],
      },
    });
    const identity = aug.transport!.identify({
      headers: {
        "x-agent-id": "summarizer",
        "x-agent-secret": "wrong-secret",
      },
      __threadId: "thread-xyz",
    });
    expect(identity).toBeNull();
  });

  it("Path 2: unknown agent id → null", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "known-agent", sharedSecret: "s3cr3t" }],
      },
    });
    const identity = aug.transport!.identify({
      headers: {
        "x-agent-id": "unknown-agent",
        "x-agent-secret": "s3cr3t",
      },
      __threadId: "thread-xyz",
    });
    expect(identity).toBeNull();
  });

  it("Path 2: no agents configured + agent headers → null", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {
        "x-agent-id": "summarizer",
        "x-agent-secret": "anything",
      },
      __threadId: "thread-xyz",
    });
    expect(identity).toBeNull();
  });

  // Path 3: Public recognized — visitor token payload injected
  it("Path 3: valid visitor token payload → public:recognized", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const fakePayload = {
      visitorId: "vis_abc123",
      agentId: "test-agent",
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 86400000,
    };
    const identity = aug.transport!.identify({
      headers: { "x-visitor-token": "some.token" },
      __visitorPayload: fakePayload,
      __threadId: "thread-999",
    });
    expect(identity).not.toBeNull();
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("recognized");
    expect(identity?.id).toBe("vis_abc123");
    expect(identity?.kind).toBe("human");
  });

  // Path 4: Public anonymous — no agent headers, no visitor payload
  it("Path 4: no agent headers, no visitor token → public:anonymous", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: { "x-visitor-token": "some.stale.token" },
      __threadId: "thread-anon-999",
    });
    expect(identity).not.toBeNull();
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon-thread-anon-999");
  });

  it("Path 4: bare request with no headers and no __bearerValidated falls through to anonymous", () => {
    // Updated under G3: previously this asserted `creator` because Path 1 was
    // reachable by any request without a visitor token. The G3 security gate
    // requires __bearerValidated for Path 1, so a bare request (as if it
    // arrived via the allowAnonymous bypass) correctly lands at Path 4.
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {},
      __threadId: "thread-bare",
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon-thread-bare");
  });

  it("Path 4: x-visitor-token header present but no payload → anonymous with threadId", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: { "x-visitor-token": "malformed-token" },
      __threadId: "my-thread-id",
      // __visitorPayload NOT set — token verification failed
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon-my-thread-id");
  });
});

// ---------------------------------------------------------------------------
// HTTP server tests
// ---------------------------------------------------------------------------

describe("webTransport HTTP server", () => {
  it("serves /health with status 200", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18900;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { status: string };
      expect(body.status).toBe("healthy");
    } finally {
      await agent.stop();
    }
  });

  it("rejects POST /agent/run with missing bearer token", async () => {
    const model = createMockModel();
    const port = 18901;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // G3: pin allowAnonymous=false so this test stays deterministic
      // regardless of NODE_ENV during the test run. The env-based default
      // is exercised by the "webTransport allowAnonymous (G3)" suite below.
      allowAnonymous: false,
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(401);
    } finally {
      await agent.stop();
    }
  });

  it("accepts POST /agent/run without x-visitor-token when visitor tokens are enabled (issues a token)", async () => {
    const model = createMockModel({ response: "hi" });
    const port = 18902;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // F2: visitorTokens must now be explicitly enabled with a signingKey;
      // the ephemeral-fallback path has been removed.
      visitorTokens: { enabled: true, signingKey: "test-signing-key" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      // First-contact anonymous request with bootstrap sentinel — the
      // documented pattern in docs/20-embedding.md. allowAnonymous defaults
      // true in test env (NODE_ENV !== "production"), so this request is
      // admitted. Runtime mints a fresh visitor token in the response header.
      // Bearer omitted because under codex R6 fix, bearer-wins; sending bearer
      // would route to creator (Path 1) and no visitor token would be issued.
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "bootstrap",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("x-visitor-token")).not.toBeNull();
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("bearer-only request (no x-visitor-token) resolves to creator and succeeds", async () => {
    const model = createMockModel({ response: "hi creator" });
    const port = 18913;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello creator" }],
        }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("RUN_STARTED");
    } finally {
      await agent.stop();
    }
  });

  it("agent auth with valid credentials resolves to agent trust", async () => {
    const model = createMockModel({ response: "hi agent" });
    const port = 18914;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "worker-agent", sharedSecret: "agent-secret-xyz" }],
      },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-agent-id": "worker-agent",
          "x-agent-secret": "agent-secret-xyz",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello from agent" }],
        }),
      });
      expect(resp.status).toBe(200);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("agent auth with wrong secret returns 401", async () => {
    const model = createMockModel({ response: "hi" });
    const port = 18915;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "worker-agent", sharedSecret: "correct-secret" }],
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-agent-id": "worker-agent",
          "x-agent-secret": "wrong-secret",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(401);
    } finally {
      await agent.stop();
    }
  });

  it("streams AG-UI events for a basic chat turn", async () => {
    const model = createMockModel({ response: "Hello back" });
    const port = 18903;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [createIdentityAugment("You are a test agent."), aug],
      },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/event-stream");

      const text = await resp.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const events = lines.map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
        type: string;
      }>;

      const types = events.map((e) => e.type);
      expect(types).toContain("RUN_STARTED");
      expect(types).toContain("TEXT_MESSAGE_START");
      expect(types).toContain("TEXT_MESSAGE_CONTENT");
      expect(types).toContain("TEXT_MESSAGE_END");
      expect(types).toContain("RUN_FINISHED");

      const contentEvent = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as unknown as {
        delta: string;
      };
      expect(contentEvent.delta).toBe("Hello back");
    } finally {
      await agent.stop();
    }
  });

  it("streams TOOL_CALL_* events when the model calls a tool", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "hi" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Echoed back",
      finishReason: "end_turn",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const port = 18904;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [echoAugment, aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "echo please" }],
        }),
      });
      expect(resp.status).toBe(200);

      const text = await resp.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const events = lines.map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
        type: string;
        toolCallName?: string;
        content?: string;
      }>;

      const types = events.map((e) => e.type);
      expect(types).toContain("TOOL_CALL_START");
      expect(types).toContain("TOOL_CALL_ARGS");
      expect(types).toContain("TOOL_CALL_END");
      expect(types).toContain("TOOL_CALL_RESULT");

      const toolStart = events.find((e) => e.type === "TOOL_CALL_START");
      expect(toolStart?.toolCallName).toBe("echo");

      const toolResult = events.find((e) => e.type === "TOOL_CALL_RESULT");
      expect(toolResult?.content).toBe("echoed-hi");
    } finally {
      await agent.stop();
    }
  });

  it("keeps the Agent Card private by default", async () => {
    const model = createMockModel();
    const port = 18995;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      {
        name: "researcher",
        displayName: "Jim",
        purpose: "testing",
        model: "mock",
        augments: [aug],
      },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/.well-known/agent-card.json`);
      expect(resp.status).toBe(404);

      const authed = await fetch(`http://localhost:${port}/.well-known/agent-card.json`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(authed.status).toBe(200);
      const card = (await authed.json()) as {
        provider: { name: string; displayName?: string };
        purpose: string;
        capabilities: { transport: boolean };
      };
      expect(card.provider.name).toBe("researcher");
      expect(card.provider.displayName).toBe("Jim");
      expect(card.purpose).toBe("testing");
      expect(card.capabilities.transport).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("serves the Agent Card publicly when publicIntegration is enabled", async () => {
    const model = createMockModel();
    const port = 18905;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicIntegration: true,
    });
    const agent = defineAgent(
      {
        name: "researcher",
        displayName: "Jim",
        purpose: "testing",
        model: "mock",
        augments: [aug],
      },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/.well-known/agent-card.json`);
      expect(resp.status).toBe(200);
      const card = (await resp.json()) as {
        provider: { name: string; displayName?: string };
        purpose: string;
        capabilities: { transport: boolean };
      };
      expect(card.provider.name).toBe("researcher");
      expect(card.provider.displayName).toBe("Jim");
      expect(card.purpose).toBe("testing");
      expect(card.capabilities.transport).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("returns 413 for messages over maxMessageLength", async () => {
    const model = createMockModel();
    const port = 18906;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      maxMessageLength: 10,
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "this message is way too long to fit" }],
        }),
      });
      expect(resp.status).toBe(413);
    } finally {
      await agent.stop();
    }
  });

  it("delivers AG-UI events progressively via ReadableStream (not buffered)", async () => {
    // Model holds inference open until `release` is awaited, so we can
    // prove the SSE stream delivers RUN_STARTED before the turn finishes.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const model = createMockModel({ response: "done" });
    const originalComplete = model.complete.bind(model);
    model.complete = async (prompt) => {
      await gate;
      return originalComplete(prompt);
    };

    const port = 18907;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);

      // Read from the body stream incrementally.
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let seenRunStartedBeforeRelease = false;
      let buffered = "";

      const { value, done } = await reader.read();
      expect(done).toBe(false);
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes("RUN_STARTED")) {
        seenRunStartedBeforeRelease = true;
      }
      release();

      while (true) {
        const { value: v, done: d } = await reader.read();
        if (d) break;
        buffered += decoder.decode(v, { stream: true });
      }
      buffered += decoder.decode();

      expect(seenRunStartedBeforeRelease).toBe(true);
      expect(buffered).toContain("RUN_FINISHED");
    } finally {
      await agent.stop();
    }
  });

  it("emits RUN_ERROR + RUN_FINISHED when a turn is rejected by the rate limiter", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 18908;
    // Use agent credentials so both requests have the same stable peer ID
    // (agent:rate-limited-agent), which the rate limiter can track across requests.
    // Using visitor tokens would give different peer IDs: the first request with
    // an invalid token is anonymous (anon-<threadId>), while the second with the
    // issued token is recognized (vis_<uuid>) — these are different IDs, so the
    // rate limiter would not fire.
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "rate-limited-agent", sharedSecret: "rl-secret" }],
      },
      rateLimitPerPeer: { maxPerMinute: 1 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    const agentHeaders = {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      "x-agent-id": "rate-limited-agent",
      "x-agent-secret": "rl-secret",
    };

    try {
      // First call: under the limit, succeeds.
      const first = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(first.status).toBe(200);
      await first.text();

      // Second call: same agent peer ID → rate-limited.
      model.pushResponse({ content: "ok again", finishReason: "end_turn" });
      const second = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi again" }],
        }),
      });
      expect(second.status).toBe(200);
      const body = await second.text();
      const events = body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
        type: string;
        code?: string;
      }>;
      const types = events.map((e) => e.type);
      expect(types).toContain("RUN_ERROR");
      expect(types).toContain("RUN_FINISHED");
      const errEvent = events.find((e) => e.type === "RUN_ERROR");
      expect(errEvent?.code).toBe("REJECTED");
    } finally {
      await agent.stop();
    }
  });

  it("responds to OPTIONS preflight with CORS headers", async () => {
    const model = createMockModel();
    const port = 18909;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      cors: { origins: ["https://example.com"] },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "OPTIONS",
      });
      expect(resp.status).toBe(204);
      expect(resp.headers.get("access-control-allow-methods")).toContain("POST");
      expect(resp.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(resp.headers.get("access-control-allow-headers")).toContain("x-peer-id");
      expect(resp.headers.get("access-control-allow-origin")).toBe("https://example.com");
    } finally {
      await agent.stop();
    }
  });

  it("rejects double-start with a clear error", async () => {
    const model = createMockModel();
    const port = 18910;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      await expect(agent.start()).rejects.toThrow(/already started/);
    } finally {
      await agent.stop();
    }
  });

  it("returning visitor with valid token gets no new token issued", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18921;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // F2: explicit signingKey required; ephemeral fallback removed.
      visitorTokens: { enabled: true, signingKey: "test-signing-key" },
    });
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [createIdentityAugment("You are a test agent."), aug],
      },
      model,
    );
    await agent.start();

    try {
      // First request: anonymous (no bearer; allowAnonymous defaults true in test env)
      // with bootstrap visitor-token → mints a fresh token in the response.
      // (Bearer omitted because under codex R6 fix, valid bearer wins over
      // invalid visitor-token and would route to creator with no token issuance.)
      const resp1 = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "bootstrap",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      const token = resp1.headers.get("x-visitor-token")!;
      expect(token).not.toBeNull();
      await resp1.text();

      model.pushResponse({ content: "hello again", finishReason: "end_turn" });

      // Second request: send valid token back → recognized → no new token.
      // Bearer kept here to verify the documented semantic: valid visitor-token
      // alongside bearer still resolves to recognized (Path 3 fires because
      // __visitorPayload is populated; Path 1 is skipped).
      const resp2 = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-visitor-token": token,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello again" }] }),
      });
      expect(resp2.status).toBe(200);
      expect(resp2.headers.get("x-visitor-token")).toBeNull();
      await resp2.text();
    } finally {
      await agent.stop();
    }
  });

  it("CORS preflight allows x-visitor-token header", async () => {
    const model = createMockModel();
    const port = 18922;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      cors: { origins: ["https://example.com"] },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "OPTIONS",
      });
      expect(resp.headers.get("access-control-allow-headers")).toContain("x-visitor-token");
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency-Key tests
  // ---------------------------------------------------------------------------

  it("Idempotency-Key: valid key is used as turnId in the SSE stream", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18930;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const idempotencyKey = "my-request-abc-123";
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      // The SSE stream should contain the turnId in the RUN_STARTED or RUN_FINISHED event.
      expect(text).toContain(idempotencyKey);
    } finally {
      await agent.stop();
    }
  });

  it("Idempotency-Key: absent → generates fresh UUID (stream proceeds normally)", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18931;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("RUN_STARTED");
      expect(text).toContain("RUN_FINISHED");
    } finally {
      await agent.stop();
    }
  });

  it("Idempotency-Key: malformed key returns HTTP 400", async () => {
    const model = createMockModel();
    const port = 18932;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "idempotency-key": "has spaces and !@#$ invalid chars",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toBe("invalid_idempotency_key");
    } finally {
      await agent.stop();
    }
  });

  it("Idempotency-Key: key exceeding 128 chars returns HTTP 400", async () => {
    const model = createMockModel();
    const port = 18933;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const tooLong = "a".repeat(129);
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "idempotency-key": tooLong,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // CORS headers for new fields
  // ---------------------------------------------------------------------------

  it("CORS preflight allows x-agent-id, x-agent-secret, and idempotency-key", async () => {
    const model = createMockModel();
    const port = 18940;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      cors: { origins: ["https://example.com"] },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "OPTIONS",
      });
      expect(resp.status).toBe(204);
      const allowedHeaders = resp.headers.get("access-control-allow-headers") ?? "";
      expect(allowedHeaders).toContain("x-agent-id");
      expect(allowedHeaders).toContain("x-agent-secret");
      expect(allowedHeaders).toContain("idempotency-key");
    } finally {
      await agent.stop();
    }
  });

  it("SSE response exposes idempotency-key in access-control-expose-headers", async () => {
    const model = createMockModel({ response: "hi" });
    const port = 18941;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      cors: { origins: ["https://example.com"] },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(200);
      const exposeHeader = resp.headers.get("access-control-expose-headers") ?? "";
      expect(exposeHeader).toContain("idempotency-key");
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Fix 1: invalid visitor token does NOT promote request to recognized
  // ---------------------------------------------------------------------------

  it("Fix 1: invalid visitor token does NOT promote request to public:recognized", async () => {
    // An invalid token must keep the request public:anonymous. The transport
    // still issues a fresh token in the response header (for future requests)
    // but the current request's peer is anonymous — NOT recognized.
    // We verify by attaching a budgets augment with an anonymous-only cap of 1
    // and confirming it fires (i.e., the request was treated as anonymous, not
    // as recognized which would have no cap).
    //
    // Ports 18960-18962 below were bumped from 18950-18952 to avoid colliding
    // with `tests/integration/full-agent.test.ts`, which also uses 18950+18951.
    // bun:test runs files in parallel; whichever bound second got EADDRINUSE
    // and the test died in ~2ms with a misleading expect(200) failure. Proper
    // fix is `port: 0` + read the bound port from Bun.serve, but the augment
    // doesn't expose that today — bump for now, refactor later.
    const model = createMockModel({ response: "hi" });
    const port = 18960;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // F2: explicit signingKey required; ephemeral fallback removed.
      visitorTokens: { enabled: true, signingKey: "test-signing-key" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      // No bearer: admitted via allowAnonymous-default-true in test env.
      // (Bearer omitted because under codex R6 fix, valid bearer wins over
      // invalid visitor-token and routes to creator — which doesn't issue
      // a visitor token in the response.)
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Malformed/garbage token — verification will fail.
          "x-visitor-token": "this.is.garbage",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);

      // A new token MUST be issued in the response (for future requests).
      const newToken = resp.headers.get("x-visitor-token");
      expect(newToken).not.toBeNull();
      expect(typeof newToken).toBe("string");
      expect((newToken ?? "").length).toBeGreaterThan(10);

      // Verify the request was treated as anonymous, not recognized, by checking
      // that the identify() path selected anonymous. The SSE stream succeeds
      // (there's no cap here to trigger), so we verify the identify function
      // directly using the transport's identify method with no __visitorPayload
      // (which is what happens when token verification fails).
      const identifyArg = {
        headers: { "x-visitor-token": "this.is.garbage" },
        __threadId: "verify-anon-thread",
        // __visitorPayload is NOT set — mirrors what the HTTP handler does after failed verify
      };
      const identity = aug.transport!.identify(identifyArg);
      expect(identity?.trustLevel).toBe("public");
      expect(identity?.publicSubstate).toBe("anonymous");

      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("Fix 1: missing visitor token + visitorTokens enabled stays anonymous on first request", async () => {
    // A first-contact request with a present-but-invalid x-visitor-token
    // issues a fresh token AND stays anonymous. (Under codex R6 fix, bearer
    // omitted: a valid bearer would route to creator and skip the
    // anonymous-with-token-issuance flow this test exercises.)
    const model = createMockModel({ response: "hi" });
    const port = 18961;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // F2: explicit signingKey required; ephemeral fallback removed.
      visitorTokens: { enabled: true, signingKey: "test-signing-key" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      // Send request with x-visitor-token header present but empty/invalid.
      // No bearer: admitted via allowAnonymous-default-true in test env.
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "invalid",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "first contact" }],
        }),
      });
      expect(resp.status).toBe(200);

      // Response must include a freshly-issued visitor token for future requests.
      const issuedToken = resp.headers.get("x-visitor-token");
      expect(issuedToken).not.toBeNull();

      // The identify path must stay anonymous (no __visitorPayload injected
      // when token fails verification).
      const identity = aug.transport!.identify({
        headers: { "x-visitor-token": "invalid" },
        __threadId: "first-contact-thread",
      });
      expect(identity?.publicSubstate).toBe("anonymous");

      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("Fix 1: valid visitor token classifies request as public:recognized", async () => {
    // Regression guard: valid tokens must still produce recognized trust.
    const model = createMockModel({ response: "hi" });
    const port = 18962;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // F2: explicit signingKey required; ephemeral fallback removed.
      visitorTokens: { enabled: true, signingKey: "test-signing-key" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      // Step 1: get a valid token by sending an invalid one first.
      // No bearer here — under codex R6 fix, valid bearer + stale visitor-token
      // routes to creator (Path 1) and no visitor token is issued.
      // allowAnonymous defaults true in test env (NODE_ENV !== "production").
      const resp1 = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "stale-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "first" }] }),
      });
      expect(resp1.status).toBe(200);
      const validToken = resp1.headers.get("x-visitor-token")!;
      expect(validToken).not.toBeNull();
      await resp1.text();

      // Step 2: send the valid token — this request should be recognized.
      model.pushResponse({ content: "welcome back", finishReason: "end_turn" });
      const resp2 = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-visitor-token": validToken,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "second" }] }),
      });
      expect(resp2.status).toBe(200);
      // A recognized visitor gets no new token (already has a valid one).
      expect(resp2.headers.get("x-visitor-token")).toBeNull();
      await resp2.text();
    } finally {
      await agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// G3: allowAnonymous posture flag — yaml > env > default precedence
// ---------------------------------------------------------------------------

/**
 * Helper: capture-and-restore an env var across a test body. Use to probe
 * env-based defaults and AUGGY_ALLOW_ANONYMOUS overrides without polluting
 * subsequent tests.
 */
async function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("webTransport allowAnonymous (G3)", () => {
  it("admits no-bearer requests when allowAnonymous=true (explicit yaml)", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 18990;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(resp.status).toBe(200);
      // Drain to release the connection cleanly.
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("rejects wrong-bearer requests even when allowAnonymous=true", async () => {
    const model = createMockModel();
    const port = 18991;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(resp.status).toBe(401);
    } finally {
      await agent.stop();
    }
  });

  it("admits valid-bearer requests when allowAnonymous=true (no creator regression)", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 18992;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(resp.status).toBe(200);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("uses env-based default: NODE_ENV=production → reject no-bearer", async () => {
    await withEnv({ NODE_ENV: "production", AUGGY_ALLOW_ANONYMOUS: undefined }, async () => {
      const model = createMockModel();
      const port = 18993;
      const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
      const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
      await agent.start();
      try {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(resp.status).toBe(401);
      } finally {
        await agent.stop();
      }
    });
  });

  it("uses env-based default: NODE_ENV unset → admit no-bearer", async () => {
    await withEnv({ NODE_ENV: undefined, AUGGY_ALLOW_ANONYMOUS: undefined }, async () => {
      const model = createMockModel({ response: "ok" });
      const port = 18994;
      const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
      const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
      await agent.start();
      try {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(resp.status).toBe(200);
        await resp.text();
      } finally {
        await agent.stop();
      }
    });
  });

  it("env override: AUGGY_ALLOW_ANONYMOUS=true wins over NODE_ENV=production default", async () => {
    await withEnv({ NODE_ENV: "production", AUGGY_ALLOW_ANONYMOUS: "true" }, async () => {
      const model = createMockModel({ response: "ok" });
      const port = 18995;
      const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
      const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
      await agent.start();
      try {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(resp.status).toBe(200);
        await resp.text();
      } finally {
        await agent.stop();
      }
    });
  });

  it("env override: AUGGY_ALLOW_ANONYMOUS=false wins over NODE_ENV unset default", async () => {
    await withEnv({ NODE_ENV: undefined, AUGGY_ALLOW_ANONYMOUS: "false" }, async () => {
      const model = createMockModel();
      const port = 18996;
      const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
      const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
      await agent.start();
      try {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(resp.status).toBe(401);
      } finally {
        await agent.stop();
      }
    });
  });

  it("yaml wins over env: allowAnonymous=false in opts overrides AUGGY_ALLOW_ANONYMOUS=true", async () => {
    await withEnv({ AUGGY_ALLOW_ANONYMOUS: "true", NODE_ENV: undefined }, async () => {
      const model = createMockModel();
      const port = 18997;
      const aug = webTransport({
        port,
        auth: { type: "bearer", token: "t" },
        allowAnonymous: false,
      });
      const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
      await agent.start();
      try {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(resp.status).toBe(401);
      } finally {
        await agent.stop();
      }
    });
  });

  it("emits a concise boot log line for anonymous posture", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await withEnv({ NODE_ENV: "production", AUGGY_ALLOW_ANONYMOUS: undefined }, async () => {
        const model = createMockModel();
        const port = 18998;
        const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
        const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
        await agent.start();
        try {
          expect(
            logs.find(
              (l) =>
                l.includes("[web]") &&
                l.includes("anonymous chat disabled") &&
                l.includes("production default"),
            ),
          ).toBeDefined();
        } finally {
          await agent.stop();
        }
      });
    } finally {
      console.log = originalLog;
    }
  });

  it("emits friendly local chat boot log for default local anonymous posture", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await withEnv({ NODE_ENV: undefined, AUGGY_ALLOW_ANONYMOUS: undefined }, async () => {
        const model = createMockModel();
        const port = 18997;
        const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
        const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
        await agent.start();
        try {
          expect(logs).toContain("[web] anonymous local chat enabled");
        } finally {
          await agent.stop();
        }
      });
    } finally {
      console.log = originalLog;
    }
  });

  it("does not warn for local default allowAnonymous=true + visitor-auth augment missing", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await withEnv({ NODE_ENV: undefined, AUGGY_ALLOW_ANONYMOUS: undefined }, async () => {
        const model = createMockModel();
        const port = 18999;
        const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
        const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
        await agent.start();
        try {
          expect(
            warnings.filter((w) => w.includes("anonymous public chat is enabled")),
          ).toHaveLength(0);
        } finally {
          await agent.stop();
        }
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  it("warns when anonymous chat is public-ish and visitor-auth augment is missing", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await withEnv(
        {
          NODE_ENV: undefined,
          AUGGY_ALLOW_ANONYMOUS: undefined,
          AUGGY_PUBLIC_URL: "https://example.com",
        },
        async () => {
          const model = createMockModel();
          const port = 18999;
          const aug = webTransport({ port, auth: { type: "bearer", token: "t" } });
          const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
          await agent.start();
          try {
            expect(
              warnings.find(
                (w) =>
                  w.includes("anonymous public chat is enabled") &&
                  w.includes("auggy augment add visitorAuth"),
              ),
            ).toBeDefined();
          } finally {
            await agent.stop();
          }
        },
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("suppresses visitor-auth-missing warning when allowAnonymous=true is yaml-explicit", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const model = createMockModel();
      const port = 18900;
      const aug = webTransport({
        port,
        auth: { type: "bearer", token: "t" },
        allowAnonymous: true,
      });
      const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
      await agent.start();
      try {
        expect(warnings.filter((w) => w.includes("anonymous public chat is enabled"))).toHaveLength(
          0,
        );
      } finally {
        await agent.stop();
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// F2: throws when visitorTokens.enabled=true but signingKey unset
// ---------------------------------------------------------------------------

describe("webTransport visitorTokens.enabled guard (fix F2)", () => {
  it("throws if visitorTokens.enabled is true but signingKey is unset", async () => {
    // The ephemeral fallback has been removed. A misconfigured agent (enabled
    // without a signingKey) must fail loudly at boot rather than silently
    // minting tokens that don't survive a restart.
    const model = createMockModel({ response: "ok" });
    const port = 18964;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: { enabled: true }, // signingKey intentionally absent
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await expect(agent.start()).rejects.toThrow(/signingKey/);
  });
});

// ---------------------------------------------------------------------------
// webTransport / (root) route — publicFrontendUrl option (Task A1: failing)
// ---------------------------------------------------------------------------

describe("webTransport / (root) route", () => {
  it("GET / returns 200 + HTML info page when publicFrontendUrl is not configured (G2)", async () => {
    const model = createMockModel();
    const port = 18965;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await resp.text();
      expect(body).toContain("<title>zip — agent-native app backend</title>");
      expect(body).toContain("<h1>Agent-native app backend.</h1>");
      expect(body).toContain("zip is running");
      expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    } finally {
      await agent.stop();
    }
  });

  it("GET / returns 302 with Location: <publicFrontendUrl> when configured", async () => {
    const model = createMockModel();
    const port = 18966;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "https://example.com/chat",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBe("https://example.com/chat");
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("GET on a non-/ path still returns 404 even when publicFrontendUrl is configured", async () => {
    const model = createMockModel();
    const port = 18967;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "https://example.com/chat",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/some-other-path`, {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(404);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("/health and public agent-card discovery are unaffected by publicFrontendUrl when publicIntegration is enabled", async () => {
    const model = createMockModel();
    const port = 18968;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "https://example.com/chat",
      publicIntegration: true,
    });
    const agent = defineAgent(
      { name: "researcher", purpose: "testing", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      // /health still 200 + healthy
      const health = await fetch(`http://localhost:${port}/health`, { redirect: "manual" });
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { status: string };
      expect(healthBody.status).toBe("healthy");

      // /.well-known/agent-card.json still 200 + valid card
      const card = await fetch(`http://localhost:${port}/.well-known/agent-card.json`, {
        redirect: "manual",
      });
      expect(card.status).toBe(200);
      const cardBody = (await card.json()) as { provider: { name: string } };
      expect(cardBody.provider.name).toBe("researcher");
    } finally {
      await agent.stop();
    }
  });

  it("GET /agent returns 404 by default", async () => {
    const model = createMockModel();
    const port = 19006;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent`, { redirect: "manual" });
      expect(resp.status).toBe(404);
    } finally {
      await agent.stop();
    }
  });

  it("GET /agent returns public developer surface HTML when publicIntegration is enabled", async () => {
    const model = createMockModel();
    const port = 19007;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicIntegration: true,
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent`, { redirect: "manual" });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await resp.text();
      expect(body).toContain("<title>zip — developer surface</title>");
      expect(body).toContain("Developer surface for zip.");
      expect(body).toContain("POST /agent/run");
      expect(body).toContain("/.well-known/agent-card.json");
    } finally {
      await agent.stop();
    }
  });

  it("HEAD /agent mirrors GET headers when publicIntegration is enabled", async () => {
    const model = createMockModel();
    const port = 19008;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicIntegration: true,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await resp.text()).toBe("");
    } finally {
      await agent.stop();
    }
  });

  it("GET /agent/ redirects to /agent only when publicIntegration is enabled", async () => {
    const model = createMockModel();
    const port = 19009;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicIntegration: true,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/`, { redirect: "manual" });
      expect(resp.status).toBe(308);
      expect(resp.headers.get("location")).toBe("/agent");
    } finally {
      await agent.stop();
    }
  });

  it("POST / returns 404 even when publicFrontendUrl is configured (only GET redirects)", async () => {
    const model = createMockModel();
    const port = 18969;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "https://example.com/chat",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        redirect: "manual",
      });
      expect(resp.status).toBe(404);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("HEAD / returns 200 + empty body + html headers when publicFrontendUrl unset (G2)", async () => {
    const model = createMockModel();
    const port = 19000;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await resp.text();
      expect(body).toBe("");
    } finally {
      await agent.stop();
    }
  });

  it("HEAD / returns 302 + empty body when publicFrontendUrl is set (G2)", async () => {
    const model = createMockModel();
    const port = 19001;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "https://example.com/chat",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBe("https://example.com/chat");
      const body = await resp.text();
      expect(body).toBe("");
    } finally {
      await agent.stop();
    }
  });

  it("POST / returns 404 when publicFrontendUrl is unset (regression for G2 HEAD/GET addition)", async () => {
    const model = createMockModel();
    const port = 19002;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        redirect: "manual",
      });
      expect(resp.status).toBe(404);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("GET / revalidates the info page because console posture can change it (G2)", async () => {
    const model = createMockModel();
    const port = 19004;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("HEAD / Content-Length probe — reflects GET body length or known Bun limit (G2)", async () => {
    const model = createMockModel();
    const port = 19005;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      // Compare HEAD vs GET. Whatever Bun reports for HEAD's Content-Length
      // is what we assert against. Goal: lock in observed behavior so a
      // future Bun upgrade changing the answer is loud.
      const getResp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      const getBody = await getResp.text();
      const getBytes = new TextEncoder().encode(getBody).byteLength;

      const headResp = await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      const headContentLength = headResp.headers.get("content-length");
      // Two acceptable outcomes per the spec's "Bun nuance" note:
      //   (a) Bun honors the explicit header — headContentLength matches GET bytes.
      //   (b) Bun overrides to 0 (null-body default) — known spec deviation.
      const matchesBody = headContentLength === String(getBytes);
      const overriddenToZero = headContentLength === "0";
      expect(matchesBody || overriddenToZero).toBe(true);
    } finally {
      await agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// webTransport augment-registered routes (PR γ.1 Task 5)
// ---------------------------------------------------------------------------

describe("webTransport augment-registered routes", () => {
  it("dispatches GET requests to augment-registered routes", async () => {
    const model = createMockModel();
    const port = 18970;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment();
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo?msg=hello`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { echo: string };
      expect(body.echo).toBe("hello");
    } finally {
      await agent.stop();
    }
  });

  it("auth: bearer route rejects request without bearer token", async () => {
    const model = createMockModel();
    const port = 18971;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({ auth: "bearer" });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo?msg=x`); // no Authorization
      expect(resp.status).toBe(401);
    } finally {
      await agent.stop();
    }
  });

  it("auth: bearer route rejects wrong bearer token", async () => {
    const model = createMockModel();
    const port = 18972;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({ auth: "bearer" });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo?msg=x`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(resp.status).toBe(401);
    } finally {
      await agent.stop();
    }
  });

  it("auth: none route accepts request without any bearer token", async () => {
    const model = createMockModel();
    const port = 18973;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({ auth: "none" });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo?msg=hi`); // no auth
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { echo: string };
      expect(body.echo).toBe("hi");
    } finally {
      await agent.stop();
    }
  });

  it("handler that throws returns 500 with opaque body", async () => {
    const model = createMockModel();
    const port = 18974;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      auth: "none",
      handler: async () => {
        throw new Error("internal kaboom");
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo`);
      expect(resp.status).toBe(500);
      const body = (await resp.json()) as { error: string };
      expect(body).toEqual({ error: "internal" });
      // The actual error message must NOT leak in the response body.
      expect(JSON.stringify(body)).not.toContain("kaboom");
    } finally {
      await agent.stop();
    }
  });

  it("handler that exceeds timeoutMs returns 504", async () => {
    const model = createMockModel();
    const port = 18975;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      auth: "none",
      timeoutMs: 50,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return new Response("late");
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo`);
      expect(resp.status).toBe(504);
    } finally {
      await agent.stop();
    }
  });

  it("POST request exceeding maxBodyBytes returns 413", async () => {
    const model = createMockModel();
    const port = 18976;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      method: "POST",
      auth: "none",
      maxBodyBytes: 100,
      handler: async () => new Response("ok"),
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const big = "x".repeat(200);
      const resp = await fetch(`http://localhost:${port}/test/echo`, {
        method: "POST",
        body: big,
        headers: { "content-type": "text/plain" },
      });
      expect(resp.status).toBe(413);
    } finally {
      await agent.stop();
    }
  });

  it("POST request without content-length is allowed under default cap", async () => {
    const model = createMockModel();
    const port = 18977;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      method: "POST",
      auth: "none",
      handler: async (req) => new Response(await req.text()),
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo`, {
        method: "POST",
        body: "small",
      });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("small");
    } finally {
      await agent.stop();
    }
  });

  it("GET request to a POST-only route returns 405 with Allow header", async () => {
    const model = createMockModel();
    const port = 18978;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({ method: "POST", auth: "none" });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo`); // GET on POST-only route
      expect(resp.status).toBe(405);
      expect(resp.headers.get("allow")).toBe("POST");
    } finally {
      await agent.stop();
    }
  });

  it("per-route rate limit returns 429 after maxPerMinute exceeded", async () => {
    const model = createMockModel();
    const port = 18979;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 2 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const res1 = await fetch(`http://localhost:${port}/test/echo?msg=1`);
      expect(res1.status).toBe(200);
      const res2 = await fetch(`http://localhost:${port}/test/echo?msg=2`);
      expect(res2.status).toBe(200);
      const res3 = await fetch(`http://localhost:${port}/test/echo?msg=3`);
      expect(res3.status).toBe(429);
      expect(res3.headers.get("retry-after")).toMatch(/^\d+$/);
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Finding 1: AbortSignal fires on timeout
  // ---------------------------------------------------------------------------

  it("handler receives an AbortSignal that fires when timeoutMs elapses", async () => {
    const model = createMockModel();
    const port = 18980;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    let signalAborted = false;
    const fixture = routeFixtureAugment({
      auth: "none",
      timeoutMs: 50,
      handler: async (_req, { signal }) => {
        signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        await new Promise((r) => setTimeout(r, 200));
        return new Response("late");
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo`);
      expect(resp.status).toBe(504);
      // Allow the abort event to fire on the handler's side.
      await new Promise((r) => setTimeout(r, 50));
      expect(signalAborted).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Finding 2: Body-size cap enforced via actual byte-count (chunked bypass)
  // ---------------------------------------------------------------------------

  it("body-size cap rejects chunked/large requests without content-length header", async () => {
    const model = createMockModel();
    const port = 18981;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      method: "POST",
      auth: "none",
      maxBodyBytes: 100,
      handler: async () => new Response("ok"),
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      // Build a chunked-encoded request via a manual ReadableStream — the
      // resulting fetch won't set content-length.
      const big = "x".repeat(200);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      });
      const resp = await fetch(`http://localhost:${port}/test/echo`, {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(resp.status).toBe(413);
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Finding 3: Per-IP rate limit isolation
  // ---------------------------------------------------------------------------

  it("rate limit isolates callers — different x-forwarded-for IPs get independent buckets (when proxy is trusted)", async () => {
    const model = createMockModel();
    const port = 18982;
    // F16: XFF is only honored when the connection IP is on trustedProxies.
    // Localhost connects via ::1 / 127.0.0.1 depending on resolver; include
    // both so the test is deterministic across environments. With these
    // entries on the allow-list, the test exercises the original
    // per-client-IP bucket-isolation behavior.
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      trustedProxies: ["127.0.0.1", "::1"],
    });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 1 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      // Caller A — first request allowed, second 429.
      const a1 = await fetch(`http://localhost:${port}/test/echo?msg=a`, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(a1.status).toBe(200);
      const a2 = await fetch(`http://localhost:${port}/test/echo?msg=a2`, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(a2.status).toBe(429);
      // Caller B — different IP, gets a fresh bucket.
      const b1 = await fetch(`http://localhost:${port}/test/echo?msg=b`, {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      expect(b1.status).toBe(200);
    } finally {
      await agent.stop();
    }
  });

  // F16 — when trustedProxies is unset (default), XFF is ignored and all
  // requests share the connection-IP bucket. Verifies the default-secure
  // behavior: an untrusted client cannot spoof XFF to skip rate limiting.
  it("ignores X-Forwarded-For when trustedProxies is unset — all callers share connection-IP bucket (F16)", async () => {
    const model = createMockModel();
    const port = 18984;
    // No trustedProxies → XFF not trusted.
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 1 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      // First request allowed.
      const r1 = await fetch(`http://localhost:${port}/test/echo?msg=a`, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(r1.status).toBe(200);
      // Second request from a "different" XFF IP — but XFF is ignored, so
      // the connection IP (localhost) is used and the bucket is full.
      const r2 = await fetch(`http://localhost:${port}/test/echo?msg=b`, {
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      expect(r2.status).toBe(429);
    } finally {
      await agent.stop();
    }
  });

  // F16 (Codex High) — even with trustedProxies set, the leftmost XFF
  // entry is attacker-controllable under append-style proxies: a client
  // pre-seeds `X-Forwarded-For: 8.8.8.8` and the proxy appends the
  // client's real IP, leaving "8.8.8.8, real-ip" — leftmost-first parsing
  // would let the attacker pick their bucket key. The right-to-left walk
  // skips trusted-proxy hops and returns the first non-trusted entry.
  it("F16 right-to-left XFF parse — pre-seeded leftmost entry cannot spoof bucket key", async () => {
    const model = createMockModel();
    const port = 18986;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      trustedProxies: ["127.0.0.1", "::1"],
    });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 1 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      // Two requests, both pre-seed "8.8.8.8" as the leftmost XFF, but
      // append a DIFFERENT "real client IP" as the rightmost entry.
      // Buggy leftmost-first: both reads "8.8.8.8" → share bucket → 2nd 429.
      // Fixed right-to-left: each reads its own rightmost (different) → both 200.
      const r1 = await fetch(`http://localhost:${port}/test/echo?msg=a`, {
        headers: { "x-forwarded-for": "8.8.8.8, 1.1.1.1" },
      });
      expect(r1.status).toBe(200);
      const r2 = await fetch(`http://localhost:${port}/test/echo?msg=b`, {
        headers: { "x-forwarded-for": "8.8.8.8, 2.2.2.2" },
      });
      expect(r2.status).toBe(200);
    } finally {
      await agent.stop();
    }
  });

  // Same right-to-left logic, dropping trusted-proxy hops. With a 2-hop
  // chain where one hop is on trustedProxies, the parse should drop the
  // trusted hop and return the actual client IP further left.
  it("F16 right-to-left XFF parse — drops trusted-proxy hops, returns first untrusted entry", async () => {
    const model = createMockModel();
    const port = 18987;
    // Trust localhost (the immediate peer) AND a hypothetical inner proxy "10.0.0.7".
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      trustedProxies: ["127.0.0.1", "::1", "10.0.0.7"],
    });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 1 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      // Two clients, each behind the same internal proxy "10.0.0.7".
      // XFF: <real-client>, <proxy 10.0.0.7> (proxy 10.0.0.7 appended itself)
      // Right-to-left: drop "10.0.0.7" (trusted), return <real-client>.
      const r1 = await fetch(`http://localhost:${port}/test/echo?msg=a`, {
        headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.7" },
      });
      expect(r1.status).toBe(200);
      // Different client behind the same trusted internal proxy → fresh bucket.
      const r2 = await fetch(`http://localhost:${port}/test/echo?msg=b`, {
        headers: { "x-forwarded-for": "2.2.2.2, 10.0.0.7" },
      });
      expect(r2.status).toBe(200);
      // Same client repeats → bucket exhausted → 429.
      const r3 = await fetch(`http://localhost:${port}/test/echo?msg=c`, {
        headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.7" },
      });
      expect(r3.status).toBe(429);
    } finally {
      await agent.stop();
    }
  });

  // F16 (Codex Medium) — IPv4-mapped IPv6. On some platforms, Bun's
  // server.requestIP returns "::ffff:127.0.0.1" for an IPv4 client over
  // an IPv6 socket. trustedProxies ["127.0.0.1"] must still match. Tested
  // directly against normalizeIp because the mapped form is hard to
  // trigger reliably from a localhost-fetch integration test.
  it("F16 normalizeIp strips IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4)", () => {
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::ffff:10.0.0.5")).toBe("10.0.0.5");
    expect(normalizeIp("::FFFF:8.8.8.8")).toBe("8.8.8.8"); // case-insensitive
  });

  it("F16 normalizeIp passes through non-mapped addresses unchanged", () => {
    expect(normalizeIp("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::1")).toBe("::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp("8.8.8.8")).toBe("8.8.8.8");
  });

  it("F16 normalizeIp returns null for null/undefined/empty input", () => {
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });

  it("G36 isLoopback returns true for 127.0.0.1", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
  });

  it("G36 isLoopback returns true for any 127.0.0.0/8 address", () => {
    expect(isLoopback("127.0.0.0")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("127.255.255.254")).toBe(true);
  });

  it("G36 isLoopback returns true for ::1", () => {
    expect(isLoopback("::1")).toBe(true);
  });

  it("G36 isLoopback returns true for IPv4-mapped loopback (::ffff:127.0.0.1)", () => {
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("G36 isLoopback returns false for non-loopback IPv4", () => {
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("8.8.8.8")).toBe(false);
  });

  it("G36 isLoopback returns false for non-loopback IPv6", () => {
    expect(isLoopback("::2")).toBe(false);
    expect(isLoopback("fe80::1")).toBe(false);
    expect(isLoopback("2001:db8::1")).toBe(false);
  });

  it("G36 isLoopback returns false for empty / null / undefined / non-IP input", () => {
    expect(isLoopback("")).toBe(false);
    expect(isLoopback(null)).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback("not-an-ip")).toBe(false);
    expect(isLoopback("localhost")).toBe(false);
  });

  // F16 (Codex Low) — warn-once latch is now narrowed to XFF only.
  // X-Real-IP without XFF must NOT consume the warning slot.
  it("F16 warn-once latch fires for X-Forwarded-For only, not X-Real-IP", async () => {
    const model = createMockModel();
    const port = 18989;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 100 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // X-Real-IP only (no XFF) — must NOT trigger the warning.
      await fetch(`http://localhost:${port}/test/echo?msg=a`, {
        headers: { "x-real-ip": "10.0.0.1" },
      });
      expect(
        warnings.filter((w) => w.includes("X-Forwarded-For") && w.includes("trustedProxies")),
      ).toHaveLength(0);
      // Now an XFF arrives — warn fires.
      await fetch(`http://localhost:${port}/test/echo?msg=b`, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(
        warnings.filter((w) => w.includes("X-Forwarded-For") && w.includes("trustedProxies")),
      ).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      await agent.stop();
    }
  });

  // F16 — warn-once latch. The first time XFF arrives without a configured
  // trustedProxies, console.warn fires once. Subsequent requests do not
  // re-warn.
  it("warns once when X-Forwarded-For arrives without trustedProxies (F16)", async () => {
    const model = createMockModel();
    const port = 18985;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment({
      auth: "none",
      rateLimit: { maxPerMinute: 100 },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // Three requests with XFF — should trigger ONE warning.
      for (let i = 0; i < 3; i++) {
        await fetch(`http://localhost:${port}/test/echo?msg=${i}`, {
          headers: { "x-forwarded-for": "10.0.0.1" },
        });
      }
      const xffWarnings = warnings.filter(
        (w) => w.includes("X-Forwarded-For") && w.includes("trustedProxies"),
      );
      expect(xffWarnings).toHaveLength(1);
      expect(xffWarnings[0]).toMatch(/trustedProxies is unset/);
    } finally {
      console.warn = originalWarn;
      await agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix C2: agentBinding — cross-agent replay prevention
// ---------------------------------------------------------------------------

describe("webTransport agentBinding (fix C2)", () => {
  it("rejects a token minted for a different agentBinding even with the same signing key", async () => {
    // Agent A mints a token with agentBinding "agent-a".
    // Agent B is configured with agentBinding "agent-b" and the SAME signing key.
    // Agent B must reject A's token — it should stay anonymous.
    const SHARED_SIGNING_KEY = "shared-key-for-c2-test";
    const sigKey = await deriveSigningKey(SHARED_SIGNING_KEY);

    // Mint a token as agent-a would (agentId = "agent-a").
    const { token: agentAToken } = await createVisitorToken(sigKey, "agent-a", 86_400);
    expect(agentAToken).toBeTruthy();

    // Boot agent B with agentBinding: "agent-b" and the same signing key.
    const model = createMockModel({ response: "hello" });
    const port = 18983;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: SHARED_SIGNING_KEY,
        agentBinding: "agent-b",
      },
    });
    const agent = defineAgent({ name: "agent-b", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      // Present agent-a's token to agent-b: must stay anonymous.
      // When anonymous + invalid-ish token, webTransport issues a NEW anon token.
      // No bearer here — under codex R6 fix, a bearer-credentialed request
      // resolves to creator (Path 1) and the mint logic is suppressed (no
      // fresh token issued for bearer callers; closes the creator-to-visitor
      // demotion loop). allowAnonymous defaults true in test env.
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": agentAToken,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi from agent-a replay" }] }),
      });
      expect(resp.status).toBe(200);
      // A new visitor token is issued — proves the request landed on anonymous path,
      // not recognized (recognized requests do NOT get a new token).
      expect(resp.headers.get("x-visitor-token")).not.toBeNull();
      await resp.text();
    } finally {
      await agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// G36 — /console route integration tests (Phase 2)
// ---------------------------------------------------------------------------

describe("webTransport /console route — basic dispatch (G36 phase 2)", () => {
  it("GET /console from loopback without bearer → bypass (no 401, falls through to next gate)", async () => {
    // Integration test: real fetch from the test process to 127.0.0.1 → the
    // loopback bypass in checkAdminAuth applies. Without a built SPA dist the
    // next gate returns 503; the test asserts the bypass by checking the
    // response is *not* 401. Non-loopback paths are covered in the unit
    // tests (tests/transports/admin/admin-auth.test.ts).
    const model = createMockModel();
    const port = 19200;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/console`);
      expect(resp.status).not.toBe(401);
      expect(resp.headers.get("www-authenticate")).toBeNull();
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("GET /admin with HTTP Basic bearer → 200 SPA shell when dist is built (or 503 notice when not)", async () => {
    const model = createMockModel();
    const port = 19201;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      const resp = await fetch(`http://127.0.0.1:${port}/console`, {
        headers: { authorization: `Basic ${basic}` },
      });
      const body = await resp.text();
      expect(resp.headers.get("content-type")).toContain("text/html");
      // Either the built SPA shell (200) or the "build required" notice (503)
      // — both are valid post-SPA. Auth passed in either case.
      if (resp.status === 200) {
        expect(body.toLowerCase()).toContain("auggy");
      } else {
        expect(resp.status).toBe(503);
        expect(body).toContain("Console SPA not built");
      }
    } finally {
      await agent.stop();
    }
  });

  it("GET /console/api/dashboard with HTTP Basic bearer → 200 + JSON", async () => {
    const model = createMockModel();
    const port = 19211;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/dashboard`, {
        headers: { authorization: `Basic ${basic}` },
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("application/json");
      const body = (await resp.json()) as { card: { provider: { name: string } } };
      expect(body.card.provider.name).toBe("zip");
    } finally {
      await agent.stop();
    }
  });

  it("HEAD /admin → 405 with Allow: GET, POST", async () => {
    const model = createMockModel();
    const port = 19202;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/console`, { method: "HEAD" });
      expect(resp.status).toBe(405);
      expect(resp.headers.get("allow")).toMatch(/GET/);
      expect(resp.headers.get("allow")).toMatch(/POST/);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("adminRoute: false → GET /admin returns 404", async () => {
    const model = createMockModel();
    const port = 19203;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      adminRoute: false,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      const resp = await fetch(`http://127.0.0.1:${port}/console`, {
        headers: { authorization: `Basic ${basic}` },
      });
      expect(resp.status).toBe(404);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("augment cannot register route at /admin (reserved-paths collision)", async () => {
    const model = createMockModel();
    const port = 19204;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const conflicting: Augment = {
      name: "evil",
      httpRoutes: [
        {
          method: "GET",
          path: "/console",
          auth: "none",
          handler: async () => new Response("evil"),
        },
      ],
    };
    const agent = defineAgent({ name: "zip", model: "mock", augments: [conflicting, aug] }, model);
    await expect(agent.start()).rejects.toThrow(/reserved|console/i);
  });

  it("S9 — augment cannot register route under /admin/ prefix", async () => {
    const model = createMockModel();
    const aug = webTransport({
      port: 19205,
      auth: { type: "bearer", token: "test-token" },
    });
    const conflicting: Augment = {
      name: "evil",
      httpRoutes: [
        {
          method: "POST",
          path: "/console/action/notify-test",
          auth: "none",
          handler: async () => new Response("evil"),
        },
      ],
    };
    const agent = defineAgent({ name: "zip", model: "mock", augments: [conflicting, aug] }, model);
    await expect(agent.start()).rejects.toThrow(/reserved|console/i);
  });
});

// ---------------------------------------------------------------------------
// webTransport / (root) route — boot-time validation (G2)
// ---------------------------------------------------------------------------

describe("webTransport / (root) route — boot-time validation (G2)", () => {
  it("agent.start() throws when publicFrontendUrl is not a valid URL", async () => {
    const model = createMockModel();
    const aug = webTransport({
      port: 19003,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "://bad",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await expect(agent.start()).rejects.toThrow(/publicFrontendUrl is not a valid URL/);
  });
});
