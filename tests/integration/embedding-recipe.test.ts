/**
 * Integration test for `docs/20-embedding.md` — verifies the documented
 * embedding patterns hold end-to-end against the real transport.
 *
 * Closes codex adversarial-review findings on PR #50:
 *   1. Pattern A (no bearer) MUST resolve to public:anonymous, NOT creator.
 *      Verifies the documented public-visitor pattern stays in public trust.
 *   2. `x-peer-id` MUST NOT be used for identity. Regression guard against
 *      future advice that would mislead adopters about visitor-scoping.
 *
 * Structure: each test mounts a real agent with `webTransport` (and
 * `visitorAuth` for Pattern A) plus a small inline HTTP proxy that mirrors
 * the recipe code from docs/20-embedding.md. The proxy + recipe code stay
 * in sync because changes that break this test will also break the
 * documented claims.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { webTransport } from "@/transports/web-transport";
import { visitorAuth } from "../../src/augments/visitor-auth/index";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { AgentHandle, Augment, PeerIdentity, TurnState } from "@/types";

const SIGNING_KEY = "shared-signing-key-embedding-recipe-test";
const BEARER = "embedding-recipe-bearer";

// ---------------------------------------------------------------------------
// Peer-capturing augment — records the peer the agent saw on each turn.
// ---------------------------------------------------------------------------

interface PeerCapture {
  augment: Augment;
  captured: PeerIdentity[];
}

function createPeerCaptureAugment(): PeerCapture {
  const captured: PeerIdentity[] = [];
  const augment: Augment = {
    name: "peer-capture",
    capabilities: ["context"],
    context: async (turn: TurnState) => {
      if (turn.peer) captured.push(turn.peer);
      return [];
    },
  };
  return { augment, captured };
}

// ---------------------------------------------------------------------------
// Pattern A proxy — mirrors docs/20-embedding.md Pattern A code.
// No bearer. Forwards x-visitor-token in both directions.
// ---------------------------------------------------------------------------

function patternAProxy(agentUrl: string): {
  fetch: (req: Request) => Promise<Response>;
} {
  return {
    fetch: async (req: Request): Promise<Response> => {
      const body = await req.text();
      const visitorToken = req.headers.get("x-visitor-token") ?? "bootstrap";
      const agentResp = await fetch(`${agentUrl}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": visitorToken,
          // NO Authorization — Pattern A relies on allowAnonymous.
        },
        body,
      });
      const respHeaders = new Headers({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const issued = agentResp.headers.get("x-visitor-token");
      if (issued) respHeaders.set("x-visitor-token", issued);
      return new Response(agentResp.body, { status: agentResp.status, headers: respHeaders });
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern B proxy — mirrors docs/20-embedding.md Pattern B code.
// Forwards Authorization: Bearer.
// ---------------------------------------------------------------------------

function patternBProxy(
  agentUrl: string,
  bearer: string,
): {
  fetch: (req: Request) => Promise<Response>;
} {
  return {
    fetch: async (req: Request): Promise<Response> => {
      const body = await req.text();
      const agentResp = await fetch(`${agentUrl}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body,
      });
      const respHeaders = new Headers({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      return new Response(agentResp.body, { status: agentResp.status, headers: respHeaders });
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

describe("integration: embedding recipe (docs/20-embedding.md)", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };
  let agent: AgentHandle | undefined;

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore
    }
    agent = undefined;
    await tmp.cleanup();
  });

  // -------------------------------------------------------------------------
  // Pattern A — public visitor chat
  // -------------------------------------------------------------------------

  it("Pattern A: request without bearer + bootstrap token → public/anonymous + fresh token in response", async () => {
    const PORT = 19200;
    const model = createMockModel({ response: "hi visitor" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: true,
      visitorTokens: {
        enabled: true,
        signingKey: SIGNING_KEY,
        ttlSeconds: 86_400,
      },
    });

    agent = defineAgent(
      { name: "pa-anon", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const proxy = patternAProxy(`http://localhost:${PORT}`);
    const browserReq = new Request("http://example.invalid/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": "bootstrap", // first contact placeholder
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-pa-1",
      }),
    });
    const resp = await proxy.fetch(browserReq);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-visitor-token")).toBeTruthy(); // rotated token issued
    await resp.text();

    // The agent saw the turn with public:anonymous trust, peer.id = anon-<threadId>.
    expect(peerCapture.captured).toHaveLength(1);
    const peer = peerCapture.captured[0]!;
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("anon-thread-pa-1");
  }, 30_000);

  it("Pattern A: subsequent request with rotated token → public/recognized with stable peer.id", async () => {
    const PORT = 19201;
    const model = createMockModel({ response: "welcome back" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: true,
      visitorTokens: { enabled: true, signingKey: SIGNING_KEY, ttlSeconds: 86_400 },
    });
    agent = defineAgent(
      { name: "pa-recog", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const proxy = patternAProxy(`http://localhost:${PORT}`);

    // First contact → bootstrap → response carries rotated token.
    const r1 = await proxy.fetch(
      new Request("http://example.invalid/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-visitor-token": "bootstrap" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          threadId: "thread-pa-recog",
        }),
      }),
    );
    const rotatedToken = r1.headers.get("x-visitor-token")!;
    expect(rotatedToken).toBeTruthy();
    await r1.text();

    // Second request with the rotated token — should resolve to recognized.
    const r2 = await proxy.fetch(
      new Request("http://example.invalid/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-visitor-token": rotatedToken },
        body: JSON.stringify({
          messages: [{ role: "user", content: "follow-up" }],
          threadId: "thread-pa-recog",
        }),
      }),
    );
    expect(r2.status).toBe(200);
    await r2.text();

    // Two turns captured. First = anonymous (the bootstrap call). Second = recognized.
    expect(peerCapture.captured.length).toBe(2);
    const anon = peerCapture.captured[0]!;
    const recog = peerCapture.captured[1]!;
    expect(anon.publicSubstate).toBe("anonymous");
    expect(recog.publicSubstate).toBe("recognized");
    expect(recog.trustLevel).toBe("public");
    expect(recog.id).toMatch(/^vis_/); // recognized peer.id is the token's visitorId

    // Third request also recognized — same visitor.
    const r3 = await proxy.fetch(
      new Request("http://example.invalid/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-visitor-token": rotatedToken },
        body: JSON.stringify({
          messages: [{ role: "user", content: "third" }],
          threadId: "thread-pa-recog",
        }),
      }),
    );
    expect(r3.status).toBe(200);
    await r3.text();
    expect(peerCapture.captured[2]!.id).toBe(recog.id); // stable visitorId across requests
  }, 30_000);

  it("Pattern A: visitorAuth upgrade flow with console adapter → upgraded vis_<uuid> token", async () => {
    const PORT = 19202;
    const peerCapture = createPeerCaptureAugment();

    // Capture console.log output to extract the verify URL the console adapter prints.
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };

    try {
      // Mock model: turn 1 emits the request_auth tool call; turn 2 returns text.
      const model = createMockModel({ response: "verified" });
      model.pushResponse({
        content: "",
        toolCalls: [
          {
            name: "request_auth",
            arguments: { method: "email", email: "embedding-test@example.com" },
          },
        ],
        finishReason: "tool_use",
      });
      model.pushResponse({
        content: "Verification link sent.",
        finishReason: "end_turn",
      });

      const transport = webTransport({
        port: PORT,
        auth: { type: "bearer", token: BEARER },
        allowAnonymous: true,
        visitorTokens: {
          enabled: true,
          signingKey: SIGNING_KEY,
          ttlSeconds: 7_776_000,
        },
      });

      const auth = visitorAuth({
        publicUrl: `http://localhost:${PORT}`, // local → permitted without override
        dbPath: join(tmp.path, "visitor-auth.db"),
        agentMail: { transport: "console" }, // G34 console adapter
        signingKey: SIGNING_KEY,
        layeredMemoryDbPath: null,
      });

      agent = defineAgent(
        { name: "pa-verify", model: "mock", augments: [transport, auth, peerCapture.augment] },
        model,
      );
      await agent.start();

      const proxy = patternAProxy(`http://localhost:${PORT}`);

      // Turn 1: anonymous visitor asks to verify. Console adapter prints verify URL.
      const r1 = await proxy.fetch(
        new Request("http://example.invalid/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", "x-visitor-token": "bootstrap" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "verify me embedding-test@example.com" }],
            threadId: "thread-pa-verify",
          }),
        }),
      );
      expect(r1.status).toBe(200);
      await r1.text();

      // Extract the verify URL from captured stdout.
      const verifyLine = logs.find((l) => l.includes("/visitor-auth/verify"));
      expect(verifyLine).toBeDefined();
      const match = verifyLine!.match(/(http:\/\/[^\s]+\/visitor-auth\/verify\?token=[^\s]+)/);
      expect(match).not.toBeNull();
      const verifyUrl = match![1]!;

      // GET → confirm page (no token consumption).
      const confirmResp = await fetch(verifyUrl);
      expect(confirmResp.status).toBe(200);
      await confirmResp.text();

      // POST → consume token + return success page with embedded vis_<uuid>.
      const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
      const successResp = await fetch(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(tokenParam)}`,
      });
      expect(successResp.status).toBe(200);
      const successHtml = await successResp.text();
      const visTokenMatch = successHtml.match(/var token = ("(?:\\.|[^"\\])*");/);
      expect(visTokenMatch).not.toBeNull();
      const visToken = JSON.parse(visTokenMatch![1]!) as string;
      expect(visToken).toContain("."); // payload.signature

      // Turn 2: send the upgraded token. Expect recognized with the verified visitorId.
      const r2 = await proxy.fetch(
        new Request("http://example.invalid/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", "x-visitor-token": visToken },
          body: JSON.stringify({
            messages: [{ role: "user", content: "am I recognized now?" }],
            threadId: "thread-pa-verify-2",
          }),
        }),
      );
      expect(r2.status).toBe(200);
      await r2.text();

      // The last captured peer should be recognized with a vis_ id.
      const lastPeer = peerCapture.captured[peerCapture.captured.length - 1]!;
      expect(lastPeer.trustLevel).toBe("public");
      expect(lastPeer.publicSubstate).toBe("recognized");
      expect(lastPeer.id).toMatch(/^vis_/);
    } finally {
      console.log = originalLog;
    }
  }, 30_000);

  it("Pattern A: x-peer-id is IGNORED for identity (regression guard for codex finding 2)", async () => {
    const PORT = 19203;
    const model = createMockModel({ response: "ok" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: true,
      visitorTokens: { enabled: true, signingKey: SIGNING_KEY, ttlSeconds: 86_400 },
    });
    agent = defineAgent(
      { name: "pa-xpeerid", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const proxy = patternAProxy(`http://localhost:${PORT}`);

    // Send a forged x-peer-id — the agent MUST NOT use it as peer.id.
    // Proxy doesn't normally pass x-peer-id; for this test we hit /agent/run
    // directly so we can include it.
    const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": "bootstrap",
        "x-peer-id": "spoofed-id-12345",
        "x-peer-name": "Forged Display Name",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-spoof",
      }),
    });
    expect(resp.status).toBe(200);
    await resp.text();

    expect(peerCapture.captured).toHaveLength(1);
    const peer = peerCapture.captured[0]!;
    expect(peer.id).toBe("anon-thread-spoof"); // computed, NOT "spoofed-id-12345"
    expect(peer.id).not.toBe("spoofed-id-12345");
    // x-peer-name DOES populate displayName (cosmetic).
    expect(peer.displayName).toBe("Forged Display Name");
    // Trust level is unaffected by header forgery.
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");

    // Suppress unused-binding warning for the proxy (kept for symmetry with
    // other tests; we hit /agent/run directly here to set the forged header).
    void proxy;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Pattern B — operator-only (creator trust)
  // -------------------------------------------------------------------------

  it("Pattern B: proxy forwards bearer → creator trust on every request", async () => {
    const PORT = 19204;
    const model = createMockModel({ response: "ack" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      // No allowAnonymous — default for production behavior.
      allowAnonymous: false,
    });
    agent = defineAgent(
      { name: "pb-creator", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const proxy = patternBProxy(`http://localhost:${PORT}`, BEARER);
    const resp = await proxy.fetch(
      new Request("http://example.invalid/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          threadId: "thread-pb",
        }),
      }),
    );
    expect(resp.status).toBe(200);
    await resp.text();

    expect(peerCapture.captured).toHaveLength(1);
    const peer = peerCapture.captured[0]!;
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("creator");
  }, 30_000);

  it("Pattern B without bearer (allowAnonymous=false) → 401 from the agent", async () => {
    const PORT = 19205;
    const model = createMockModel();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: false,
    });
    agent = defineAgent({ name: "pb-401", model: "mock", augments: [transport] }, model);
    await agent.start();

    // Skip the proxy — go straight at /agent/run without a bearer to prove
    // the agent enforces it. (A buggy "Pattern B proxy that forgot to attach
    // the bearer" would observe the same 401, which is what we want.)
    const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-pb-401",
      }),
    });
    expect(resp.status).toBe(401);
  }, 30_000);
});
