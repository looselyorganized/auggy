import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  isLoopback,
  normalizeIp,
  rateLimitNetworkIdentity,
  webTransport,
} from "@/transports/web-transport";
import { createAnonymousSessionManager } from "@/transports/anonymous-session";
import { defineRoute, json, webhook } from "@/helpers";
import { defineAgent } from "@/agent";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createIdentityAugment } from "@tests/fixtures/mock-augment";
import { routeFixtureAugment } from "@tests/fixtures/route-fixture-augment";
import { createVisitorToken, deriveSigningKey } from "@/transports/visitor-token";
import {
  createExternalAuthAssertion,
  createInMemoryExternalAuthReplayStore,
  externalMappedVisitorId,
} from "@/auth/external-auth";
import type { Augment, DelegatedAuthorizationDeniedAuditEvent, ModelClient } from "@/types";
import { createTempDir } from "@tests/fixtures/temp-dir";

async function bootstrapAnonymousRequest(
  url: string,
  init: RequestInit,
): Promise<{
  response: Response;
  session: string;
  visitorToken: string | null;
}> {
  const bootstrap = await fetch(url, init);
  const session = bootstrap.headers.get("x-auggy-anonymous-session");
  const visitorToken = bootstrap.headers.get("x-visitor-token");
  expect(bootstrap.status).toBe(428);
  expect(session).toBeTruthy();
  expect(await bootstrap.json()).toEqual({ error: "anonymous_session_required" });

  const headers = new Headers(init.headers);
  headers.set("x-auggy-anonymous-session", session ?? "");
  return {
    response: await fetch(url, { ...init, headers }),
    session: session ?? "",
    visitorToken,
  };
}

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
    expect(aug.transport).toBeDefined();
  });

  it("rejects non-boolean programmatic security options", () => {
    const invalidOptions: Array<[string, Record<string, unknown>]> = [
      ["allowAnonymous", { allowAnonymous: "false" }],
      ["adminRoute", { adminRoute: "false" }],
      ["publicIntegration", { publicIntegration: "false" }],
      ["visitorTokens.enabled", { visitorTokens: { enabled: "false" } }],
    ];
    for (const [field, invalid] of invalidOptions) {
      expect(() =>
        webTransport({
          port: 0,
          auth: { type: "bearer", token: "test-token" },
          ...invalid,
        } as Parameters<typeof webTransport>[0]),
      ).toThrow(field);
    }
  });

  it("rejects readiness before registration", async () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    await aug.onBoot?.();
    await expect(aug.transport!.ready!()).rejects.toThrow("before kernel registration");
    await aug.onShutdown?.();
  });

  it("fails closed when external auth replay protection has no explicit store", async () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-secret",
        audience: "agent-test",
        replayProtection: { enabled: true },
      },
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/replayProtection.*store/);
  });

  it("fails closed for every no-ledger anonymous replica", async () => {
    const options = {
      port: 0,
      auth: { type: "bearer" as const, token: "test-token" },
      allowAnonymous: true,
      rateLimitPerPeer: { maxPerMinute: 1 },
    };
    const first = webTransport(options);
    const second = webTransport(options);

    await expect(first.onBoot?.()).rejects.toThrow(/durable shared idempotency\.dbPath/);
    await expect(second.onBoot?.()).rejects.toThrow(/durable shared idempotency\.dbPath/);
  });

  it("fails closed on malformed external auth replay configuration", async () => {
    const malformed: unknown[] = [
      null,
      [],
      {},
      { enabled: "true" },
      { enabled: 1 },
      { store: createInMemoryExternalAuthReplayStore() },
      { enabled: false, store: createInMemoryExternalAuthReplayStore() },
    ];
    for (const replayProtection of malformed) {
      const aug = webTransport({
        port: 0,
        auth: { type: "bearer", token: "test-token" },
        externalAuth: {
          secret: "app-secret",
          audience: "agent-test",
          replayProtection: replayProtection as NonNullable<
            Parameters<typeof webTransport>[0]["externalAuth"]
          >["replayProtection"],
        },
      });
      await expect(aug.onBoot?.()).rejects.toThrow(/replayProtection/);
    }
  });

  it("treats readiness as idempotent after the listener is bound", async () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "web-ready-idempotent", model: "mock", augments: [aug] },
      createMockModel(),
    );
    await agent.start();
    await aug.transport!.ready!();
    await agent.stop();
  });

  it("rejects conflicting programmatic security audiences at registration", async () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      securityNamespace: "agent-a",
      visitorTokens: {
        enabled: true,
        signingKey: "visitor-signing-key",
        agentBinding: "agent-b",
      },
    });
    const agent = defineAgent(
      { name: "agent-a", model: "mock", augments: [aug] },
      createMockModel(),
    );
    await expect(agent.start()).rejects.toThrow(/securityNamespace must match/);
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
      __anonymousSessionId: "anon_session_creator_unused",
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
      __anonymousSessionId: "anon_session_creator_unused",
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
      __anonymousSessionId: "anon_session_no_auth",
      // __bearerValidated intentionally absent — simulates the
      // allowAnonymous bypass path where no bearer was validated
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon_session_no_auth");
  });

  it("Path 1: __bearerValidated=false explicitly → public:anonymous (no silent creator)", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: {},
      __anonymousSessionId: "anon_session_explicit_false",
      __bearerValidated: false,
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon_session_explicit_false");
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
      __anonymousSessionId: "anon_session_agent_unused",
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
      __anonymousSessionId: "anon_session_agent_unused",
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
      __anonymousSessionId: "anon_session_agent_unused",
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
      __anonymousSessionId: "anon_session_agent_unused",
    });
    expect(identity).toBeNull();
  });

  it("Path 2: partial agent credentials fail closed instead of downgrading", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "summarizer", sharedSecret: "s3cr3t" }],
      },
    });
    for (const headers of [{ "x-agent-id": "summarizer" }, { "x-agent-secret": "s3cr3t" }]) {
      expect(
        aug.transport!.identify({
          headers,
          __anonymousSessionId: "anon_session_agent_unused",
          __bearerValidated: true,
        }),
      ).toBeNull();
    }
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
      __anonymousSessionId: "anon_session_visitor_unused",
    });
    expect(identity).not.toBeNull();
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("recognized");
    expect(identity?.id).toBe("vis_abc123");
    expect(identity?.kind).toBe("human");
  });

  it("Path 3: carries only the signed or verified organization into peer ownership", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: { "x-org-id": "caller-controlled" },
      __visitorPayload: {
        visitorId: "vis_shared",
        agentId: "test-agent",
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 86_400_000,
        orgId: "verified-org",
      },
    });
    expect(identity).toEqual(
      expect.objectContaining({
        id: "vis_shared",
        trustLevel: "public",
        publicSubstate: "recognized",
        orgId: "verified-org",
      }),
    );
  });

  // Path 4: Public anonymous — no agent headers, no visitor payload
  it("Path 4: no agent headers, no visitor token → public:anonymous", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: { "x-visitor-token": "some.stale.token" },
      __anonymousSessionId: "anon_session_anonymous_999",
    });
    expect(identity).not.toBeNull();
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon_session_anonymous_999");
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
      __anonymousSessionId: "anon_session_bare",
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon_session_bare");
  });

  it("Path 4: x-visitor-token header present but no payload uses verified anonymous session", () => {
    const aug = webTransport({
      port: 0,
      auth: { type: "bearer", token: "test-token" },
    });
    const identity = aug.transport!.identify({
      headers: { "x-visitor-token": "malformed-token" },
      __anonymousSessionId: "anon_session_invalid_visitor",
      // __visitorPayload NOT set — token verification failed
    });
    expect(identity?.trustLevel).toBe("public");
    expect(identity?.publicSubstate).toBe("anonymous");
    expect(identity?.id).toBe("anon_session_invalid_visitor");
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

  it("binds anonymous thread history to a server-minted session", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 19360;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    const run = (anonymousSession?: string) =>
      fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(anonymousSession ? { "x-auggy-anonymous-session": anonymousSession } : {}),
        },
        body: JSON.stringify({
          threadId: "caller-selected-thread",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

    try {
      const bootstrap = await run();
      expect(bootstrap.status).toBe(428);
      const session = bootstrap.headers.get("x-auggy-anonymous-session");
      expect(await bootstrap.json()).toEqual({ error: "anonymous_session_required" });
      expect(model.calls).toHaveLength(0);

      const first = await run(session ?? undefined);
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      expect(firstBody).toContain("RUN_FINISHED");
      const firstThreadId = firstBody.match(/"threadId":"([^"]+)"/)?.[1];
      expect(firstThreadId).toMatch(/^web_thread_/);
      expect(model.calls).toHaveLength(1);

      const continuation = await run(session ?? undefined);
      expect(continuation.status).toBe(200);
      const continuationBody = await continuation.text();
      expect(continuationBody).toContain("RUN_FINISHED");
      expect(continuationBody).toContain(`"threadId":"${firstThreadId}"`);
      expect(model.calls).toHaveLength(2);

      const takeoverBootstrap = await run();
      expect(takeoverBootstrap.status).toBe(428);
      const takeoverSession = takeoverBootstrap.headers.get("x-auggy-anonymous-session");
      expect(await takeoverBootstrap.json()).toEqual({ error: "anonymous_session_required" });
      expect(model.calls).toHaveLength(2);

      const attemptedTakeover = await run(takeoverSession ?? undefined);
      expect(attemptedTakeover.status).toBe(200);
      const takeoverBody = await attemptedTakeover.text();
      expect(takeoverBody).toContain("RUN_FINISHED");
      expect(takeoverBody).not.toContain(`"threadId":"${firstThreadId}"`);
      expect(model.calls).toHaveLength(3);
      expect(model.calls[2]?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("rejects a forged anonymous session before model execution", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 19361;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const response = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-anonymous-session": "forged.session",
        },
        body: JSON.stringify({
          threadId: "caller-selected-thread",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-auggy-anonymous-session-status")).toBe("invalid");
      expect(await response.json()).toEqual({ error: "invalid anonymous session" });
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("rejects an expired anonymous session before model execution", async () => {
    const bearer = "expired-session-agent-secret";
    const audience = "expired-session-agent";
    const secret = createHash("sha256")
      .update("auggy-anonymous-session-v1\0")
      .update(audience)
      .update("\0")
      .update(bearer)
      .digest();
    const expired = createAnonymousSessionManager({
      audience,
      secret,
      ttlMs: 1,
      now: () => 1,
    }).issue().token;
    const model = createMockModel({ response: "must not execute" });
    const port = 19396;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: bearer },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: audience, model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const response = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-anonymous-session": expired,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-auggy-anonymous-session-status")).toBe("invalid");
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("does not mint recognized visitor authority from an invalid token", async () => {
    const signingKey = "replacement-token-signing-key";
    const audience = "replacement-token-agent";
    const model = createMockModel({ response: "hello" });
    const port = 19397;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "replacement-token-bearer" },
      allowAnonymous: true,
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding: audience,
      },
    });
    const agent = defineAgent({ name: audience, model: "mock", augments: [aug] }, model);
    await agent.start();

    const request = (visitorToken?: string, anonymousSession?: string) =>
      fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(visitorToken ? { "x-visitor-token": visitorToken } : {}),
          ...(anonymousSession ? { "x-auggy-anonymous-session": anonymousSession } : {}),
        },
        body: JSON.stringify({
          threadId: "replacement-token-thread",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

    try {
      const bootstrap = await request();
      const anonymousSession = bootstrap.headers.get("x-auggy-anonymous-session");
      expect(bootstrap.status).toBe(428);
      expect(await bootstrap.json()).toEqual({ error: "anonymous_session_required" });
      expect(anonymousSession).toBeTruthy();
      expect(model.calls).toHaveLength(0);

      const replacement = await request("invalid-token", anonymousSession ?? undefined);
      const replacementToken = replacement.headers.get("x-visitor-token");
      expect(replacement.status).toBe(200);
      expect(replacementToken).toBeNull();
      const replacementBody = await replacement.text();
      const canonicalThread = replacementBody.match(/"threadId":"([^"]+)"/)?.[1];
      expect(canonicalThread).toMatch(/^web_thread_/);

      const continued = await request("still-invalid", anonymousSession ?? undefined);
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain(`"threadId":"${canonicalThread}"`);
      expect(model.calls).toHaveLength(2);
    } finally {
      await agent.stop();
    }
  });

  it("verifies anonymous sessions across instances with the same agent secret", async () => {
    const firstPort = 19362;
    const firstTransport = webTransport({
      port: firstPort,
      auth: { type: "bearer", token: "shared-agent-secret" },
      allowAnonymous: true,
    });
    const firstAgent = defineAgent(
      { name: "test", model: "mock", augments: [firstTransport] },
      createMockModel(),
    );
    await firstAgent.start();
    let session: string | null = null;
    try {
      const first = await fetch(`http://localhost:${firstPort}/agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "first-instance-thread",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      session = first.headers.get("x-auggy-anonymous-session");
      await first.text();
    } finally {
      await firstAgent.stop();
    }
    expect(session).toBeTruthy();

    const secondPort = 19363;
    const secondModel = createMockModel();
    const secondTransport = webTransport({
      port: secondPort,
      auth: { type: "bearer", token: "shared-agent-secret" },
      allowAnonymous: true,
    });
    const secondAgent = defineAgent(
      { name: "test", model: "mock", augments: [secondTransport] },
      secondModel,
    );
    await secondAgent.start();
    try {
      const continued = await fetch(`http://localhost:${secondPort}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-anonymous-session": session ?? "",
        },
        body: JSON.stringify({
          threadId: "second-instance-thread",
          messages: [{ role: "user", content: "hello again" }],
        }),
      });
      expect(continued.status).toBe(200);
      await continued.text();
      expect(secondModel.calls).toHaveLength(1);
    } finally {
      await secondAgent.stop();
    }
  });

  it("rejects anonymous-session replay across registered agent audiences", async () => {
    const bearer = "shared-cross-agent-bearer";
    const firstTransport = webTransport({
      port: 19398,
      auth: { type: "bearer", token: bearer },
      allowAnonymous: true,
    });
    const firstAgent = defineAgent(
      { name: "anonymous-agent-a", model: "mock", augments: [firstTransport] },
      createMockModel(),
    );
    await firstAgent.start();
    let session: string | null = null;
    try {
      const response = await fetch("http://localhost:19398/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      });
      session = response.headers.get("x-auggy-anonymous-session");
      await response.text();
    } finally {
      await firstAgent.stop();
    }

    const secondModel = createMockModel({ response: "must not run" });
    const secondTransport = webTransport({
      port: 19399,
      auth: { type: "bearer", token: bearer },
      allowAnonymous: true,
    });
    const secondAgent = defineAgent(
      { name: "anonymous-agent-b", model: "mock", augments: [secondTransport] },
      secondModel,
    );
    await secondAgent.start();
    try {
      const replay = await fetch("http://localhost:19399/agent/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-anonymous-session": session ?? "",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      });
      expect(replay.status).toBe(401);
      expect(replay.headers.get("x-auggy-anonymous-session-status")).toBe("invalid");
      expect(secondModel.calls).toHaveLength(0);
    } finally {
      await secondAgent.stop();
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

  it("uses only an anonymous session for first-contact bootstrap", async () => {
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
      // The server-minted anonymous session is the sole continuity
      // capability. An invalid visitor token must never be exchanged for a
      // recognized visitor credential.
      const url = `http://localhost:${port}/agent/run`;
      const init = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "bootstrap",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      } satisfies RequestInit;
      const bootstrap = await fetch(url, init);
      const session = bootstrap.headers.get("x-auggy-anonymous-session");
      const visitorToken = bootstrap.headers.get("x-visitor-token");
      expect(bootstrap.status).toBe(428);
      expect(session).toBeTruthy();
      expect(visitorToken).toBeNull();
      expect(await bootstrap.json()).toEqual({ error: "anonymous_session_required" });
      expect(model.calls).toHaveLength(0);

      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("x-auggy-anonymous-session", session ?? "");
      const admitted = await fetch(url, { ...init, headers: retryHeaders });
      expect(admitted.status).toBe(200);
      await admitted.text();
      expect(model.calls).toHaveLength(1);
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

  it("wrong or partial agent credentials return 401 without execution", async () => {
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
      const attemptedCredentials: Array<Record<string, string>> = [
        {
          "x-agent-id": "worker-agent",
          "x-agent-secret": "wrong-secret",
        },
        { "x-agent-id": "worker-agent" },
        { "x-agent-secret": "correct-secret" },
      ];
      for (const attemptedAgentHeaders of attemptedCredentials) {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-token",
            ...attemptedAgentHeaders,
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hello" }],
          }),
        });
        expect(resp.status).toBe(401);
        expect(await resp.json()).toEqual({ error: "invalid agent credentials" });
      }
      expect(model.calls).toHaveLength(0);
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

  it("rejects an oversized aggregate JSON body before model execution", async () => {
    const model = createMockModel();
    const port = 18846;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      maxRequestBodyBytes: 128,
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
          messages: Array.from({ length: 20 }, () => ({ role: "user", content: "x" })),
        }),
      });
      expect(resp.status).toBe(413);
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("rejects malformed message shapes and oversized identifiers before model execution", async () => {
    const model = createMockModel();
    const port = 18849;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "validated-run-shape", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();
    try {
      for (const body of [
        null,
        { messages: [null] },
        { messages: [{ role: "user", content: 7 }] },
        { messages: [{ role: "user", content: "ok" }], taskId: 7 },
      ]) {
        const response = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-token",
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      const oversized = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "ok" }],
          threadId: "t".repeat(513),
        }),
      });
      expect(oversized.status).toBe(413);
      expect(model.calls).toHaveLength(0);
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

  it("aborts model work when one live SSE event exceeds the delivery cap", async () => {
    let sawAbortedSignal = false;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(_prompt, opts) {
        opts?.onDelta?.({ kind: "text_delta", text: "x".repeat(2048) });
        sawAbortedSignal = opts?.signal?.aborted === true;
        return {
          content: "x".repeat(2048),
          inputTokens: 1,
          outputTokens: 1,
          finishReason: "end_turn",
        };
      },
    };
    const port = 18847;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      maxPendingSseBytes: 512,
    });
    const agent = defineAgent({ name: "bounded-sse", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const response = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "stream" }] }),
      });
      await response.text().catch(() => "");
      expect(sawAbortedSignal).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("aborts model work when a slow-client SSE queue exceeds its event cap", async () => {
    let sawAbortedSignal = false;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(_prompt, opts) {
        for (let index = 0; index < 16; index++) {
          opts?.onDelta?.({ kind: "text_delta", text: `${index}` });
        }
        sawAbortedSignal = opts?.signal?.aborted === true;
        return {
          content: "0123456789101112131415",
          inputTokens: 1,
          outputTokens: 1,
          finishReason: "end_turn",
        };
      },
    };
    const port = 18850;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      maxPendingSseBytes: 64 * 1024,
      maxPendingSseEvents: 1,
    });
    const agent = defineAgent(
      { name: "bounded-sse-events", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();
    try {
      const response = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "stream" }] }),
      });
      await response.text().catch(() => "");
      expect(sawAbortedSignal).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("drains queued SSE events before closing a completed stream", async () => {
    const deltas = Array.from({ length: 32 }, (_, index) => `chunk-${index}|`);
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(_prompt, opts) {
        for (const text of deltas) opts?.onDelta?.({ kind: "text_delta", text });
        return {
          content: deltas.join(""),
          inputTokens: 1,
          outputTokens: 1,
          finishReason: "end_turn",
        };
      },
    };
    const port = 18848;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      maxPendingSseBytes: 64 * 1024,
      maxPendingSseEvents: 64,
    });
    const agent = defineAgent({ name: "drained-sse", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const response = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "stream" }] }),
      });
      const body = await response.text();
      for (const delta of deltas) expect(body).toContain(delta);
      expect(body).toContain("RUN_FINISHED");
    } finally {
      await agent.stop();
    }
  });

  it("normalizes raw provider overload failures in AG-UI RUN_ERROR", async () => {
    const rawOverload =
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Ccq89SgGiznewkZxfZDk3"}';
    const model: ModelClient = {
      maxContextTokens: 100_000,
      async complete() {
        throw new Error(rawOverload);
      },
      countTokens(text: string) {
        return Math.ceil(text.length / 4);
      },
    };
    const port = 18918;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
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
      const body = await resp.text();
      const events = body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
        type: string;
        message?: string;
        code?: string;
      }>;

      const errEvent = events.find((e) => e.type === "RUN_ERROR");
      expect(errEvent?.message).toBe(
        "Model provider is overloaded. This is retryable; wait a moment and try again.",
      );
      expect(errEvent?.code).toBe("PROVIDER_OVERLOADED");
      expect(JSON.stringify(errEvent)).not.toContain("request_id");
      expect(JSON.stringify(errEvent)).not.toContain("overloaded_error");
      expect(events.find((e) => e.type === "RUN_FINISHED")).toBeDefined();
    } finally {
      await agent.stop();
    }
  });

  it("emits RUN_ERROR + RUN_FINISHED when a turn is rejected by the rate limiter", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 18908;
    // Use agent credentials so both requests have the same stable peer ID
    // (agent:rate-limited-agent), which the rate limiter can track across requests.
    // Agent credentials provide one stable peer key for the kernel limiter.
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
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
      expect(errEvent?.code).toBe("SCHEDULER_RATE_LIMITED");
    } finally {
      await agent.stop();
    }
  });

  it("rate-limits admitted anonymous executions across multiple minted sessions", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 19617;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
      rateLimitPerPeer: {
        maxPerMinute: 1,
        anonymousNetwork: { mode: "single-process-development" },
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();
    const url = `http://localhost:${port}/agent/run`;
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    } satisfies RequestInit;

    try {
      const firstContact = await fetch(url, init);
      const session = firstContact.headers.get("x-auggy-anonymous-session");
      expect(firstContact.status).toBe(428);
      expect(session).toBeTruthy();
      await firstContact.json();

      const admittedHeaders = new Headers(init.headers);
      admittedHeaders.set("x-auggy-anonymous-session", session ?? "");
      const admitted = await fetch(url, { ...init, headers: admittedHeaders });
      expect(admitted.status).toBe(200);
      await admitted.text();
      expect(model.calls).toHaveLength(1);

      const multipliedIdentity = await fetch(url, init);
      const multipliedSession = multipliedIdentity.headers.get("x-auggy-anonymous-session");
      expect(multipliedIdentity.status).toBe(428);
      expect(multipliedSession).toBeTruthy();
      await multipliedIdentity.json();

      const multipliedHeaders = new Headers(init.headers);
      multipliedHeaders.set("x-auggy-anonymous-session", multipliedSession ?? "");
      const multipliedExecution = await fetch(url, { ...init, headers: multipliedHeaders });
      expect(multipliedExecution.status).toBe(429);
      expect(await multipliedExecution.json()).toEqual({ error: "rate-limited" });
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("shares anonymous network admission limits across replicas", async () => {
    const tmp = await createTempDir();
    const dbPath = join(tmp.path, "web-idempotency.db");
    const modelA = createMockModel({ response: "a" });
    const modelB = createMockModel({ response: "b" });
    const common = {
      auth: { type: "bearer" as const, token: "replica-token" },
      allowAnonymous: true,
      securityNamespace: "replicated-agent",
      rateLimitPerPeer: { maxPerMinute: 1 },
      idempotency: { dbPath },
    };
    const first = defineAgent(
      {
        name: "replica-a",
        model: "mock",
        augments: [webTransport({ ...common, port: 19618 })],
      },
      modelA,
    );
    const second = defineAgent(
      {
        name: "replica-b",
        model: "mock",
        augments: [webTransport({ ...common, port: 19619 })],
      },
      modelB,
    );
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    } satisfies RequestInit;

    await first.start();
    await second.start();
    try {
      const bootstrapA = await fetch("http://localhost:19618/agent/run", init);
      const sessionA = bootstrapA.headers.get("x-auggy-anonymous-session");
      expect(bootstrapA.status).toBe(428);
      await bootstrapA.json();

      const bootstrapB = await fetch("http://localhost:19619/agent/run", init);
      const sessionB = bootstrapB.headers.get("x-auggy-anonymous-session");
      expect(bootstrapB.status).toBe(428);
      await bootstrapB.json();

      const headersA = new Headers(init.headers);
      headersA.set("x-auggy-anonymous-session", sessionA ?? "");
      const admitted = await fetch("http://localhost:19618/agent/run", {
        ...init,
        headers: headersA,
      });
      expect(admitted.status).toBe(200);
      await admitted.text();

      const headersB = new Headers(init.headers);
      headersB.set("x-auggy-anonymous-session", sessionB ?? "");
      const denied = await fetch("http://localhost:19619/agent/run", {
        ...init,
        headers: headersB,
      });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toEqual({ error: "rate-limited" });
      expect(modelA.calls).toHaveLength(1);
      expect(modelB.calls).toHaveLength(0);
    } finally {
      await second.stop();
      await first.stop();
      await tmp.cleanup();
    }
  });

  it("replays an exact keyed anonymous result without consuming another execution slot", async () => {
    const tmp = await createTempDir();
    const model = createMockModel({ response: "once" });
    const port = 19620;
    const agent = defineAgent(
      {
        name: "anonymous-keyed-rate-limit",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
            allowAnonymous: true,
            securityNamespace: "anonymous-keyed-rate-limit",
            rateLimitPerPeer: { maxPerMinute: 1 },
            idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
          }),
        ],
      },
      model,
    );
    const url = `http://localhost:${port}/agent/run`;
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
    const bootstrapHeaders = {
      "content-type": "application/json",
      "idempotency-key": "same-execution",
    };

    await agent.start();
    try {
      const bootstrap = await fetch(url, {
        method: "POST",
        headers: bootstrapHeaders,
        body,
      });
      expect(bootstrap.status).toBe(428);
      const session = bootstrap.headers.get("x-auggy-anonymous-session") ?? "";
      await bootstrap.json();

      const headers = new Headers(bootstrapHeaders);
      headers.set("x-auggy-anonymous-session", session);
      const first = await fetch(url, { method: "POST", headers, body });
      expect(first.status).toBe(200);
      const firstBody = await first.text();

      const replay = await fetch(url, { method: "POST", headers, body });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(firstBody);
      expect(model.calls).toHaveLength(1);

      headers.set("idempotency-key", "different-execution");
      const denied = await fetch(url, { method: "POST", headers, body });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toEqual({ error: "rate-limited" });
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
      await tmp.cleanup();
    }
  });

  it("shares one anonymous budget across rotating IPv6 addresses in a /64", async () => {
    const tmp = await createTempDir();
    const model = createMockModel({ response: "once" });
    const port = 19621;
    const agent = defineAgent(
      {
        name: "anonymous-ipv6-rate-limit",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
            allowAnonymous: true,
            trustedProxies: ["127.0.0.1", "::1"],
            rateLimitPerPeer: { maxPerMinute: 1 },
            idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
          }),
        ],
      },
      model,
    );
    const url = `http://localhost:${port}/agent/run`;
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });

    async function issueAndRun(ip: string): Promise<Response> {
      const bootstrap = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body,
      });
      expect(bootstrap.status).toBe(428);
      const headers = new Headers({
        "content-type": "application/json",
        "x-forwarded-for": ip,
      });
      headers.set("x-auggy-anonymous-session", bootstrap.headers.get("x-auggy-anonymous-session")!);
      await bootstrap.json();
      return fetch(url, { method: "POST", headers, body });
    }

    await agent.start();
    try {
      const admitted = await issueAndRun("2606:4700:4700:1::1111");
      expect(admitted.status).toBe(200);
      await admitted.text();

      const denied = await issueAndRun("2606:4700:4700:1::2222");
      expect(denied.status).toBe(429);
      expect(await denied.json()).toEqual({ error: "rate-limited" });
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
      await tmp.cleanup();
    }
  });

  it("rejects ambiguous forwarded identities instead of charging the proxy bucket", async () => {
    const tmp = await createTempDir();
    const model = createMockModel({ response: "must not run" });
    const port = 19622;
    const agent = defineAgent(
      {
        name: "anonymous-forwarded-rejection",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
            allowAnonymous: true,
            trustedProxies: ["127.0.0.1", "::1"],
            rateLimitPerPeer: { maxPerMinute: 1 },
            idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
          }),
        ],
      },
      model,
    );
    const url = `http://localhost:${port}/agent/run`;
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });

    await agent.start();
    try {
      const malformed = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "malformed, 203.0.113.1",
        },
        body,
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "invalid_forwarded_request" });

      const ambiguous = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.1",
          "x-real-ip": "203.0.113.1",
        },
        body,
      });
      expect(ambiguous.status).toBe(400);
      expect(await ambiguous.json()).toEqual({ error: "invalid_forwarded_request" });
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
      await tmp.cleanup();
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

  it("rolls back a readiness bind failure and can start cleanly on retry", async () => {
    const port = 18911;
    const blocker = Bun.serve({ port, fetch: () => new Response("occupied") });
    let cleanups = 0;
    const resource: Augment = {
      name: "resource",
      onShutdown: async () => {
        cleanups += 1;
      },
    };
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [resource, webTransport({ port, auth: { type: "bearer", token: "test" } })],
      },
      createMockModel(),
    );

    await expect(agent.start()).rejects.toThrow();
    expect(cleanups).toBe(1);
    blocker.stop(true);

    await agent.start();
    try {
      expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);
    } finally {
      await agent.stop();
    }
    expect(cleanups).toBe(2);
  });

  it("returning visitor with valid token gets no new token issued", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18921;
    const key = await deriveSigningKey("test-signing-key");
    const issued = await createVisitorToken(key, "test", 3_600, "vis_returning");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      // F2: explicit signingKey required; ephemeral fallback removed.
      visitorTokens: {
        enabled: true,
        signingKey: "test-signing-key",
        identityLookup: (visitorId) => ({ visitorId }),
      },
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
      // A valid token minted by the verification boundary resolves recognized
      // and is never rotated by the generic transport.
      // Bearer kept here to verify the documented semantic: valid visitor-token
      // alongside bearer still resolves to recognized (Path 3 fires because
      // __visitorPayload is populated; Path 1 is skipped).
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-visitor-token": issued.token,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello again" }] }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("x-visitor-token")).toBeNull();
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("POST /agent/run resolves a valid external auth assertion as a recognized public peer", async () => {
    const model = createMockModel({ response: "hi app user" });
    const port = 18923;
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "test",
      provider: "clerk",
      subject: "user_123",
      ttlSeconds: 60,
    });
    const key = await deriveSigningKey("visitor-route-secret");
    const staleIdentity = await createVisitorToken(key, "test", 3600, "vis_previous_user");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      cors: { origins: ["https://app.example"] },
      visitorTokens: {
        enabled: true,
        signingKey: "visitor-route-secret",
        agentBinding: "test",
      },
      externalAuth: {
        secret: "app-auth-secret",
        header: " X-Product-Identity ",
        audience: "test",
        allowedProviders: ["clerk"],
        visitorId: (claims) => `vis_app_${claims.subject}`,
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
          origin: "https://app.example",
          "x-visitor-token": staleIdentity.token,
          "x-product-identity": assertion,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello from app" }],
        }),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("x-visitor-token")).toBeNull();
      await resp.text();

      const system = model.calls[0]?.systemBlocks.join("\n") ?? "";
      expect(system).toContain("trust: public");
      expect(system).toContain(
        `Runtime identity: ${externalMappedVisitorId(
          { provider: "clerk", subject: "user_123" },
          "vis_app_user_123",
        )}`,
      );

      const preflight = await fetch(`http://localhost:${port}/agent/run`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example" },
      });
      expect(preflight.headers.get("access-control-allow-headers")).toContain("x-product-identity");
    } finally {
      await agent.stop();
    }
  });

  it("POST /agent/run accepts external auth assertions when anonymous access is disabled", async () => {
    const model = createMockModel({ response: "hi app user" });
    const port = 19610;
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "test",
      provider: "clerk",
      subject: "user_123",
      ttlSeconds: 60,
    });
    const aug = webTransport({
      port,
      allowAnonymous: false,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: "visitor-route-secret",
        agentBinding: "test",
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "test",
        allowedProviders: ["clerk"],
        visitorId: (claims) => `vis_app_${claims.subject}`,
      },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const anonymousResp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello without app auth" }],
        }),
      });
      expect(anonymousResp.status).toBe(401);

      const appUserResp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-auth-assertion": assertion,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello from app" }],
        }),
      });
      expect(appUserResp.status).toBe(200);
      expect(appUserResp.headers.get("x-visitor-token")).toBeNull();
      await appUserResp.text();

      const system = model.calls[0]?.systemBlocks.join("\n") ?? "";
      expect(system).toContain("trust: public");
      expect(system).toContain(
        `Runtime identity: ${externalMappedVisitorId(
          { provider: "clerk", subject: "user_123" },
          "vis_app_user_123",
        )}`,
      );
    } finally {
      await agent.stop();
    }
  });

  it("POST /agent/run rejects mixed agent and external-auth credentials before execution", async () => {
    const model = createMockModel({ response: "must not execute" });
    const port = 19616;
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "test",
      provider: "clerk",
      subject: "user_123",
      ttlSeconds: 60,
      orgId: "visitor-org",
      scopes: ["orders.read"],
    });
    const aug = webTransport({
      port,
      allowAnonymous: false,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "worker", sharedSecret: "worker-secret" }],
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "test",
        allowedProviders: ["clerk"],
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const response = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-id": "worker",
          "x-agent-secret": "worker-secret",
          "x-org-id": "agent-org",
          "x-auggy-auth-assertion": assertion,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "combine credentials" }],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "conflicting authentication credentials",
      });
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("POST /agent/run rejects replayed external auth assertions when replay protection is enabled", async () => {
    const model = createMockModel({ response: "hi app user" });
    const port = 19613;
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "test",
      provider: "clerk",
      subject: "user_123",
      ttlSeconds: 60,
      jti: "run-jti-123",
    });
    const aug = webTransport({
      port,
      allowAnonymous: false,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "test",
        allowedProviders: ["clerk"],
        visitorId: (claims) => `vis_app_${claims.subject}`,
        replayProtection: {
          enabled: true,
          store: createInMemoryExternalAuthReplayStore(),
        },
      },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const first = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-auth-assertion": assertion,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello from app" }],
        }),
      });
      expect(first.status).toBe(200);
      await first.text();

      const replay = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-auth-assertion": assertion,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello again" }],
        }),
      });
      expect(replay.status).toBe(401);
      expect(await replay.json()).toEqual({ error: "unauthorized" });
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("POST /agent/run passes external auth claims to protected tools", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "read_orders", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "done", finishReason: "end_turn" });

    const port = 18924;
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "test",
      provider: "supabase",
      subject: "user_123",
      ttlSeconds: 60,
      scopes: ["orders.read"],
    });
    let observedScopes: readonly string[] | undefined;
    const protectedTools: Augment = {
      name: "protected-tools",
      tools: [
        {
          name: "read_orders",
          description: "Read orders",
          category: "search",
          input: z.object({}),
          requires: { scope: "orders.read" },
          execute: async (_input, context) => {
            if (context?.auth?.mode === "visitor" && context.auth.state === "recognized") {
              observedScopes = context.auth.externalAuth?.scopes;
            }
            return "orders";
          },
        },
      ],
    };
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: "visitor-route-secret",
        agentBinding: "test",
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "test",
        allowedProviders: ["supabase"],
        visitorId: (claims) => `vis_app_${claims.subject}`,
      },
    });
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [createIdentityAugment("test"), protectedTools, aug],
      },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auggy-auth-assertion": assertion,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "read my orders" }],
        }),
      });
      expect(resp.status).toBe(200);
      await resp.text();

      expect(observedScopes).toEqual(["orders.read"]);
      expect(model.calls).toHaveLength(2);
    } finally {
      await agent.stop();
    }
  });

  it("CORS preflight allows visitor and external auth assertion headers", async () => {
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
      expect(resp.headers.get("access-control-allow-headers")).toContain("x-auggy-auth-assertion");
    } finally {
      await agent.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Idempotency-Key tests
  // ---------------------------------------------------------------------------

  it("Idempotency-Key: valid key receives a server-minted run ID", async () => {
    const model = createMockModel({ response: "hello" });
    const port = 18930;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      idempotency: { dbPath: ":memory:" },
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
      expect(text).toMatch(/"runId":"[0-9a-f-]{36}"/);
      expect(text).not.toContain(idempotencyKey);
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
    // An invalid token must keep the request public:anonymous and must not be
    // exchanged for a fresh recognized credential.
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
      const { response: resp, visitorToken: newToken } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Malformed/garbage token — verification will fail.
            "x-visitor-token": "this.is.garbage",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      expect(resp.status).toBe(200);

      expect(newToken).toBeNull();

      // Verify the request was treated as anonymous, not recognized, by checking
      // that the identify() path selected anonymous. The SSE stream succeeds
      // (there's no cap here to trigger), so we verify the identify function
      // directly using the transport's identify method with no __visitorPayload
      // (which is what happens when token verification fails).
      const identifyArg = {
        headers: { "x-visitor-token": "this.is.garbage" },
        __anonymousSessionId: "anon_session_verify",
        // __visitorPayload is NOT set — mirrors what the HTTP handler does after failed verify
      };
      const identity = aug.transport!.identify(identifyArg);
      expect(identity?.trustLevel).toBe("public");
      expect(identity?.publicSubstate).toBe("anonymous");

      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("Fix 1: missing visitor token + visitorTokens enabled stays anonymous on first request", async () => {
    // A first-contact request with a present-but-invalid x-visitor-token
    // stays anonymous and receives no recognized visitor capability.
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
      // Send request with x-visitor-token header present but invalid.
      // No bearer: admitted via allowAnonymous-default-true in test env.
      const { response: resp, visitorToken: issuedToken } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-visitor-token": "invalid",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "first contact" }],
          }),
        },
      );
      expect(resp.status).toBe(200);

      expect(issuedToken).toBeNull();

      // The identify path must stay anonymous (no __visitorPayload injected
      // when token fails verification).
      const identity = aug.transport!.identify({
        headers: { "x-visitor-token": "invalid" },
        __anonymousSessionId: "anon_session_first_contact",
      });
      expect(identity?.publicSubstate).toBe("anonymous");

      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("Fix 1: valid visitor token classifies request as public:recognized", async () => {
    // Regression guard: valid tokens must still produce recognized trust.
    const model = createMockModel({ response: "hi" });
    const port = 18962;
    const key = await deriveSigningKey("test-signing-key");
    const validToken = await createVisitorToken(key, "test", 3_600, "vis_valid");
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
      const resp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          "x-visitor-token": validToken.token,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "recognized" }] }),
      });
      expect(resp.status).toBe(200);
      // A recognized visitor gets no new token (already has a valid one).
      expect(resp.headers.get("x-visitor-token")).toBeNull();
      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("a signed visitor absent from the configured identity authority stays anonymous", async () => {
    const model = createMockModel({ response: "anonymous only" });
    const port = 18963;
    const key = await deriveSigningKey("test-signing-key");
    const orphan = await createVisitorToken(key, "test", 3_600, "vis_orphan");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: "test-signing-key",
        identityLookup: () => null,
      },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const { response } = await bootstrapAnonymousRequest(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": orphan.token,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "do not recognize me" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("an unavailable visitor identity authority fails closed to anonymous", async () => {
    const model = createMockModel({ response: "anonymous only" });
    const port = 18964;
    const key = await deriveSigningKey("test-signing-key");
    const orphan = await createVisitorToken(key, "test", 3_600, "vis_unavailable");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: "test-signing-key",
        identityLookup: () => {
          throw new Error("identity store unavailable");
        },
      },
    });
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [createIdentityAugment("test"), aug] },
      model,
    );
    await agent.start();

    try {
      const { response } = await bootstrapAnonymousRequest(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": orphan.token,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "stay anonymous" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(model.calls).toHaveLength(1);
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

function withEnvSync<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const stripeTestEncoder = new TextEncoder();

async function stripeSignatureHeader(
  secret: string,
  payload: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    stripeTestEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    stripeTestEncoder.encode(`${timestamp}.${payload}`),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `t=${timestamp},v1=${hex}`;
}

describe("webTransport allowAnonymous (G3)", () => {
  it("admits no-bearer requests when allowAnonymous=true (explicit yaml)", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 28990;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const { response: resp } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        },
      );
      expect(resp.status).toBe(200);
      // Drain to release the connection cleanly.
      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("rejects wrong-bearer requests even when allowAnonymous=true", async () => {
    const model = createMockModel();
    const port = 28991;
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
    const port = 28992;
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
    const model = createMockModel();
    const port = 28993;
    const aug = withEnvSync({ NODE_ENV: "production", AUGGY_ALLOW_ANONYMOUS: undefined }, () =>
      webTransport({ port, auth: { type: "bearer", token: "t" } }),
    );
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

  it("uses env-based default: NODE_ENV unset → admit no-bearer", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 28994;
    const aug = withEnvSync({ NODE_ENV: undefined, AUGGY_ALLOW_ANONYMOUS: undefined }, () =>
      webTransport({ port, auth: { type: "bearer", token: "t" } }),
    );
    const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const { response: resp } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        },
      );
      expect(resp.status).toBe(200);
      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("env override: AUGGY_ALLOW_ANONYMOUS=true wins over NODE_ENV=production default", async () => {
    const model = createMockModel({ response: "ok" });
    const port = 28995;
    const aug = withEnvSync({ NODE_ENV: "production", AUGGY_ALLOW_ANONYMOUS: "true" }, () =>
      webTransport({ port, auth: { type: "bearer", token: "t" } }),
    );
    const agent = defineAgent({ name: "t", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const { response: resp } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        },
      );
      expect(resp.status).toBe(200);
      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("env override: AUGGY_ALLOW_ANONYMOUS=false wins over NODE_ENV unset default", async () => {
    const model = createMockModel();
    const port = 28996;
    const aug = withEnvSync({ NODE_ENV: undefined, AUGGY_ALLOW_ANONYMOUS: "false" }, () =>
      webTransport({ port, auth: { type: "bearer", token: "t" } }),
    );
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

  it("yaml wins over env: allowAnonymous=false in opts overrides AUGGY_ALLOW_ANONYMOUS=true", async () => {
    const model = createMockModel();
    const port = 28997;
    const aug = withEnvSync({ AUGGY_ALLOW_ANONYMOUS: "true", NODE_ENV: undefined }, () =>
      webTransport({
        port,
        auth: { type: "bearer", token: "t" },
        allowAnonymous: false,
      }),
    );
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

  it("emits a concise boot log line for anonymous posture", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await withEnv({ NODE_ENV: "production", AUGGY_ALLOW_ANONYMOUS: undefined }, async () => {
        const model = createMockModel();
        const port = 28998;
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
        const port = 28999;
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
        const port = 29000;
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
    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
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
          const port = 29001;
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
            expect(logs).toContain("[web] anonymous chat enabled (public default)");
          } finally {
            await agent.stop();
          }
        },
      );
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
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

describe("webTransport external auth config guard", () => {
  it("fails closed on malformed restrictive policies at boot", async () => {
    const malformedPolicies = [
      { secret: "current-secret", allowedProviders: "supabase-evil" },
      { secret: "current-secret", allowedProviders: [] },
      { secret: "current-secret", maxTtlSeconds: "not-a-number" },
      { secret: "current-secret", maxTtlSeconds: Number.NaN },
      { secret: "current-secret", header: 42 },
      { secret: "current-secret", secrets: [{ secret: 42 }] },
    ];
    for (const externalAuth of malformedPolicies) {
      const aug = webTransport({
        port: 0,
        auth: { type: "bearer", token: "test-token" },
        externalAuth: externalAuth as unknown as NonNullable<
          Parameters<typeof webTransport>[0]["externalAuth"]
        >,
      });
      await expect(aug.onBoot?.()).rejects.toThrow(/externalAuth/);
    }
  });

  it("throws if external auth rotation keys are blank", async () => {
    const model = createMockModel({ response: "ok" });
    const currentKeyAug = webTransport({
      port: 19620,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "current-secret",
        keyId: " ",
      },
    });
    const currentKeyAgent = defineAgent(
      { name: "test-current-key", model: "mock", augments: [currentKeyAug] },
      model,
    );
    await expect(currentKeyAgent.start()).rejects.toThrow(/externalAuth\.keyId/);

    const previousKeyAug = webTransport({
      port: 19621,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "current-secret",
        secrets: [{ keyId: "", secret: "previous-secret" }],
      },
    });
    const previousKeyAgent = defineAgent(
      { name: "test-previous-key", model: "mock", augments: [previousKeyAug] },
      model,
    );
    await expect(previousKeyAgent.start()).rejects.toThrow(/externalAuth\.secrets keyId/);
  });

  it("rejects invalid and credential-conflicting assertion headers", async () => {
    const model = createMockModel({ response: "ok" });
    for (const [index, header] of [
      "authorization",
      "idempotency-key",
      "cookie",
      "x-forwarded-for",
      "bad\nheader",
    ].entries()) {
      const aug = webTransport({
        port: 19622 + index,
        auth: { type: "bearer", token: "test-token" },
        externalAuth: { secret: "current-secret", header },
      });
      const agent = defineAgent(
        { name: `test-header-${index}`, model: "mock", augments: [aug] },
        model,
      );
      await expect(agent.start()).rejects.toThrow(/non-reserved x-\* HTTP header/);
    }
  });
});

describe("webTransport CORS config guard", () => {
  it("fails closed when the static CORS response cannot represent the configured origins", async () => {
    const model = createMockModel({ response: "ok" });
    for (const origins of [[], ["https://one.example", "https://two.example"]]) {
      const aug = webTransport({
        port: 19630 + origins.length,
        auth: { type: "bearer", token: "test-token" },
        cors: { origins: origins as [string] },
      });
      const agent = defineAgent(
        { name: `test-cors-${origins.length}`, model: "mock", augments: [aug] },
        model,
      );
      await expect(agent.start()).rejects.toThrow(/exactly one browser origin/);
    }
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
      expect(body).toContain("<title>zip — Auggy agent</title>");
      expect(body).toContain("<h1>zip</h1>");
      expect(body).toContain('<p class="eyebrow">Auggy agent</p>');
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

  it("dispatches parameterized routes and passes decoded params to the handler", async () => {
    const model = createMockModel();
    const port = 19300;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture: Augment = {
      name: "items",
      httpRoutes: [
        defineRoute.get("/items/:id", {
          auth: "none",
          handler: ({ params, route }) =>
            json({ id: params.id, path: route.path, routeParams: route.params }),
        }),
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/items/hello%20world`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        id: "hello world",
        path: "/items/:id",
        routeParams: { id: "hello world" },
      });
    } finally {
      await agent.stop();
    }
  });

  it("exact routes take precedence over parameterized routes", async () => {
    const model = createMockModel();
    const port = 19301;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture: Augment = {
      name: "items",
      httpRoutes: [
        defineRoute.get("/items/:id", {
          auth: "none",
          handler: ({ params }) => json({ kind: "param", id: params.id }),
        }),
        defineRoute.get("/items/new", {
          auth: "none",
          handler: () => json({ kind: "exact" }),
        }),
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const exact = await fetch(`http://localhost:${port}/items/new`);
      expect(exact.status).toBe(200);
      expect(await exact.json()).toEqual({ kind: "exact" });

      const param = await fetch(`http://localhost:${port}/items/123`);
      expect(param.status).toBe(200);
      expect(await param.json()).toEqual({ kind: "param", id: "123" });
    } finally {
      await agent.stop();
    }
  });

  it("returns 400 when parameter validation fails", async () => {
    const model = createMockModel();
    const port = 19302;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture: Augment = {
      name: "items",
      httpRoutes: [
        defineRoute.get("/items/:id", {
          auth: "none",
          params: z.object({ id: z.string().regex(/^\d+$/) }),
          handler: ({ params }) => json({ id: params.id }),
        }),
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/items/not-a-number`);
      expect(resp.status).toBe(400);
      expect(await resp.json()).toEqual({ error: "bad-request", message: "Invalid request" });
    } finally {
      await agent.stop();
    }
  });

  it("GET request to a POST-only parameterized route returns 405 with Allow header", async () => {
    const model = createMockModel();
    const port = 19303;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture: Augment = {
      name: "items",
      httpRoutes: [
        defineRoute.post("/items/:id", {
          auth: "none",
          handler: ({ params }) => json({ id: params.id }),
        }),
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/items/123`);
      expect(resp.status).toBe(405);
      expect(resp.headers.get("allow")).toBe("POST");
    } finally {
      await agent.stop();
    }
  });

  it("adds configured CORS headers to augment route responses and method mismatches", async () => {
    const model = createMockModel();
    const port = 19970;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      cors: { origins: ["https://example.com"] },
    });
    const fixture: Augment = {
      name: "cors-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/cors/echo",
          auth: "none",
          handler: async () =>
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const ok = await fetch(`http://localhost:${port}/cors/echo`, {
        headers: { origin: "https://example.com" },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://example.com");
      expect(ok.headers.get("access-control-expose-headers")).toContain("x-visitor-token");

      const mismatch = await fetch(`http://localhost:${port}/cors/echo`, {
        method: "POST",
        headers: { origin: "https://example.com" },
      });
      expect(mismatch.status).toBe(405);
      expect(mismatch.headers.get("allow")).toBe("GET");
      expect(mismatch.headers.get("access-control-allow-origin")).toBe("https://example.com");
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

  it("verifies Stripe webhook signatures before dispatching policy routes", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET_TEST: "whsec_test_secret" }, async () => {
      const model = createMockModel();
      const port = 19980;
      const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
      const fixture: Augment = {
        name: "payments",
        httpRoutes: [
          defineRoute.post("/webhooks/stripe", {
            auth: "none",
            policy: webhook.signature("stripe", {
              secretEnv: "STRIPE_WEBHOOK_SECRET_TEST",
            }),
            body: z.object({
              id: z.string(),
              type: z.string(),
            }),
            handler: ({ body, webhook: webhookContext }) =>
              json({
                body,
                webhook: {
                  kind: webhookContext?.kind,
                  provider: webhookContext?.provider,
                  timestamp: webhookContext?.timestamp,
                  event: webhookContext?.event,
                },
              }),
          }),
        ],
      };
      const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
      const payload = JSON.stringify({
        id: "evt_test",
        type: "checkout.session.completed",
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await stripeSignatureHeader("whsec_test_secret", payload, timestamp);

      await agent.start();
      try {
        const resp = await fetch(`http://localhost:${port}/webhooks/stripe`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": signature,
          },
          body: payload,
        });

        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({
          body: {
            id: "evt_test",
            type: "checkout.session.completed",
          },
          webhook: {
            kind: "webhook.signature",
            provider: "stripe",
            timestamp,
            event: {
              id: "evt_test",
              type: "checkout.session.completed",
            },
          },
        });
      } finally {
        await agent.stop();
      }
    });
  });

  it("rejects Stripe webhook policy routes with missing or invalid signatures", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET_TEST: "whsec_test_secret" }, async () => {
      const model = createMockModel();
      const port = 19981;
      const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
      let calls = 0;
      const fixture: Augment = {
        name: "payments",
        httpRoutes: [
          defineRoute.post("/webhooks/stripe", {
            auth: "none",
            policy: webhook.signature("stripe", {
              secretEnv: "STRIPE_WEBHOOK_SECRET_TEST",
            }),
            handler: () => {
              calls += 1;
              return json({ ok: true });
            },
          }),
        ],
      };
      const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
      const payload = JSON.stringify({ id: "evt_test" });
      const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000;
      const staleSignature = await stripeSignatureHeader(
        "whsec_test_secret",
        payload,
        staleTimestamp,
      );

      await agent.start();
      try {
        const missing = await fetch(`http://localhost:${port}/webhooks/stripe`, {
          method: "POST",
          body: payload,
        });
        expect(missing.status).toBe(401);
        expect(await missing.json()).toEqual({ error: "webhook-signature-required" });

        const wrongSecret = await fetch(`http://localhost:${port}/webhooks/stripe`, {
          method: "POST",
          headers: {
            "stripe-signature": await stripeSignatureHeader("wrong", payload),
          },
          body: payload,
        });
        expect(wrongSecret.status).toBe(401);
        expect(await wrongSecret.json()).toEqual({ error: "webhook-signature-invalid" });

        const malformedPayload = "not-json";
        const malformed = await fetch(`http://localhost:${port}/webhooks/stripe`, {
          method: "POST",
          headers: {
            "stripe-signature": await stripeSignatureHeader("whsec_test_secret", malformedPayload),
          },
          body: malformedPayload,
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({ error: "webhook-payload-invalid" });

        const stale = await fetch(`http://localhost:${port}/webhooks/stripe`, {
          method: "POST",
          headers: { "stripe-signature": staleSignature },
          body: payload,
        });
        expect(stale.status).toBe(401);
        expect(await stale.json()).toEqual({ error: "webhook-signature-invalid" });
        expect(calls).toBe(0);
      } finally {
        await agent.stop();
      }
    });
  });

  it("fails boot when a Stripe webhook policy secret env is missing", async () => {
    await withEnv({ STRIPE_WEBHOOK_SECRET_TEST: undefined }, async () => {
      const model = createMockModel();
      const port = 19982;
      const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
      const fixture: Augment = {
        name: "payments",
        httpRoutes: [
          defineRoute.post("/webhooks/stripe", {
            auth: "none",
            policy: webhook.signature("stripe", {
              secretEnv: "STRIPE_WEBHOOK_SECRET_TEST",
            }),
            handler: () => json({ ok: true }),
          }),
        ],
      };
      const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);

      await expect(agent.start()).rejects.toThrow(
        "Stripe webhook secret env STRIPE_WEBHOOK_SECRET_TEST is not set",
      );
    });
  });

  it("fails boot closed for webhook signature providers without a verifier", async () => {
    await withEnv({ UNKNOWN_WEBHOOK_SECRET_TEST: "secret" }, async () => {
      const model = createMockModel();
      const port = 19983;
      const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
      let calls = 0;
      const fixture: Augment = {
        name: "agent-mail",
        httpRoutes: [
          defineRoute.post("/webhooks/agentmail", {
            auth: "none",
            policy: webhook.signature("unknown-provider", {
              secretEnv: "UNKNOWN_WEBHOOK_SECRET_TEST",
            }),
            handler: () => {
              calls += 1;
              return json({ ok: true });
            },
          }),
        ],
      };
      const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);

      await expect(agent.start()).rejects.toThrow(
        'Webhook signature provider "unknown-provider" is not supported',
      );
      expect(calls).toBe(0);

      // Registration failed before readiness, so the listener was never bound.
      const replacement = defineAgent(
        {
          name: "replacement",
          model: "mock",
          augments: [webTransport({ port, auth: { type: "bearer", token: "replacement" } })],
        },
        createMockModel(),
      );
      await replacement.start();
      await replacement.stop();
    });
  });

  it("passes route auth context to raw augment route handlers", async () => {
    const model = createMockModel();
    const port = 19304;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture: Augment = {
      name: "auth-context",
      httpRoutes: [
        {
          method: "GET",
          path: "/ctx/public",
          auth: "none",
          handler: async (_req, opts) =>
            json({
              auth: opts.auth?.mode ?? null,
              principal: opts.auth?.principal,
            }),
        },
        {
          method: "GET",
          path: "/ctx/private",
          auth: "bearer",
          handler: async (_req, opts) =>
            json({
              auth: opts.auth?.mode ?? null,
              principal: opts.auth?.principal,
            }),
        },
        {
          method: "GET",
          path: "/ctx/creator",
          auth: "creator",
          handler: async (_req, opts) =>
            json({
              auth: opts.auth?.mode ?? null,
              principal: opts.auth?.principal,
            }),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const publicResp = await fetch(`http://localhost:${port}/ctx/public`);
      expect(publicResp.status).toBe(200);
      expect(await publicResp.json()).toEqual({
        auth: "none",
        principal: {
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
        },
      });

      const privateResp = await fetch(`http://localhost:${port}/ctx/private`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(privateResp.status).toBe(200);
      expect(await privateResp.json()).toEqual({
        auth: "bearer",
        principal: {
          kind: "creator",
          trustLevel: "creator",
          peerId: "creator",
        },
      });

      const creatorResp = await fetch(`http://localhost:${port}/ctx/creator`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(creatorResp.status).toBe(200);
      expect(await creatorResp.json()).toEqual({
        auth: "creator",
        principal: {
          kind: "creator",
          trustLevel: "creator",
          peerId: "creator",
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: agent.required accepts admitted agent credentials and passes agent context", async () => {
    const model = createMockModel();
    const port = 19440;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "worker-agent", sharedSecret: "agent-secret" }],
      },
    });
    const fixture: Augment = {
      name: "agent-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/agent-api/search",
          auth: "agent.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/agent-api/search`, {
        headers: {
          "x-agent-id": "worker-agent",
          "x-agent-secret": "agent-secret",
          "x-peer-name": "Worker",
          "x-org-id": "org_123",
        },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        mode: "agent",
        agentId: "worker-agent",
        peerId: "agent:worker-agent",
        displayName: "Worker",
        orgId: "org_123",
        principal: {
          kind: "agent",
          trustLevel: "agent",
          agentId: "worker-agent",
          peerId: "agent:worker-agent",
          displayName: "Worker",
          orgId: "org_123",
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: agent.required rejects missing, wrong, and bearer-only credentials", async () => {
    const model = createMockModel();
    const port = 19441;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      access: {
        agents: [{ id: "worker-agent", sharedSecret: "agent-secret" }],
      },
    });
    const fixture: Augment = {
      name: "agent-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/agent-api/search",
          auth: "agent.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const missing = await fetch(`http://localhost:${port}/agent-api/search`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "agent-auth-required" });

      const wrongSecret = await fetch(`http://localhost:${port}/agent-api/search`, {
        headers: {
          "x-agent-id": "worker-agent",
          "x-agent-secret": "wrong-secret",
        },
      });
      expect(wrongSecret.status).toBe(401);
      expect(await wrongSecret.json()).toEqual({ error: "agent-auth-required" });

      const unknownAgent = await fetch(`http://localhost:${port}/agent-api/search`, {
        headers: {
          "x-agent-id": "unknown-agent",
          "x-agent-secret": "agent-secret",
        },
      });
      expect(unknownAgent.status).toBe(401);
      expect(await unknownAgent.json()).toEqual({ error: "agent-auth-required" });

      const bearerOnly = await fetch(`http://localhost:${port}/agent-api/search`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(bearerOnly.status).toBe(401);
      expect(await bearerOnly.json()).toEqual({ error: "agent-auth-required" });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required accepts a valid visitor token and passes visitor metadata", async () => {
    const model = createMockModel();
    const port = 19305;
    const signingKey = "visitor-route-secret";
    const agentBinding = "test-agent";
    const key = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(key, agentBinding, 3600, "vis_known");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding,
        identityLookup: (visitorId) =>
          visitorId === "vis_known"
            ? {
                visitorId,
                orgId: "org_lookup",
                email: "alice@example.com",
                verifiedAt: 1000,
                reverifyDueAt: 2000,
                externalAuth: {
                  provider: "session-store",
                  subject: "user_known",
                },
              }
            : null,
      },
    });
    const fixture: Augment = {
      name: "visitor-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-visitor-token": issued.token },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        mode: "visitor",
        state: "recognized",
        visitorId: "vis_known",
        agentId: agentBinding,
        issuedAt: issued.payload.issuedAt,
        expiresAt: issued.payload.expiresAt,
        orgId: "org_lookup",
        email: "alice@example.com",
        verifiedAt: 1000,
        reverifyDueAt: 2000,
        externalAuth: {
          provider: "session-store",
          subject: "user_known",
          orgId: "org_lookup",
        },
        principal: {
          kind: "visitor",
          trustLevel: "public",
          publicSubstate: "recognized",
          visitorId: "vis_known",
          agentId: agentBinding,
          orgId: "org_lookup",
          email: "alice@example.com",
          verifiedAt: 1000,
          reverifyDueAt: 2000,
          externalAuth: {
            provider: "session-store",
            subject: "user_known",
            orgId: "org_lookup",
          },
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required accepts a valid external auth assertion", async () => {
    const model = createMockModel();
    const port = 19308;
    const now = Date.now();
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      email: "alice@example.com",
      emailVerified: true,
      verifiedAt: now - 1000,
      orgId: "org_store_123",
      roles: ["customer", "vip"],
    });
    const visitorId = externalMappedVisitorId(
      { provider: "clerk", subject: "user_123", orgId: "org_store_123" },
      "vis_app_user_123",
    );
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "storefront-agent",
        allowedProviders: ["clerk"],
        maxTtlSeconds: 60,
        visitorId: (claims) => `vis_app_${claims.subject}`,
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": assertion },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        mode: "visitor",
        state: "recognized",
        visitorId,
        agentId: "storefront-agent",
        issuedAt: now,
        expiresAt: now + 60_000,
        orgId: "org_store_123",
        email: "alice@example.com",
        verifiedAt: now - 1000,
        externalAuth: {
          provider: "clerk",
          subject: "user_123",
          orgId: "org_store_123",
          roles: ["customer", "vip"],
        },
        principal: {
          kind: "visitor",
          trustLevel: "public",
          publicSubstate: "recognized",
          visitorId,
          agentId: "storefront-agent",
          orgId: "org_store_123",
          email: "alice@example.com",
          verifiedAt: now - 1000,
          externalAuth: {
            provider: "clerk",
            subject: "user_123",
            orgId: "org_store_123",
            roles: ["customer", "vip"],
          },
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required accepts external auth assertions signed by current or previous keys", async () => {
    const model = createMockModel();
    const port = 19611;
    const now = Date.now();
    const previousAssertion = createExternalAuthAssertion({
      secret: "previous-app-auth-secret",
      keyId: "2026-06",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_previous",
      now,
      ttlSeconds: 60,
    });
    const currentAssertion = createExternalAuthAssertion({
      secret: "current-app-auth-secret",
      keyId: "2026-07",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_current",
      now,
      ttlSeconds: 60,
    });
    const oldAssertion = createExternalAuthAssertion({
      secret: "old-app-auth-secret",
      keyId: "2026-05",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_old",
      now,
      ttlSeconds: 60,
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "current-app-auth-secret",
        keyId: "2026-07",
        secrets: [{ keyId: "2026-06", secret: "previous-app-auth-secret" }],
        audience: "storefront-agent",
        allowedProviders: ["clerk"],
        maxTtlSeconds: 60,
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const previous = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": previousAssertion },
      });
      expect(previous.status).toBe(200);
      expect(await previous.json()).toMatchObject({
        state: "recognized",
        externalAuth: {
          keyId: "2026-06",
          provider: "clerk",
          subject: "user_previous",
        },
      });

      const current = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": currentAssertion },
      });
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({
        state: "recognized",
        externalAuth: {
          keyId: "2026-07",
          provider: "clerk",
          subject: "user_current",
        },
      });

      const old = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": oldAssertion },
      });
      expect(old.status).toBe(401);
      expect(await old.json()).toEqual({ error: "visitor-auth-required" });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required rejects replay across instances sharing an atomic store", async () => {
    const model = createMockModel();
    const port = 19612;
    const replicaPort = 19614;
    const now = Date.now();
    const noJtiAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      jti: "route-jti-123",
    });
    let handlerCalls = 0;
    const replayStoreCalls: Array<{ jti: string; expiresAt: number; now: number }> = [];
    const consumedJtis = new Set<string>();
    const replayStore = {
      consume(jti: string, expiresAt: number, observedNow: number) {
        replayStoreCalls.push({ jti, expiresAt, now: observedNow });
        if (consumedJtis.has(jti)) return false;
        consumedJtis.add(jti);
        return true;
      },
    };
    const createTransport = (listenPort: number) =>
      webTransport({
        port: listenPort,
        auth: { type: "bearer", token: "test-token" },
        externalAuth: {
          secret: "app-auth-secret",
          audience: "storefront-agent",
          allowedProviders: ["clerk"],
          replayProtection: {
            enabled: true,
            store: replayStore,
          },
        },
      });
    const aug = createTransport(port);
    const replica = createTransport(replicaPort);
    const fixture: Augment = {
      name: "external-auth-replay-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    const replicaAgent = defineAgent(
      { name: "test", model: "mock", augments: [fixture, replica] },
      createMockModel(),
    );
    await agent.start();
    await replicaAgent.start();
    try {
      const missingJti = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": noJtiAssertion },
      });
      expect(missingJti.status).toBe(401);
      expect(await missingJti.json()).toEqual({ error: "visitor-auth-required" });

      const first = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": assertion },
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true });

      const replay = await fetch(`http://localhost:${replicaPort}/account`, {
        headers: { "x-auggy-auth-assertion": assertion },
      });
      expect(replay.status).toBe(401);
      expect(await replay.json()).toEqual({ error: "visitor-auth-required" });
      expect(handlerCalls).toBe(1);
      expect(replayStoreCalls.map((call) => call.jti)).toEqual(["route-jti-123", "route-jti-123"]);
      expect(replayStoreCalls.every((call) => call.expiresAt === now + 60_000)).toBe(true);
      expect(replayStoreCalls.every((call) => call.now >= now)).toBe(true);
    } finally {
      await replicaAgent.stop();
      await agent.stop();
    }
  });

  it("auth: visitor.required enforces delegated scope requirements before handlers", async () => {
    const model = createMockModel();
    const port = 19460;
    const now = Date.now();
    let handlerCalls = 0;
    const scopedAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      keyId: "2026-07",
      audience: "storefront-agent",
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      scopes: ["orders.read"],
    });
    const unscopedAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      keyId: "2026-07",
      audience: "storefront-agent",
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      orgId: "org_abc",
    });
    const auditEvents: DelegatedAuthorizationDeniedAuditEvent[] = [];
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-auth-secret",
        keyId: "2026-07",
        audience: "storefront-agent",
        allowedProviders: ["supabase"],
        maxTtlSeconds: 60,
      },
      onDelegatedAuthorizationDenied: (event) => auditEvents.push(event),
    });
    const fixture: Augment = {
      name: "authorized-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/orders",
          auth: "visitor.required",
          requires: { scope: "orders.read" },
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const denied = await fetch(`http://localhost:${port}/orders`, {
        headers: { "x-auggy-auth-assertion": unscopedAssertion },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: "forbidden",
        reason: "authorization-scope-missing",
      });
      expect(handlerCalls).toBe(0);
      expect(auditEvents).toEqual([
        {
          kind: "delegated_authorization_denied",
          reason: "authorization-scope-missing",
          requirement: { scope: "orders.read" },
          keyId: "2026-07",
          provider: "supabase",
          subject: "user_123",
          orgId: "org_abc",
          target: {
            type: "route",
            route: "GET /orders",
            method: "GET",
            path: "/orders",
            auth: "visitor.required",
          },
        },
      ]);

      const allowed = await fetch(`http://localhost:${port}/orders`, {
        headers: { "x-auggy-auth-assertion": scopedAssertion },
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ ok: true });
      expect(handlerCalls).toBe(1);
      expect(auditEvents).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required pins delegated authorization HTTP error bodies", async () => {
    const model = createMockModel();
    const port = 19462;
    const now = Date.now();
    const signingKey = "visitor-route-secret";
    const agentBinding = "storefront-agent";
    const key = await deriveSigningKey(signingKey);
    const visitorToken = await createVisitorToken(key, agentBinding, 3600, "vis_known");
    const invalidAssertion = createExternalAuthAssertion({
      secret: "wrong-app-auth-secret",
      audience: agentBinding,
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });
    const unscopedAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: agentBinding,
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });
    const wrongGrantAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: agentBinding,
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      grants: [{ action: "refund.issue", resource: "order_999" }],
    });
    const grantAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: agentBinding,
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      grants: [{ action: "refund.issue", resource: "order_123" }],
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding,
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: agentBinding,
        allowedProviders: ["supabase"],
        maxTtlSeconds: 60,
      },
    });
    let handlerCalls = 0;
    const fixture: Augment = {
      name: "authz-contract-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/profile",
          auth: "visitor.required",
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
        {
          method: "GET",
          path: "/needs-claims",
          auth: "visitor.required",
          requires: { scope: "orders.read" },
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
        {
          method: "GET",
          path: "/needs-scope",
          auth: "visitor.required",
          requires: { scope: "orders.read" },
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
        {
          method: "GET",
          path: "/orders/:id/refund",
          auth: "visitor.required",
          requires: { action: "refund.issue", resource: { param: "id" } },
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
        {
          method: "GET",
          path: "/broken/:id",
          auth: "visitor.required",
          requires: { action: "refund.issue", resource: { param: "missing" } },
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const missingCredentials = await fetch(`http://localhost:${port}/profile`);
      expect(missingCredentials.status).toBe(401);
      expect(await missingCredentials.json()).toEqual({ error: "visitor-auth-required" });

      const invalidExternalAssertion = await fetch(`http://localhost:${port}/profile`, {
        headers: { "x-auggy-auth-assertion": invalidAssertion },
      });
      expect(invalidExternalAssertion.status).toBe(401);
      expect(await invalidExternalAssertion.json()).toEqual({ error: "visitor-auth-required" });

      const missingClaims = await fetch(`http://localhost:${port}/needs-claims`, {
        headers: { "x-visitor-token": visitorToken.token },
      });
      expect(missingClaims.status).toBe(403);
      expect(await missingClaims.json()).toEqual({
        error: "forbidden",
        reason: "authorization-claims-required",
      });

      const missingScope = await fetch(`http://localhost:${port}/needs-scope`, {
        headers: { "x-auggy-auth-assertion": unscopedAssertion },
      });
      expect(missingScope.status).toBe(403);
      expect(await missingScope.json()).toEqual({
        error: "forbidden",
        reason: "authorization-scope-missing",
      });

      const missingGrant = await fetch(`http://localhost:${port}/orders/order_123/refund`, {
        headers: { "x-auggy-auth-assertion": wrongGrantAssertion },
      });
      expect(missingGrant.status).toBe(403);
      expect(await missingGrant.json()).toEqual({
        error: "forbidden",
        reason: "authorization-grant-missing",
      });

      const unresolvedResource = await fetch(`http://localhost:${port}/broken/order_123`, {
        headers: { "x-auggy-auth-assertion": grantAssertion },
      });
      expect(unresolvedResource.status).toBe(403);
      expect(await unresolvedResource.json()).toEqual({
        error: "forbidden",
        reason: "authorization-resource-unresolved",
      });
      expect(handlerCalls).toBe(0);
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required enforces delegated resource grants before handlers", async () => {
    const model = createMockModel();
    const port = 19461;
    const now = Date.now();
    let handlerCalls = 0;
    const allowedAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      grants: [
        {
          action: "refund.issue",
          resource: "order_123",
          constraints: { maxAmountCents: 5000, currency: "USD" },
        },
      ],
    });
    const wrongResourceAssertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "supabase",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      grants: [{ action: "refund.issue", resource: "order_999" }],
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "storefront-agent",
        allowedProviders: ["supabase"],
        maxTtlSeconds: 60,
      },
    });
    const fixture: Augment = {
      name: "authorized-routes",
      httpRoutes: [
        {
          method: "POST",
          path: "/orders/:id/refund",
          auth: "visitor.required",
          requires: {
            action: "refund.issue",
            resource: { param: "id" },
            constraints: { maxAmountCents: 5000 },
          },
          handler: async () => {
            handlerCalls += 1;
            return json({ ok: true });
          },
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const denied = await fetch(`http://localhost:${port}/orders/order_123/refund`, {
        method: "POST",
        headers: { "x-auggy-auth-assertion": wrongResourceAssertion },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: "forbidden",
        reason: "authorization-grant-missing",
      });
      expect(handlerCalls).toBe(0);

      const allowed = await fetch(`http://localhost:${port}/orders/order_123/refund`, {
        method: "POST",
        headers: { "x-auggy-auth-assertion": allowedAssertion },
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ ok: true });
      expect(handlerCalls).toBe(1);
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required can fall back from an invalid visitor token to external auth", async () => {
    const model = createMockModel();
    const port = 19309;
    const now = Date.now();
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "supabase",
      subject: "user_456",
      now,
      ttlSeconds: 60,
    });
    const visitorId = externalMappedVisitorId(
      { provider: "supabase", subject: "user_456" },
      "vis_linked_user_456",
    );
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: "visitor-route-secret",
        agentBinding: "storefront-agent",
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "storefront-agent",
        allowedProviders: ["supabase"],
        visitorId: "vis_linked_user_456",
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/account`, {
        headers: {
          "x-visitor-token": "stale-token",
          "x-auggy-auth-assertion": assertion,
        },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({
        mode: "visitor",
        state: "recognized",
        visitorId,
        agentId: "storefront-agent",
        principal: {
          kind: "visitor",
          trustLevel: "public",
          publicSubstate: "recognized",
          visitorId,
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required prefers current external auth over a matching visitor token", async () => {
    const model = createMockModel();
    const port = 19430;
    const now = Date.now();
    const signingKey = "visitor-route-secret";
    const agentBinding = "storefront-agent";
    const visitorId = externalMappedVisitorId(
      { provider: "clerk", subject: "user_123", orgId: "org_store_123" },
      "vis_app_user_123",
    );
    const key = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(key, agentBinding, 3600, visitorId);
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: agentBinding,
      provider: "clerk",
      subject: "user_123",
      now,
      ttlSeconds: 60,
      orgId: "org_store_123",
      roles: ["customer", "vip"],
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding,
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: agentBinding,
        allowedProviders: ["clerk"],
        visitorId: (claims) => `vis_app_${claims.subject}`,
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/account`, {
        headers: {
          "x-visitor-token": issued.token,
          "x-auggy-auth-assertion": assertion,
        },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({
        mode: "visitor",
        state: "recognized",
        visitorId,
        agentId: agentBinding,
        externalAuth: {
          provider: "clerk",
          subject: "user_123",
          orgId: "org_store_123",
          roles: ["customer", "vip"],
        },
        principal: {
          kind: "visitor",
          visitorId,
          agentId: agentBinding,
          externalAuth: {
            provider: "clerk",
            subject: "user_123",
            orgId: "org_store_123",
            roles: ["customer", "vip"],
          },
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required prefers current external auth over a different visitor token", async () => {
    const model = createMockModel();
    const port = 19431;
    const now = Date.now();
    const signingKey = "visitor-route-secret";
    const agentBinding = "storefront-agent";
    const key = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(key, agentBinding, 3600, "vis_token_user");
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: agentBinding,
      provider: "clerk",
      subject: "different_user",
      now,
      ttlSeconds: 60,
      roles: ["admin"],
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding,
      },
      externalAuth: {
        secret: "app-auth-secret",
        audience: agentBinding,
        allowedProviders: ["clerk"],
        visitorId: (claims) => `vis_app_${claims.subject}`,
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/account`, {
        headers: {
          "x-visitor-token": issued.token,
          "x-auggy-auth-assertion": assertion,
        },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        visitorId: string;
        externalAuth?: unknown;
        principal: { externalAuth?: unknown };
      };
      expect(body.visitorId).toBe(
        externalMappedVisitorId(
          { provider: "clerk", subject: "different_user" },
          "vis_app_different_user",
        ),
      );
      expect(body.externalAuth).toBeDefined();
      expect(body.principal.externalAuth).toBeDefined();
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required rejects missing, invalid, and revoked visitor tokens", async () => {
    const model = createMockModel();
    const port = 19306;
    const signingKey = "visitor-route-secret";
    const agentBinding = "test-agent";
    const key = await deriveSigningKey(signingKey);
    const revoked = await createVisitorToken(key, agentBinding, 3600, "vis_revoked");
    const mismatched = await createVisitorToken(key, agentBinding, 3600, "vis_mismatch");
    const orgMismatched = await createVisitorToken(key, agentBinding, 3600, "vis_org_mismatch");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding,
        revocationCheck: (visitorId) => visitorId === "vis_revoked",
        identityLookup: (visitorId) =>
          visitorId === "vis_mismatch"
            ? {
                visitorId: "vis_someone_else",
                email: "wrong@example.com",
                verifiedAt: 1000,
                reverifyDueAt: 2000,
              }
            : visitorId === "vis_org_mismatch"
              ? {
                  visitorId,
                  orgId: "org_lookup",
                  externalAuth: {
                    provider: "session-store",
                    subject: "user_org",
                    orgId: "org_assertion",
                  },
                }
              : null,
      },
    });
    const fixture: Augment = {
      name: "visitor-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const missing = await fetch(`http://localhost:${port}/account`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "visitor-auth-required" });

      const invalid = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-visitor-token": "not.a.valid.token" },
      });
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toEqual({ error: "visitor-auth-required" });

      const revokedResp = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-visitor-token": revoked.token },
      });
      expect(revokedResp.status).toBe(401);
      expect(await revokedResp.json()).toEqual({ error: "visitor-auth-required" });

      const mismatch = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-visitor-token": mismatched.token },
      });
      expect(mismatch.status).toBe(401);
      expect(await mismatch.json()).toEqual({ error: "visitor-auth-required" });

      const orgMismatch = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-visitor-token": orgMismatched.token },
      });
      expect(orgMismatch.status).toBe(401);
      expect(await orgMismatch.json()).toEqual({ error: "visitor-auth-required" });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.required rejects invalid external auth assertions", async () => {
    const model = createMockModel();
    const port = 19310;
    const assertion = createExternalAuthAssertion({
      secret: "app-auth-secret",
      audience: "storefront-agent",
      provider: "supabase",
      subject: "user_123",
      ttlSeconds: 60,
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "storefront-agent",
        allowedProviders: ["clerk"],
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/account",
          auth: "visitor.required",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/account`, {
        headers: { "x-auggy-auth-assertion": assertion },
      });
      expect(resp.status).toBe(401);
      expect(await resp.json()).toEqual({ error: "visitor-auth-required" });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.optional passes anonymous or recognized route context", async () => {
    const model = createMockModel();
    const port = 19307;
    const signingKey = "visitor-route-secret";
    const agentBinding = "test-agent";
    const key = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(key, agentBinding, 3600, "vis_optional");
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding,
        identityLookup: (visitorId) =>
          visitorId === "vis_optional"
            ? {
                visitorId,
                email: "optional@example.com",
                verifiedAt: 1000,
                reverifyDueAt: 2000,
              }
            : null,
      },
    });
    const fixture: Augment = {
      name: "visitor-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/recommendations",
          auth: "visitor.optional",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const anon = await fetch(`http://localhost:${port}/recommendations`);
      expect(anon.status).toBe(200);
      expect(await anon.json()).toEqual({
        mode: "visitor",
        state: "anonymous",
        principal: {
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
        },
      });

      const recognized = await fetch(`http://localhost:${port}/recommendations`, {
        headers: { "x-visitor-token": issued.token },
      });
      expect(recognized.status).toBe(200);
      expect(await recognized.json()).toMatchObject({
        mode: "visitor",
        state: "recognized",
        visitorId: "vis_optional",
        email: "optional@example.com",
        principal: {
          kind: "visitor",
          trustLevel: "public",
          publicSubstate: "recognized",
          visitorId: "vis_optional",
          email: "optional@example.com",
        },
      });
    } finally {
      await agent.stop();
    }
  });

  it("auth: visitor.optional treats invalid external auth as anonymous", async () => {
    const model = createMockModel();
    const port = 19311;
    const assertion = createExternalAuthAssertion({
      secret: "other-secret",
      audience: "storefront-agent",
      provider: "clerk",
      subject: "user_123",
      ttlSeconds: 60,
    });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      externalAuth: {
        secret: "app-auth-secret",
        audience: "storefront-agent",
        allowedProviders: ["clerk"],
      },
    });
    const fixture: Augment = {
      name: "external-auth-routes",
      httpRoutes: [
        {
          method: "GET",
          path: "/recommendations",
          auth: "visitor.optional",
          handler: async (_req, opts) => json(opts.auth),
        },
      ],
    };
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/recommendations`, {
        headers: { "x-auggy-auth-assertion": assertion },
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({
        mode: "visitor",
        state: "anonymous",
        principal: {
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
        },
      });
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

  it("checks per-route rate limits before buffering oversized request bodies", async () => {
    const model = createMockModel();
    const port = 19971;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    let handlerCalled = false;
    const fixture = routeFixtureAugment({
      method: "POST",
      auth: "none",
      maxBodyBytes: 1,
      rateLimit: { maxPerMinute: 0 },
      handler: async () => {
        handlerCalled = true;
        return new Response("ok");
      },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [fixture, aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo`, {
        method: "POST",
        body: "too large for the route cap",
      });
      expect(resp.status).toBe(429);
      expect(handlerCalled).toBe(false);
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

  it("aggregates equivalent and rotating IPv6 callers into a /64 budget", () => {
    expect(rateLimitNetworkIdentity("2606:4700:4700:1::1111")).toBe(
      rateLimitNetworkIdentity("2606:4700:4700:1::2222"),
    );
    expect(rateLimitNetworkIdentity("2606:4700:4700:1::1111")).toBe(
      rateLimitNetworkIdentity("2606:4700:4700:0001:0:0:0:1111"),
    );
    expect(rateLimitNetworkIdentity("2606:4700:4700:1::1111")).not.toBe(
      rateLimitNetworkIdentity("2606:4700:4700:2::1111"),
    );
    expect(rateLimitNetworkIdentity("::ffff:203.0.113.7")).toBe("ipv4:203.0.113.7");
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
  it("defaults visitor-token binding to the registered security audience", async () => {
    const sharedSigningKey = "shared-key-for-default-binding-test";
    const sigKey = await deriveSigningKey(sharedSigningKey);
    const { token: agentAToken } = await createVisitorToken(sigKey, "agent-a", 86_400);
    const model = createMockModel({ response: "hello" });
    const port = 18988;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      visitorTokens: {
        enabled: true,
        signingKey: sharedSigningKey,
      },
    });
    const agent = defineAgent({ name: "agent-b", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const { response: resp, visitorToken } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-visitor-token": agentAToken,
          },
          body: JSON.stringify({ messages: [{ role: "user", content: "cross-agent replay" }] }),
        },
      );
      expect(resp.status).toBe(200);
      expect(visitorToken).toBeNull();
      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

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
      // Present agent-a's token to agent-b: it stays anonymous and never
      // receives a replacement recognized credential.
      const { response: resp, visitorToken } = await bootstrapAnonymousRequest(
        `http://localhost:${port}/agent/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-visitor-token": agentAToken,
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: "hi from agent-a replay" }],
          }),
        },
      );
      expect(resp.status).toBe(200);
      expect(visitorToken).toBeNull();
      await resp.text();
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// G36 — /console route integration tests (Phase 2)
// ---------------------------------------------------------------------------

describe("webTransport /console route — basic dispatch (G36 phase 2)", () => {
  it("rejects an unconfigured Host before console authentication", async () => {
    const model = createMockModel();
    const port = 19206;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/console`, {
        headers: { host: "localhost.evil" },
        redirect: "manual",
      });
      expect(resp.status).toBe(421);
      expect(resp.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      await agent.stop();
    }
  });

  it("rejects forwarding headers from an unconfigured proxy even on Railway", async () => {
    const previous = process.env.RAILWAY_ENVIRONMENT;
    process.env.RAILWAY_ENVIRONMENT = "production";
    const model = createMockModel();
    const port = 19207;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    try {
      await agent.start();
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/dashboard`, {
        headers: {
          authorization: `Basic ${Buffer.from(":test-token").toString("base64")}`,
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
        },
      });
      expect(resp.status).toBe(400);
    } finally {
      await agent.stop();
      if (previous === undefined) delete process.env.RAILWAY_ENVIRONMENT;
      else process.env.RAILWAY_ENVIRONMENT = previous;
    }
  });

  it("requires same-origin login POSTs", async () => {
    const model = createMockModel();
    const port = 19208;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const body = new URLSearchParams({ password: "test-token" });
      const missing = await fetch(`http://127.0.0.1:${port}/console/login`, {
        method: "POST",
        body,
        redirect: "manual",
      });
      expect(missing.status).toBe(403);
      expect(missing.headers.get("set-cookie")).toBeNull();

      const foreign = await fetch(`http://127.0.0.1:${port}/console/login`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body,
        redirect: "manual",
      });
      expect(foreign.status).toBe(403);

      const valid = await fetch(`http://127.0.0.1:${port}/console/login`, {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${port}` },
        body,
        redirect: "manual",
      });
      expect(valid.status).toBe(303);
      expect(valid.headers.get("set-cookie")).toContain("auggy_console=");
    } finally {
      await agent.stop();
    }
  });

  it("GET /console from loopback without bearer redirects to login", async () => {
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
      expect(resp.status).toBe(200);
      expect(resp.headers.get("www-authenticate")).toBeNull();
      expect(resp.url).toContain("/console/login");
      expect(await resp.text()).toContain("Console sign-in");
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

  it("exchanges a CLI bearer for a one-time browser session", async () => {
    const model = createMockModel();
    const port = 19213;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from("auggy:test-token").toString("base64");
      const issued = await fetch(`http://127.0.0.1:${port}/console/api/cli-login`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}` },
      });
      expect(issued.status).toBe(200);
      const body = (await issued.json()) as { loginPath: string };
      expect(body.loginPath).toMatch(/^\/console\/cli-login\/[A-Za-z0-9_-]{43}$/);

      const consume = () =>
        fetch(`http://127.0.0.1:${port}${body.loginPath}`, { redirect: "manual" });
      const login = await consume();
      expect(login.status).toBe(303);
      expect(login.headers.get("location")).toBe("/console/chat");
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

      const dashboard = await fetch(`http://127.0.0.1:${port}/console/api/dashboard`, {
        headers: { cookie },
      });
      expect(dashboard.status).toBe(200);
      expect((await consume()).status).toBe(401);
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
