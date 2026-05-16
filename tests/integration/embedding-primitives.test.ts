/**
 * Integration test for `docs/20-embedding.md` — verifies the identity-path
 * runtime contract documented as the primitives reference. Each test boots a
 * real agent + uses direct fetch against /agent/run to assert
 * webTransport.identify() resolves the documented identity paths correctly.
 *
 * Closes codex adversarial-review findings on the (now-closed) recipe PR #50,
 * the round-5 review on the replacement plan, and the round-6 review on PR #51:
 *   1. A request without a bearer MUST resolve to public:anonymous, NOT creator.
 *   2. `x-peer-id` MUST NOT be used for identity.
 *   3. A valid bearer MUST resolve to creator trust.
 *   4. An invalid bearer MUST 401 (no silent downgrade to anonymous).
 *   5. (Round 6 fix) A valid bearer MUST win over an invalid x-visitor-token —
 *      Path 1 fires unless a VALID visitor-token is present (in which case
 *      Path 3 wins; that's an opt-in operator-as-visitor case).
 *
 * Out of scope (covered elsewhere): agent path (src/transports/* tests),
 * full AG-UI event taxonomy (transport unit tests), visitorAuth verify-page
 * GET/POST mechanics (tests/augments/visitor-auth/*), Idempotency-Key
 * behavior (tests/integration/budgets-and-trust.test.ts).
 *
 * If you change webTransport.identify or visitorAuth's upgrade flow, run this
 * test to confirm the documented identity-path contract still holds.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { webTransport } from "@/transports/web-transport";
import { visitorAuth } from "../../src/augments/visitor-auth/index";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { AgentHandle, Augment, PeerIdentity, TurnState } from "@/types";

const SIGNING_KEY = "shared-signing-key-embedding-primitives-test";
const BEARER = "embedding-primitives-bearer";

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

describe("integration: embedding primitives (docs/20-embedding.md)", () => {
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

  // ---------------------------------------------------------------------------
  // Test 1 (ported from PR #50): anonymous bootstrap — no bearer, first contact
  // ---------------------------------------------------------------------------

  it("request without bearer + bootstrap visitor-token → public/anonymous + fresh token in response", async () => {
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

    const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": "bootstrap",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-pa-1",
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-visitor-token")).toBeTruthy(); // rotated token issued
    await resp.text();

    // The agent saw the turn with public:anonymous trust.
    // In direct fetch the threadId we send IS used by the runtime → peer.id = anon-<threadId>.
    expect(peerCapture.captured).toHaveLength(1);
    const peer = peerCapture.captured[0]!;
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("anon-thread-pa-1");
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 2 (ported from PR #50): returning visitor — rotated token → recognized
  // ---------------------------------------------------------------------------

  it("subsequent request with rotated token → public/recognized with stable peer.id", async () => {
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

    // Call 1: bootstrap → response carries rotated token.
    const r1 = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": "bootstrap",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-pa-recog",
      }),
    });
    const rotatedToken = r1.headers.get("x-visitor-token")!;
    expect(rotatedToken).toBeTruthy();
    await r1.text();

    // Call 2: send the rotated token → recognized.
    const r2 = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": rotatedToken,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "follow-up" }],
        threadId: "thread-pa-recog",
      }),
    });
    expect(r2.status).toBe(200);
    await r2.text();

    // Two turns captured. First = anonymous (bootstrap). Second = recognized.
    expect(peerCapture.captured.length).toBe(2);
    const anon = peerCapture.captured[0]!;
    const recog = peerCapture.captured[1]!;
    expect(anon.publicSubstate).toBe("anonymous");
    expect(recog.publicSubstate).toBe("recognized");
    expect(recog.trustLevel).toBe("public");
    expect(recog.id).toMatch(/^vis_/); // recognized peer.id is the token's visitorId

    // Call 3: same rotated token → same peer.id (stable visitorId).
    const r3 = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": rotatedToken,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "third" }],
        threadId: "thread-pa-recog",
      }),
    });
    expect(r3.status).toBe(200);
    await r3.text();
    expect(peerCapture.captured.length).toBe(3);
    expect(peerCapture.captured[2]!.id).toBe(recog.id); // stable visitorId across requests
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 3 (ported from PR #50): visitorAuth upgrade flow via console adapter
  // ---------------------------------------------------------------------------

  it("visitorAuth upgrade flow with console adapter → upgraded vis_<uuid> token", async () => {
    const PORT = 19202;
    const peerCapture = createPeerCaptureAugment();

    // Capture console.log output to extract the verify URL the console adapter prints.
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });

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
        publicUrl: `http://localhost:${PORT}`,
        dbPath: join(tmp.path, "visitor-auth.db"),
        agentMail: { transport: "console" },
        signingKey: SIGNING_KEY,
        layeredMemoryDbPath: null,
      });

      agent = defineAgent(
        { name: "pa-verify", model: "mock", augments: [transport, auth, peerCapture.augment] },
        model,
      );
      await agent.start();

      // Turn 1: anonymous visitor asks to verify. Console adapter prints verify URL.
      const r1 = await fetch(`http://localhost:${PORT}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "bootstrap",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "verify me embedding-test@example.com" }],
          threadId: "thread-pa-verify",
        }),
      });
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
      const r2 = await fetch(`http://localhost:${PORT}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": visToken,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "am I recognized now?" }],
          threadId: "thread-pa-verify-2",
        }),
      });
      expect(r2.status).toBe(200);
      await r2.text();

      // The last captured peer should be recognized with a vis_ id.
      const lastPeer = peerCapture.captured[peerCapture.captured.length - 1]!;
      expect(lastPeer.trustLevel).toBe("public");
      expect(lastPeer.publicSubstate).toBe("recognized");
      expect(lastPeer.id).toMatch(/^vis_/);
    } finally {
      logSpy.mockRestore();
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 4 (ported from PR #50): x-peer-id MUST NOT influence identity
  // ---------------------------------------------------------------------------

  it("x-peer-id is IGNORED for identity (regression guard for codex finding 2)", async () => {
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

    // Send a forged x-peer-id — the agent MUST NOT use it as peer.id.
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
    expect(peer.id).toBe("anon-thread-spoof"); // computed from threadId, NOT from x-peer-id
    expect(peer.id).not.toBe("spoofed-id-12345");
    // x-peer-name DOES populate displayName (cosmetic — not trusted for identity).
    expect(peer.displayName).toBe("Forged Display Name");
    // Trust level is unaffected by header forgery.
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 5 (new — codex round-5 finding #2): valid bearer → creator trust
  // ---------------------------------------------------------------------------

  it('valid bearer → creator trust, peer.id === "creator"', async () => {
    const PORT = 19204;
    const model = createMockModel({ response: "hi creator" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: false,
    });
    agent = defineAgent(
      { name: "path1-creator", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-creator",
      }),
    });
    expect(resp.status).toBe(200);
    await resp.text();

    expect(peerCapture.captured).toHaveLength(1);
    const peer = peerCapture.captured[0]!;
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("creator");
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Test 6 (new — codex round-5 finding #2): invalid bearer → 401, no downgrade
  // ---------------------------------------------------------------------------

  it("present-but-invalid bearer → 401, never silent downgrade to anonymous", async () => {
    // CRITICAL security claim: an invalid bearer MUST 401. The runtime never
    // silently treats an invalid bearer as "no bearer" and admits the request
    // as anonymous — that would let an attacker probe what the bearer should be
    // by trying random tokens and watching for 200 vs 401.
    const PORT = 19205;
    const model = createMockModel({ response: "should never reach model" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      // Note: allowAnonymous: true. Even with anonymous admitted, a PRESENT
      // but WRONG bearer must still 401 — the runtime does not downgrade.
      allowAnonymous: true,
      visitorTokens: { enabled: true, signingKey: SIGNING_KEY, ttlSeconds: 86_400 },
    });
    agent = defineAgent(
      { name: "path1-invalid", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer wrong-token-12345`,
        "x-visitor-token": "bootstrap",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-invalid-bearer",
      }),
    });

    expect(resp.status).toBe(401);
    await resp.text();
    // Model never reached.
    expect(peerCapture.captured).toHaveLength(0);
  }, 30_000);

  it("valid bearer + stale x-visitor-token → creator (bearer wins over invalid visitor-token)", async () => {
    // Codex round-6 fix: a valid bearer wins identity resolution when the
    // x-visitor-token is invalid/stale. Path 1's condition was previously
    // `!req.__visitorPayload && !headers["x-visitor-token"]` — meaning ANY
    // x-visitor-token header (even garbage) skipped Path 1 and silently
    // demoted creator to anonymous. The new condition is just
    // `!req.__visitorPayload`: bearer wins when the visitor-token is invalid
    // (no __visitorPayload populated). If the visitor-token IS valid (Path 3
    // populates __visitorPayload), Path 3 still fires — operator explicitly
    // acting as a known visitor while authenticated.
    //
    // See src/transports/web-transport.ts Path 1 comment.
    const PORT = 19206;
    const model = createMockModel({ response: "hi creator" });
    const peerCapture = createPeerCaptureAugment();

    const transport = webTransport({
      port: PORT,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: false,
      visitorTokens: { enabled: true, signingKey: SIGNING_KEY, ttlSeconds: 86_400 },
    });
    agent = defineAgent(
      { name: "path-bearer-wins", model: "mock", augments: [transport, peerCapture.augment] },
      model,
    );
    await agent.start();

    const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
        "x-visitor-token": "this.is.stale",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-bearer-wins",
      }),
    });

    expect(resp.status).toBe(200);
    await resp.text();

    expect(peerCapture.captured).toHaveLength(1);
    const peer = peerCapture.captured[0]!;
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("creator");
  }, 30_000);
});
