import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "../../../src/augments/visitor-auth";
import { verifyVisitorToken, deriveSigningKey } from "../../../src/transports/visitor-token";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitor-auth-route-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeAgentMail() {
  return {
    send: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
    getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
  };
}

async function setupAug(dbPath: string) {
  const aug = visitorAuth({
    publicUrl: "https://zip.test",
    dbPath,
    agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
    signingKey: "shared-signing-key",
    _agentMailClient: fakeAgentMail() as never,
  });
  await aug.onBoot?.();
  return aug;
}

describe("visitorAuth verify route", () => {
  test("returns 400 for malformed token", async () => {
    const aug = await setupAug(join(tmp, "va.db"));
    const res = await aug.httpRoutes![0]!.handler(
      new Request("https://zip.test/visitor-auth/verify?token=not-a-uuid"),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(400);
    expect((await res.text()).toLowerCase()).toContain("malformed");
    await aug.onShutdown?.();
  });

  test("GET returns 200 confirm page for unknown-but-valid UUID (does not touch store)", async () => {
    // GET must NOT consume the token — it just shows the confirmation page.
    // Even a valid UUID that doesn't exist in the store should return 200+confirm.
    // Assertion is on confirm-page-specific markup so a regression that returns
    // the failure page instead (which also contains "verify") is caught.
    const aug = await setupAug(join(tmp, "va.db"));
    const res = await aug.httpRoutes![0]!.handler(
      new Request(
        "https://zip.test/visitor-auth/verify?token=00000000-0000-4000-8000-000000000000",
      ),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The confirm page has a form with method="POST" — the failure page does not.
    expect(html).toMatch(/<form[^>]+method="POST"/i);
    // The confirm page has a specific CTA button — the failure page does not.
    expect(html).toContain("Verify my email");
    await aug.onShutdown?.();
  });

  test("POST returns 404 for unknown token", async () => {
    const aug = await setupAug(join(tmp, "va2.db"));
    const res = await aug.httpRoutes![1]!.handler(
      new Request("https://zip.test/visitor-auth/verify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=00000000-0000-4000-8000-000000000000",
      }),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(404);
    await aug.onShutdown?.();
  });

  test("GET does not consume the token — POST still works after a GET", async () => {
    const dbPath = join(tmp, "va-nodrain.db");
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-nodrain",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th-nd",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "nodrain@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "nodrain@example.com" },
      { turnId: "t", threadId: "th-nd", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token = new URL(verifyUrl).searchParams.get("token")!;

    // First GET — should return confirm page (200), NOT consume the token.
    const get1 = await aug.httpRoutes![0]!.handler(new Request(verifyUrl), {
      signal: new AbortController().signal,
    });
    expect(get1.status).toBe(200);
    const get1Html = await get1.text();
    // Confirm-page specific markup — the failure page lacks both.
    expect(get1Html).toMatch(/<form[^>]+method="POST"/i);
    expect(get1Html).toContain("Verify my email");

    // Second GET — token still not consumed, still returns confirm page.
    const get2 = await aug.httpRoutes![0]!.handler(new Request(verifyUrl), {
      signal: new AbortController().signal,
    });
    expect(get2.status).toBe(200);

    // POST — now consumes and returns success page with vis_ token.
    const post = await aug.httpRoutes![1]!.handler(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(post.status).toBe(200);
    expect((await post.text()).toLowerCase()).toContain("verified");

    await aug.onShutdown?.();
  });

  test("happy path: 200, sets vis_ token in HTML, token verifies via webTransport's helper", async () => {
    const dbPath = join(tmp, "va.db");
    const sendCalls: { to: string[]; text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      _agentMailClient: {
        send: async (input: { to: string[]; text: string; subject: string; inboxId: string }) => {
          sendCalls.push({ to: input.to, text: input.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-th2",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th2",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th2", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
    // POST consumes the token and returns the success page.
    const res = await aug.httpRoutes![1]!.handler(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(tokenParam)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("auggy-visitor-token");
    // Pull the token literal out of the embedded JS string. Note the page
    // uses jsStringLiteral which JSON.stringify-encodes, then escapes < as
    // <. The raw literal between the double quotes is the JSON-encoded
    // form. JSON-parse it back to get the wire token.
    const tokenJson = html.match(/var token = ("(?:\\.|[^"\\])*");/)?.[1];
    expect(tokenJson).toBeTruthy();
    const visToken = JSON.parse(tokenJson!) as string;
    expect(visToken).toContain("."); // payload.signature
    const sigKey = await deriveSigningKey("shared-key");
    const verified = await verifyVisitorToken(sigKey, visToken);
    expect(verified).not.toBeNull();
    expect(verified?.visitorId).toMatch(/^vis_/);
    await aug.onShutdown?.();
  });

  test("second click on the same token returns 410 'consumed'", async () => {
    const dbPath = join(tmp, "va2.db");
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-th3",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th3",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "carol@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "carol@example.com" },
      { turnId: "t", threadId: "th3", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
    const makePost = () =>
      aug.httpRoutes![1]!.handler(
        new Request(verifyUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `token=${encodeURIComponent(tokenParam)}`,
        }),
        { signal: new AbortController().signal },
      );
    const r1 = await makePost();
    expect(r1.status).toBe(200);
    const r2 = await makePost();
    expect(r2.status).toBe(410);
    expect((await r2.text()).toLowerCase()).toContain("used");
    await aug.onShutdown?.();
  });

  test("returns 410 'expired' for a token whose TTL has passed", async () => {
    const dbPath = join(tmp, "va-exp.db");
    let clock = 1_700_000_000_000;
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      tokenTtlMinutes: 1,
      _now: () => clock,
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-th-exp",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th-exp",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "exp@x.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "exp@x.com" },
      { turnId: "t", threadId: "th-exp", peer },
    );
    clock += 5 * 60_000; // advance past the 1-minute TTL
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
    const res = await aug.httpRoutes![1]!.handler(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(tokenParam)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(410);
    expect((await res.text()).toLowerCase()).toContain("expired");
    await aug.onShutdown?.();
  });

  test("returns 503 if the route is hit before onBoot completes", async () => {
    const dbPath = join(tmp, "va3.db");
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      _agentMailClient: fakeAgentMail() as never,
    });
    // Deliberately do NOT call onBoot.
    const res = await aug.httpRoutes![0]!.handler(
      new Request(
        "https://zip.test/visitor-auth/verify?token=00000000-0000-4000-8000-000000000000",
      ),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(503);
    await aug.onShutdown?.();
  });

  test("re-verify after revoke: un-revokes the row and issues a NEW visitorId", async () => {
    const dbPath = join(tmp, "va-unrevoke.db");
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      rateLimit: { perHour: 5, perDay: 10 },
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();

    // Step 1: First verify — establishes identity.
    const peerA = {
      id: "anon-unrevoke-A",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t1",
      threadId: "thUR-A",
      trigger: {
        type: "message",
        turnId: "t1",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "revokeme@example.com" }],
          sourceAugment: "web",
          peer: peerA,
          timestamp: 0,
        },
      },
      peer: peerA,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "revokeme@example.com" },
      { turnId: "t1", threadId: "thUR-A", peer: peerA },
    );
    const url1 = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token1 = new URL(url1).searchParams.get("token")!;
    const r1 = await aug.httpRoutes![1]!.handler(
      new Request(url1, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token1)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(r1.status).toBe(200);
    const html1 = await r1.text();
    const tokJson1 = html1.match(/var token = ("(?:\\.|[^"\\])*");/)![1]!;
    const firstVisToken = JSON.parse(tokJson1) as string;
    const sigKey = await deriveSigningKey("shared-key");
    const firstPayload = await verifyVisitorToken(sigKey, firstVisToken);
    const firstVisitorId = firstPayload!.visitorId;
    expect(firstVisitorId).toMatch(/^vis_/);

    // Step 2: Operator revokes.
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitor-auth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.revokeByEmail("revokeme@example.com", "operator", Date.now());
    seedStore.close();

    // Step 3: Visitor re-verifies after revoke — must get a NEW visitorId.
    const peerB = {
      id: "anon-unrevoke-B",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t2",
      threadId: "thUR-B",
      trigger: {
        type: "message",
        turnId: "t2",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "revokeme@example.com" }],
          sourceAugment: "web",
          peer: peerB,
          timestamp: 0,
        },
      },
      peer: peerB,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "revokeme@example.com" },
      { turnId: "t2", threadId: "thUR-B", peer: peerB },
    );
    const url2 = sendCalls[1]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token2 = new URL(url2).searchParams.get("token")!;
    const r2 = await aug.httpRoutes![1]!.handler(
      new Request(url2, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token2)}`,
      }),
      { signal: new AbortController().signal },
    );
    // Must succeed (not 500 from UNIQUE constraint) and issue a different visitorId.
    expect(r2.status).toBe(200);
    const html2 = await r2.text();
    const tokJson2 = html2.match(/var token = ("(?:\\.|[^"\\])*");/)![1]!;
    const secondVisToken = JSON.parse(tokJson2) as string;
    const secondPayload = await verifyVisitorToken(sigKey, secondVisToken);
    expect(secondPayload).not.toBeNull();
    expect(secondPayload!.visitorId).toMatch(/^vis_/);
    // NEW identity — must differ from the revoked one.
    expect(secondPayload!.visitorId).not.toBe(firstVisitorId);

    await aug.onShutdown?.();
  });

  test("re-verification of an existing email reuses the original visitorId", async () => {
    const dbPath = join(tmp, "va-rev.db");
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      // Open per-peer rate budget so we can fire two requests for the same email
      // from two different anonymous peers in one test.
      rateLimit: { perHour: 5, perDay: 10 },
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();

    // First verify: visitor arrives anon-A.
    const peerA = {
      id: "anon-A",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "thA",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer: peerA,
          timestamp: 0,
        },
      },
      peer: peerA,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "thA", peer: peerA },
    );
    const url1 = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token1 = new URL(url1).searchParams.get("token")!;
    const r1 = await aug.httpRoutes![1]!.handler(
      new Request(url1, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token1)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(r1.status).toBe(200);
    const html1 = await r1.text();
    const tokJson1 = html1.match(/var token = ("(?:\\.|[^"\\])*");/)![1]!;
    const tok1 = JSON.parse(tokJson1) as string;
    const sigKey = await deriveSigningKey("shared-key");
    const verified1 = await verifyVisitorToken(sigKey, tok1);
    const firstVisitorId = verified1!.visitorId;
    expect(firstVisitorId).toMatch(/^vis_/);

    // Second verify: a NEW anonymous peer (anon-B) re-verifies the same email.
    // The minted token MUST carry the same visitorId as the first verify so
    // peer-scoped state in layered-memory remains continuous across re-verify.
    const peerB = {
      id: "anon-B",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t2",
      threadId: "thB",
      trigger: {
        type: "message",
        turnId: "t2",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer: peerB,
          timestamp: 0,
        },
      },
      peer: peerB,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t2", threadId: "thB", peer: peerB },
    );
    const url2 = sendCalls[1]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token2 = new URL(url2).searchParams.get("token")!;
    const r2 = await aug.httpRoutes![1]!.handler(
      new Request(url2, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token2)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(r2.status).toBe(200);
    const html2 = await r2.text();
    const tokJson2 = html2.match(/var token = ("(?:\\.|[^"\\])*");/)![1]!;
    const tok2 = JSON.parse(tokJson2) as string;
    const verified2 = await verifyVisitorToken(sigKey, tok2);
    expect(verified2!.visitorId).toBe(firstVisitorId);

    await aug.onShutdown?.();
  });

  test("agentBinding: minted token carries the configured agentId (fix C2)", async () => {
    // When visitorAuth is configured with agentBinding: "test-binding", the
    // visitor token embedded in the success page must have agentId === "test-binding".
    const dbPath = join(tmp, "va-binding.db");
    const sendCalls: { to: string[]; text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      agentBinding: "test-binding",
      _agentMailClient: {
        send: async (input: { to: string[]; text: string; subject: string; inboxId: string }) => {
          sendCalls.push({ to: input.to, text: input.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-th-binding",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th-binding",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "binding@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "binding@example.com" },
      { turnId: "t", threadId: "th-binding", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
    const res = await aug.httpRoutes![1]!.handler(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(tokenParam)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const tokenJson = html.match(/var token = ("(?:\\.|[^"\\])*");/)?.[1];
    expect(tokenJson).toBeTruthy();
    const visToken = JSON.parse(tokenJson!) as string;
    // Decode the payload without signature verification to check agentId.
    const payloadB64 = visToken.split(".")[0]!;
    const payload = JSON.parse(atob(payloadB64)) as { agentId: string; visitorId: string };
    expect(payload.agentId).toBe("test-binding");
    await aug.onShutdown?.();
  });
});
