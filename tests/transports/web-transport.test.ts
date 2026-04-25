import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { webTransport } from "@/transports/web-transport";
import { defineAgent } from "@/agent";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createIdentityAugment } from "@tests/fixtures/mock-augment";
import type { Augment } from "@/types";

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

  it("identify() returns null when x-peer-id header is missing", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({ headers: {} });
    expect(identity).toBeNull();
  });

  it("identify() produces PeerIdentity from headers with default trustLevel", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {
        "x-peer-id": "alice-123",
        "x-peer-kind": "human",
        "x-peer-name": "Alice",
        "x-org-id": "acme",
      },
    });
    expect(identity).toEqual({
      id: "alice-123",
      kind: "human",
      trustLevel: "untrusted",
      sourceAugment: "web",
      displayName: "Alice",
      orgId: "acme",
    });
  });

  it("identify() respects configured trustLevel override", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      trustLevel: "facility",
    });
    const identity = aug.transport!.identify({
      headers: { "x-peer-id": "alice" },
    });
    expect(identity?.trustLevel).toBe("facility");
  });
});

describe("webTransport HTTP server", () => {
  it("serves /health with status 200", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18900;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
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
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-peer-id": "alice",
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

  it("accepts POST /agent/run without x-peer-id when visitor tokens are enabled (issues a token)", async () => {
    const model = createMockModel({ response: "hi" });
    const port = 18902;
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
      expect(resp.headers.get("x-visitor-token")).not.toBeNull();
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("rejects POST /agent/run with missing x-peer-id when visitor tokens are disabled", async () => {
    const model = createMockModel();
    const port = 18912;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: { enabled: false },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
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
      expect(resp.status).toBe(400);
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
          "x-peer-id": "alice",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/event-stream");

      const text = await resp.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const events = lines.map((l) =>
        JSON.parse(l.slice("data: ".length)),
      ) as Array<{ type: string }>;

      const types = events.map((e) => e.type);
      expect(types).toContain("RUN_STARTED");
      expect(types).toContain("TEXT_MESSAGE_START");
      expect(types).toContain("TEXT_MESSAGE_CONTENT");
      expect(types).toContain("TEXT_MESSAGE_END");
      expect(types).toContain("RUN_FINISHED");

      const contentEvent = events.find(
        (e) => e.type === "TEXT_MESSAGE_CONTENT",
      ) as unknown as { delta: string };
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
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [echoAugment, aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-peer-id": "alice",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "echo please" }],
        }),
      });
      expect(resp.status).toBe(200);

      const text = await resp.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));
      const events = lines.map((l) =>
        JSON.parse(l.slice("data: ".length)),
      ) as Array<{ type: string; toolCallName?: string; content?: string }>;

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

  it("serves the Agent Card at /.well-known/agent-card.json automatically", async () => {
    const model = createMockModel();
    const port = 18905;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      {
        name: "researcher",
        purpose: "testing",
        model: "mock",
        augments: [aug],
      },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(
        `http://localhost:${port}/.well-known/agent-card.json`,
      );
      expect(resp.status).toBe(200);
      const card = (await resp.json()) as {
        provider: { name: string };
        purpose: string;
        capabilities: { transport: boolean };
      };
      expect(card.provider.name).toBe("researcher");
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
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-peer-id": "alice",
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "this message is way too long to fit" },
          ],
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
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-peer-id": "alice",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(resp.status).toBe(200);

      // Read from the body stream incrementally. With buffering, the
      // reader would block until the kernel finished and `release` would
      // never be called. With true streaming, RUN_STARTED arrives while
      // the model is still gated, we observe it, then release the gate.
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let seenRunStartedBeforeRelease = false;
      let buffered = "";

      // Read a single chunk, check for RUN_STARTED, then release.
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes("RUN_STARTED")) {
        seenRunStartedBeforeRelease = true;
      }
      release();

      // Drain the rest of the stream.
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
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      rateLimitPerPeer: { maxPerMinute: 1 },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      // First call: under the limit, succeeds. Capture the visitor token.
      const first = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-peer-id": "heavy-user",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(first.status).toBe(200);
      const visitorToken = first.headers.get("x-visitor-token") ?? "";
      await first.text();

      // Second call: same visitor (send token back), rate-limited.
      model.pushResponse({ content: "ok again", finishReason: "end_turn" });
      const second = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-peer-id": "heavy-user",
          "x-visitor-token": visitorToken,
        },
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
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "OPTIONS",
      });
      expect(resp.status).toBe(204);
      expect(resp.headers.get("access-control-allow-methods")).toContain(
        "POST",
      );
      expect(resp.headers.get("access-control-allow-headers")).toContain(
        "authorization",
      );
      expect(resp.headers.get("access-control-allow-headers")).toContain(
        "x-peer-id",
      );
      expect(resp.headers.get("access-control-allow-origin")).toBe(
        "https://example.com",
      );
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
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
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
      const resp1 = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-peer-id": "visitor-1",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      const token = resp1.headers.get("x-visitor-token")!;
      expect(token).not.toBeNull();
      await resp1.text();

      model.pushResponse({ content: "hello again", finishReason: "end_turn" });

      const resp2 = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-visitor-token": token,
          "x-peer-id": "visitor-1",
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
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      model,
    );
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
});
