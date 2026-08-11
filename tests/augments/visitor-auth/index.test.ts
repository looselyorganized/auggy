import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "../../../src/augments/visitorAuth";
import { createSqliteVisitorAuthStore } from "../../../src/augments/visitorAuth/storage/sqlite-store";
import { createVisitorAuthRateLimiter } from "../../../src/augments/visitorAuth/rate-limiter";
import type { AgentMailClient } from "../../../src/agentmail-client";
import { OutcomeUnknownError } from "../../../src/outcome-unknown";
import type { ToolExecuteContext, ContextBlock } from "../../../src/types";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitor-auth-aug-"));
  dbPath = join(tmp, "visitor-auth.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeAgentMail(overrides: Partial<AgentMailClient> = {}): AgentMailClient {
  return {
    send: async () => ({ status: "sent", messageId: "m", threadId: "t" }),
    reply: async () => ({ status: "sent", messageId: "m", threadId: "t" }),
    forward: async () => ({ status: "sent", messageId: "m", threadId: "t" }),
    getInbox: async () => ({ inboxId: "i", email: "agent@example.com", status: "ok" }),
    ...overrides,
  } as AgentMailClient;
}

describe("visitorAuth (skeleton)", () => {
  test("factory returns an Augment with tools, context, and httpRoutes", () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    expect(aug.name).toBe("visitor-auth");
    expect(aug.tools).toHaveLength(1);
    expect(aug.context).toBeDefined();
    expect(aug.httpRoutes).toHaveLength(3);
    // GET route: confirm page (does not consume token — survives mail-scanner prefetch).
    expect(aug.httpRoutes?.[0]?.path).toBe("/visitor-auth/verify");
    expect(aug.httpRoutes?.[0]?.auth).toBe("none");
    expect(aug.httpRoutes?.[0]?.method).toBe("GET");
    expect(aug.httpRoutes?.[0]?.requestJsonSchema?.query).toMatchObject({
      type: "object",
      required: ["token"],
      properties: { token: { type: "string" } },
    });
    expect(aug.httpRoutes?.[0]?.requestMediaTypes).toBeUndefined();
    expect(aug.httpRoutes?.[0]?.responseJsonSchema).toBeUndefined();
    expect(aug.httpRoutes?.[0]?.responseMediaTypes).toEqual(["text/html"]);
    // POST route: consumes the token and mints the vis_ visitor token.
    expect(aug.httpRoutes?.[1]?.path).toBe("/visitor-auth/verify");
    expect(aug.httpRoutes?.[1]?.auth).toBe("none");
    expect(aug.httpRoutes?.[1]?.method).toBe("POST");
    expect(aug.httpRoutes?.[1]?.requestJsonSchema?.body).toMatchObject({
      type: "object",
      required: ["token"],
      properties: { token: { type: "string" } },
    });
    expect(aug.httpRoutes?.[1]?.requestMediaTypes).toEqual([
      "application/x-www-form-urlencoded",
      "application/json",
    ]);
    expect(aug.httpRoutes?.[1]?.responseJsonSchema).toBeUndefined();
    expect(aug.httpRoutes?.[1]?.responseMediaTypes).toEqual(["text/html"]);
    // POST route: deterministic app-backend request for a magic link.
    expect(aug.httpRoutes?.[2]?.path).toBe("/visitor-auth/request");
    expect(aug.httpRoutes?.[2]?.auth).toBe("visitor.optional");
    expect(aug.httpRoutes?.[2]?.method).toBe("POST");
    expect(aug.httpRoutes?.[2]?.requestJsonSchema?.body).toMatchObject({
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string" },
        meta: { type: "object" },
      },
    });
    expect(aug.httpRoutes?.[2]?.requestMediaTypes).toEqual(["application/json"]);
    const responseVariants = aug.httpRoutes?.[2]?.responseJsonSchema?.oneOf as Array<{
      properties: Record<string, { const?: string; enum?: string[]; type?: string }>;
      required?: string[];
    }>;
    expect(responseVariants.map((variant) => variant.properties.status?.const)).toEqual([
      "sent",
      "rejected",
      "failed",
    ]);
    const [sent, rejected, failed] = responseVariants;
    expect(sent?.properties.delivery?.enum).toEqual(["email", "console"]);
    expect(sent?.required).toEqual(["status", "delivery", "message", "expiresInSec"]);
    expect(rejected?.properties.code?.enum).toEqual(["malformed_email", "rate_limited"]);
    expect(failed?.properties.code?.enum).toEqual(["not_booted", "send_failed"]);
    expect(aug.httpRoutes?.[2]?.responseMediaTypes).toEqual(["application/json"]);
  });

  test("resolveVisitorIdentity returns metadata for active visitors and null for revoked visitors", async () => {
    const store = createSqliteVisitorAuthStore({ dbPath });
    store.initialize();
    store.recordVerifiedVisitor({
      visitorId: "vis_active",
      email: "alice@example.com",
      verifiedAt: 1000,
      lastSeenAt: 1000,
      reverifyDueAt: 2000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    store.recordVerifiedVisitor({
      visitorId: "vis_revoked",
      email: "bob@example.com",
      verifiedAt: 1000,
      lastSeenAt: 1000,
      reverifyDueAt: 2000,
      revoked: true,
      revokedAt: 1500,
      revokedReason: "test",
    });
    store.close();

    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    try {
      expect(aug.resolveVisitorIdentity("vis_active")).toEqual({
        visitorId: "vis_active",
        email: "alice@example.com",
        verifiedAt: 1000,
        reverifyDueAt: 2000,
      });
      expect(aug.resolveVisitorIdentity("vis_revoked")).toBeNull();
      expect(aug.resolveVisitorIdentity("vis_missing")).toBeNull();
    } finally {
      await aug.onShutdown?.();
    }
  });

  test("factory throws for missing publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/publicUrl/);
  });

  test("factory throws for malformed publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "not-a-url",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/is not a valid URL/);
  });

  test("factory throws with protocol-specific error for non-http(s) publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "ftp://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/must use http:\/\/ or https:\/\//);
  });

  test("factory throws for missing AgentMail config", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "", inboxId: "" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/agentMail/);
  });

  test("factory throws for missing signingKey", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/signingKey/);
  });

  test("factory rejects malformed rate-limit configuration", () => {
    const base = {
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
    };
    expect(() => visitorAuth({ ...base, rateLimit: { perHour: 0, perDay: 3 } })).toThrow(
      /rateLimit\.perHour.*positive integer/,
    );
    expect(() => visitorAuth({ ...base, rateLimit: { perHour: 1.5, perDay: 3 } })).toThrow(
      /rateLimit\.perHour.*positive integer/,
    );
    expect(() =>
      visitorAuth({ ...base, rateLimit: { perHour: 1, perDay: Number.POSITIVE_INFINITY } }),
    ).toThrow(/rateLimit\.perDay.*positive integer/);
    expect(() =>
      visitorAuth({
        ...base,
        rateLimit: { perHour: 1, perDay: 3, minIntervalSeconds: 1.5 },
      }),
    ).toThrow(/rateLimit\.minIntervalSeconds.*non-negative integer/);
    expect(() =>
      visitorAuth({
        ...base,
        rateLimit: { perHour: 1, perDay: 3, minIntervalSeconds: -1 },
      }),
    ).toThrow(/rateLimit\.minIntervalSeconds.*non-negative integer/);
    expect(() =>
      visitorAuth({
        ...base,
        rateLimit: { perHour: 1, perDay: 3, minIntervalSeconds: 0 },
      }),
    ).not.toThrow();
  });

  test("onBoot calls AgentMail.getInbox; warns on failure but does not throw", async () => {
    let getInboxCalls = 0;
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail({
        getInbox: async () => {
          getInboxCalls++;
          return { status: "failed", detail: "503 unavailable", httpStatus: 503 };
        },
      }),
    });
    await aug.onBoot?.();
    expect(getInboxCalls).toBe(1);
    await aug.onShutdown?.();
  });

  test("onBoot succeeds when AgentMail.getInbox returns ok", async () => {
    let calls = 0;
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail({
        getInbox: async () => {
          calls++;
          return { inboxId: "ibx_x", email: "agent@example.com", status: "ok" };
        },
      }),
    });
    await aug.onBoot?.();
    expect(calls).toBe(1);
    await aug.onShutdown?.();
  });

  test("onBoot throws when AgentMail config env-vars are blatantly placeholder", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "${AGENTMAIL_API_KEY}", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/AGENTMAIL_API_KEY/);
  });

  // F12 — agentBinding placeholder check. An unresolved agentBinding silently
  // degrades token validation (every minted token's `agent` field becomes the
  // literal `${AGENT_BINDING}`, which self-consistently verifies). Fail loud
  // at boot instead of letting the misconfig pass.
  test("onBoot throws when agentBinding is an unresolved placeholder", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      agentBinding: "${AGENT_BINDING}",
      _agentMailClient: fakeAgentMail(),
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/agentBinding is unresolved/);
  });

  test("onBoot succeeds when agentBinding is a real value (not a placeholder)", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      agentBinding: "zip",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    await aug.onShutdown?.();
  });

  test("onBoot succeeds when agentBinding is omitted (defaults to 'auggy')", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    await aug.onShutdown?.();
  });

  // F9 — AgentMail healthcheck severity branches on httpStatus.
  // 401 / 403 / 404 indicate operator misconfig (bad API key, missing inbox);
  // throw at boot so it's caught before the first visitor request. 5xx and
  // network errors stay warn-and-continue (transient).
  for (const httpStatus of [401, 403, 404] as const) {
    test(`onBoot throws on AgentMail healthcheck HTTP ${httpStatus} (operator misconfig)`, async () => {
      const aug = visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail({
          getInbox: async () => ({
            status: "failed",
            detail: `${httpStatus} bad`,
            httpStatus,
          }),
        }),
      });
      await expect(aug.onBoot?.()).rejects.toThrow(
        new RegExp(`HTTP ${httpStatus}|AGENTMAIL_API_KEY|AGENTMAIL_INBOX_ID`),
      );
    });
  }

  test("onBoot 403 identifies the supplied key and required capabilities", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail({
        getInbox: async () => ({
          status: "failed",
          detail: "403 forbidden",
          httpStatus: 403,
        }),
      }),
    });
    await expect(aug.onBoot?.()).rejects.toThrow(
      /supplied AgentMail key.*inbox_read.*message_send/,
    );
  });

  for (const httpStatus of [500, 502, 503, 504, 429] as const) {
    test(`onBoot warns and continues on AgentMail healthcheck HTTP ${httpStatus} (transient)`, async () => {
      const aug = visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail({
          getInbox: async () => ({
            status: "failed",
            detail: `${httpStatus} unavailable`,
            httpStatus,
          }),
        }),
      });
      await aug.onBoot?.();
      await aug.onShutdown?.();
    });
  }

  test("onBoot warns and continues on AgentMail healthcheck network error (no httpStatus)", async () => {
    // No httpStatus field → caller couldn't reach AgentMail at all
    // (DNS failure, timeout, etc). Treat as transient, like a 5xx.
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail({
        getInbox: async () => ({
          status: "failed",
          detail: "agentmail error: ECONNREFUSED",
        }),
      }),
    });
    await aug.onBoot?.();
    await aug.onShutdown?.();
  });

  test("context() returns an empty array when no peer is set", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const turn = {
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message", turnId: "t1", timestamp: 0, payload: {} },
      peer: null,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never;
    const result = await aug.context?.(turn);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });

  test("thread promotion proof fails closed before boot and after shutdown", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });

    expect(aug.canPromoteAnonymousThread("vis_unknown", "thread-1")).toBe(false);
    await aug.onBoot?.();
    expect(aug.canPromoteAnonymousThread("vis_unknown", "thread-1")).toBe(false);
    await aug.onShutdown?.();
    expect(aug.canPromoteAnonymousThread("vis_unknown", "thread-1")).toBe(false);
  });
});

describe("buildVerifyUrl (F6) — URL-spec-compliant construction", () => {
  // We exercise buildVerifyUrl indirectly by reading the verify URL that ends
  // up inside the email body sent via agentMail.send.  Each matrix entry varies
  // publicUrl; the captured URL must be well-formed and carry exactly one
  // `token` query parameter.
  const _uuidToken = "00000000-0000-4000-8000-000000000001";

  const cases: Array<{ label: string; publicUrl: string }> = [
    { label: "no trailing slash", publicUrl: "https://zip.test" },
    { label: "trailing slash", publicUrl: "https://zip.test/" },
    { label: "publicUrl with query string", publicUrl: "https://zip.test?utm=x" },
    { label: "publicUrl with fragment", publicUrl: "https://zip.test#frag" },
    { label: "subpath without trailing slash", publicUrl: "https://zip.test/sub" },
    { label: "subpath with trailing slash", publicUrl: "https://zip.test/sub/" },
  ];

  for (const { label, publicUrl } of cases) {
    test(`well-formed verify URL for: ${label}`, async () => {
      const sendCalls: Array<{ text: string }> = [];
      const aug = visitorAuth({
        publicUrl,
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail({
          send: async (input) => {
            sendCalls.push({ text: (input as { text: string }).text });
            return { status: "sent", messageId: "m", threadId: "t" };
          },
        }),
      });
      await aug.onBoot?.();

      const peer = {
        id: "anon-urltest",
        kind: "anonymous" as const,
        trustLevel: "public" as const,
        publicSubstate: "anonymous" as const,
        sourceAugment: "web",
      };
      await aug.onTurnStart?.({
        turnId: "tu",
        threadId: "th-url",
        trigger: {
          type: "message",
          turnId: "tu",
          timestamp: 0,
          payload: {
            parts: [{ kind: "text", text: "url-test@example.com" }],
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
        { method: "email", email: "url-test@example.com" },
        { turnId: "tu", threadId: "th-url", peer },
      );

      const emailText = sendCalls[0]?.text ?? "";
      const urlMatch = emailText.match(/(https?:\/\/[^\s]+)/);
      expect(urlMatch).not.toBeNull();
      const verifyUrl = new URL(urlMatch![1]!);

      // Must route to /visitor-auth/verify
      expect(verifyUrl.pathname).toBe("/visitor-auth/verify");
      // Must have exactly one `token` param, with a UUID-shaped value
      expect(verifyUrl.searchParams.getAll("token")).toHaveLength(1);
      expect(verifyUrl.searchParams.get("token")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      // No stray query-string carry-over from a base URL with ?utm=x etc.
      for (const key of verifyUrl.searchParams.keys()) {
        expect(key).toBe("token");
      }

      await aug.onShutdown?.();
    });
  }
});

describe("request_auth tool", () => {
  function buildAug(overrides?: {
    sendImpl?: AgentMailClient["send"];
    rateLimit?: { perHour: number; perDay: number; minIntervalSeconds?: number };
    useDefaultRateLimit?: boolean;
    nowFn?: () => number;
    consoleDelivery?: boolean;
  }) {
    const sendCalls: Array<Parameters<AgentMailClient["send"]>[0]> = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: overrides?.consoleDelivery
        ? { transport: "console" }
        : { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      ...(overrides?.useDefaultRateLimit
        ? {}
        : { rateLimit: overrides?.rateLimit ?? { perHour: 1, perDay: 3 } }),
      _now: overrides?.nowFn,
      _agentMailClient: fakeAgentMail({
        send: async (input) => {
          sendCalls.push(input);
          if (overrides?.sendImpl) return overrides.sendImpl(input);
          return { status: "sent", messageId: "m1", threadId: "t1" };
        },
      }),
    });
    return { aug, sendCalls };
  }

  function turnWithVisitor(
    text: string,
    peerId = "anon-thread1",
    kind: "human" | "anonymous" = "anonymous",
  ) {
    return {
      turnId: "tu",
      threadId: "thread1",
      trigger: {
        type: "message",
        turnId: "tu",
        timestamp: 0,
        peer: {
          id: peerId,
          kind,
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
        payload: {
          parts: [{ kind: "text", text }],
          sourceAugment: "web",
          peer: {
            id: peerId,
            kind,
            trustLevel: "public",
            publicSubstate: "anonymous",
            sourceAugment: "web",
          },
          timestamp: 0,
        },
      },
      peer: {
        id: peerId,
        kind,
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never;
  }

  test("rejects non-email methods", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    const tool = aug.tools![0]!;
    const raw = await tool.execute(
      { method: "sms" as never, email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "th1",
        peer: {
          id: "anon-th1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/method/);
    await aug.onShutdown?.();
  });

  test("rejects malformed email", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("hi"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "not-an-email" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    expect(JSON.parse(raw as string).status).toBe("rejected");
    await aug.onShutdown?.();
  });

  test("forwards request_auth cancellation to AgentMail delivery", async () => {
    let observedSignal: AbortSignal | undefined;
    const { aug } = buildAug({
      sendImpl: async (input) => {
        observedSignal = input.signal;
        return { status: "sent", messageId: "m1", threadId: "t1" };
      },
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const controller = new AbortController();

    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
        signal: controller.signal,
      },
    );

    expect(JSON.parse(raw as string).status).toBe("sent");
    expect(observedSignal).toBe(controller.signal);
    await aug.onShutdown?.();
  });

  test("reserves verification quota when AgentMail delivery outcome is unknown", async () => {
    const { aug } = buildAug({
      sendImpl: async () => {
        throw new OutcomeUnknownError("response lost after dispatch");
      },
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const context: ToolExecuteContext = {
      turnId: "t1",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    await expect(
      aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, context),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    const retry = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        context,
      )) as string,
    );
    expect(retry).toMatchObject({ status: "rejected", code: "rate_limited" });
    await aug.onShutdown?.();
  });

  test("rejects request_auth outside the anonymous public visitor boundary", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();
    const rejectedPeers: NonNullable<ToolExecuteContext["peer"]>[] = [
      {
        id: "creator",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "web",
      },
      {
        id: "agent:worker",
        kind: "agent",
        trustLevel: "agent",
        sourceAugment: "web",
      },
      {
        id: "system",
        kind: "system",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    ];

    for (const peer of rejectedPeers) {
      const raw = await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        { turnId: `turn-${peer.id}`, threadId: `thread-${peer.id}`, peer },
      );
      expect(JSON.parse(raw as string)).toEqual({
        status: "rejected",
        code: "peer_not_anonymous",
        message: "request_auth is only available to an anonymous public visitor.",
      });
    }
    expect(sendCalls).toHaveLength(0);
    await aug.onShutdown?.();
  });

  test("allows recognized visitors to request auth only when reverification is due", async () => {
    const clock = 2_000;
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.recordVerifiedVisitor({
      visitorId: "vis_due",
      email: "due@example.com",
      verifiedAt: 500,
      lastSeenAt: 500,
      reverifyDueAt: clock,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.recordVerifiedVisitor({
      visitorId: "vis_current",
      email: "current@example.com",
      verifiedAt: 1_000,
      lastSeenAt: 1_000,
      reverifyDueAt: clock + 1,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.close();

    const { aug, sendCalls } = buildAug({ nowFn: () => clock });
    await aug.onBoot?.();
    const executeAs = async (visitorId: string, email: string) => {
      await aug.onTurnStart?.(turnWithVisitor(email, visitorId, "human"));
      const raw = await aug.tools![0]!.execute(
        { method: "email", email },
        {
          turnId: `turn-${visitorId}`,
          threadId: `thread-${visitorId}`,
          peer: {
            id: visitorId,
            kind: "human",
            trustLevel: "public",
            publicSubstate: "recognized",
            sourceAugment: "web",
          },
        },
      );
      return JSON.parse(raw as string);
    };

    expect(await executeAs("vis_current", "current@example.com")).toEqual({
      status: "rejected",
      code: "reverification_not_due",
      message: "This recognized visitor does not need reverification yet.",
    });
    expect(await executeAs("vis_due", "due@example.com")).toMatchObject({ status: "sent" });
    expect(sendCalls).toHaveLength(1);
    await aug.onShutdown?.();
  });

  test("allows a human peer in the anonymous public visitor state", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com", "anon-human-thread", "human"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "turn-human",
        threadId: "human-thread",
        peer: {
          id: "anon-human-thread",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    expect(JSON.parse(raw as string)).toMatchObject({ status: "sent" });
    expect(sendCalls).toHaveLength(1);
    await aug.onShutdown?.();
  });

  test("rejects when email did not appear in recent messages (fix #4)", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("hi I'm here"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/recent|message/i);
    await aug.onShutdown?.();
  });

  test("happy path: returns status 'sent', calls AgentMail with verify URL", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("my email is alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("sent");
    expect(result.delivery).toBe("email");
    expect(result.message).toMatch(/email sent/i);
    expect(result.expiresInSec).toBeGreaterThan(0);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toEqual(["alice@example.com"]);
    expect(sendCalls[0]?.text).toMatch(/https:\/\/zip\.test\/visitor-auth\/verify\?token=/);
    expect(sendCalls[0]?.html).toMatch(/https:\/\/zip\.test\/visitor-auth\/verify\?token=/);
    expect(sendCalls[0]?.html).toMatch(/Verify email/);
    expect(sendCalls[0]?.subject).toMatch(/verify/i);
    await aug.onShutdown?.();
  });

  test("console delivery says that no email was sent", async () => {
    const { aug } = buildAug({ consoleDelivery: true });
    expect(aug.tools![0]!.description).toMatch(/No email is sent/i);
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("my email is alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result).toMatchObject({
      status: "sent",
      delivery: "console",
    });
    expect(result.message).toMatch(/printed to the local agent console/i);
    expect(result.message).toMatch(/no email was sent/i);
    expect(result.message).not.toMatch(/verification email sent/i);
    await aug.onShutdown?.();
  });

  test("console delivery failure does not claim an email send failed", async () => {
    const { aug } = buildAug({
      consoleDelivery: true,
      sendImpl: async () => ({ status: "failed", detail: "stdout unavailable" }),
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("my email is alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result).toMatchObject({
      status: "failed",
      code: "send_failed",
    });
    expect(result.message).toMatch(/print verification link to the local agent console/i);
    expect(result.message).toContain("stdout unavailable");
    expect(result.message).not.toMatch(/send verification email/i);
    await aug.onShutdown?.();
  });

  test("console delivery defaults to an exact 10-second cooldown", async () => {
    let clock = 1_000_000_000_000;
    const { aug, sendCalls } = buildAug({
      consoleDelivery: true,
      useDefaultRateLimit: true,
      nowFn: () => clock,
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    const first = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(first.status).toBe("sent");

    clock += 9_000;
    const blocked = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(blocked).toMatchObject({
      status: "rejected",
      code: "rate_limited",
      retryAfterSec: 1,
    });
    expect(blocked.message).toContain("Try again in 1 second(s).");
    expect(blocked.message).not.toMatch(/minute|~/i);

    clock += 1_000;
    const afterCooldown = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(afterCooldown.status).toBe("sent");
    expect(sendCalls).toHaveLength(2);
    await aug.onShutdown?.();
  });

  test("serializes concurrent sends for one email so cooldown cannot be bypassed", async () => {
    let sendStarted!: () => void;
    let finishSend!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const pendingSend = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const { aug, sendCalls } = buildAug({
      consoleDelivery: true,
      useDefaultRateLimit: true,
      sendImpl: async () => {
        sendStarted();
        await pendingSend;
        return { status: "sent", messageId: "m1", threadId: "t1" };
      },
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    const firstPromise = aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      ctx,
    );
    await started;
    const secondPromise = aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      ctx,
    );
    finishSend();

    const [first, second] = await Promise.all([firstPromise, secondPromise]).then((results) =>
      results.map((raw) => JSON.parse(raw as string)),
    );
    expect(first.status).toBe("sent");
    expect(second).toMatchObject({
      status: "rejected",
      code: "rate_limited",
      retryAfterSec: 10,
    });
    expect(sendCalls).toHaveLength(1);
    await aug.onShutdown?.();
  });

  test("AgentMail delivery keeps the existing one-per-hour default", async () => {
    let clock = 1_000_000_000_000;
    const { aug } = buildAug({ useDefaultRateLimit: true, nowFn: () => clock });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    const first = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(first.status).toBe("sent");

    clock += 10_000;
    const blocked = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(blocked).toMatchObject({
      status: "rejected",
      code: "rate_limited",
      retryAfterSec: 3_590,
    });
    expect(blocked.message).toContain("3590 second(s)");
    await aug.onShutdown?.();
  });

  test("a failed local delivery does not consume the cooldown", async () => {
    let attempts = 0;
    const { aug } = buildAug({
      consoleDelivery: true,
      useDefaultRateLimit: true,
      sendImpl: async () => {
        attempts++;
        return attempts === 1
          ? { status: "failed", detail: "stdout unavailable" }
          : { status: "sent", messageId: "m2", threadId: "t2" };
      },
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    const failed = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    const retry = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(failed.code).toBe("send_failed");
    expect(retry.status).toBe("sent");
    expect(attempts).toBe(2);
    await aug.onShutdown?.();
  });

  test("rate-limit blocks 2nd send within the hour (keyed to email, not peer.id)", async () => {
    // Fix H1: the rate limit is now keyed to the EMAIL address, not the peer.id.
    // This test proves threadId rotation no longer bypasses the limit:
    // the second call uses a DIFFERENT peer.id but the SAME email — and is rejected.
    const { aug } = buildAug({ rateLimit: { perHour: 1, perDay: 3 } });
    await aug.onBoot?.();

    // First call from peer anon-thread1.
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com", "anon-thread1"));
    const ctx1: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    const first = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx1,
      )) as string,
    );
    expect(first.status).toBe("sent");

    // Second call from a DIFFERENT peer (rotated threadId) — same email → rejected.
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com", "anon-thread-ROTATED"));
    const ctx2: ToolExecuteContext = {
      turnId: "t2",
      threadId: "thread-ROTATED",
      peer: {
        id: "anon-thread-ROTATED",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    const second = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx2,
      )) as string,
    );
    expect(second.status).toBe("rejected");
    expect(second.message).toMatch(/limit|wait/i);
    await aug.onShutdown?.();
  });

  test("different emails from the same peer don't share rate-limit quota", async () => {
    // Fix H1: per-email keying means alice and bob each get their own quota.
    // The same peer can send to two different emails without hitting the limit
    // (as long as each email is within its own per-email budget).
    const { aug, sendCalls } = buildAug({ rateLimit: { perHour: 1, perDay: 3 } });
    await aug.onBoot?.();
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    // First email: alice. Include both addresses in the recent messages.
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com bob@example.com"));
    const r1 = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx,
      )) as string,
    );
    expect(r1.status).toBe("sent");

    // Second email: bob (different address, same peer). Also within bob's own hourly quota.
    const r2 = JSON.parse(
      (await aug.tools![0]!.execute({ method: "email", email: "bob@example.com" }, ctx)) as string,
    );
    expect(r2.status).toBe("sent");
    expect(sendCalls).toHaveLength(2);
    await aug.onShutdown?.();
  });

  test("AgentMail send failure returns status 'failed' with detail (fix #7)", async () => {
    const { aug } = buildAug({
      sendImpl: async () => ({ status: "failed", detail: "smtp rejected", httpStatus: 400 }),
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous" as const,
          trustLevel: "public" as const,
          publicSubstate: "anonymous" as const,
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/smtp rejected/);
    await aug.onShutdown?.();
  });

  test("issuing a new token invalidates a prior open token for the same peer", async () => {
    const { aug, sendCalls } = buildAug({ rateLimit: { perHour: 5, perDay: 10 } });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    await aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, ctx);
    await aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, ctx);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.text).not.toEqual(sendCalls[1]?.text); // tokens differ
    await aug.onShutdown?.();
  });

  test("requires a peer in tool context (defense)", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "thread1", peer: null },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/peer/i);
    await aug.onShutdown?.();
  });

  // F3 — failure-path token cleanup must be token-scoped, not peer-scoped.
  //
  // Race scenario: A and B run in parallel for the same peer but different
  // email keys (same-email requests are serialized by the delivery lock).
  //   1. A: pre-invalidate (no priors), issue tokenA, await send (→ fails).
  //   2. B: pre-invalidate (kills tokenA — line 192's intentional
  //      one-open-at-a-time policy), issue tokenB, await send (→ succeeds).
  //   3. A's send resolves "failed".
  //   4. A's failure-path cleanup runs.
  //
  // Without F3: A's cleanup calls invalidateOpenTokensForPeer(peer) — kills
  // tokenB as collateral. The visitor never receives a working token even
  // though B's send succeeded.
  //
  // With F3: A's cleanup calls invalidateTokenIfStillOpen(tokenA) — tokenA
  // is already consumed (killed by B's pre-invalidate), so it's a no-op.
  // tokenB survives and is consumable by the visitor's verify click.
  test("failure-path cleanup is token-scoped — does not invalidate sibling concurrent token (F3)", async () => {
    let sendCallCount = 0;
    const sendResolvers: Array<
      (r: { status: "sent" | "failed"; detail?: string; httpStatus?: number }) => void
    > = [];
    const { aug, sendCalls } = buildAug({
      rateLimit: { perHour: 5, perDay: 10 },
      sendImpl: () =>
        new Promise<{
          status: "sent" | "failed";
          messageId?: string;
          threadId?: string;
          detail?: string;
        }>((resolve) => {
          sendCallCount++;
          sendResolvers.push(
            resolve as (r: {
              status: "sent" | "failed";
              detail?: string;
              httpStatus?: number;
            }) => void,
          );
        }) as unknown as ReturnType<AgentMailClient["send"]>,
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com and bob@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    // Kick off two parallel calls. Their distinct email locks both pass the
    // rate limit and pre-invalidate,
    // then both await send. Their `execute()` Promises stay pending until
    // we resolve their corresponding entries in sendResolvers.
    const callA = aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, ctx);
    // Yield so callA has issued tokenA and is awaiting send before callB
    // pre-invalidates. Without this yield, the relative ordering of
    // pre-invalidate vs. issueToken can interleave unpredictably.
    await new Promise((r) => setTimeout(r, 0));
    const callB = aug.tools![0]!.execute({ method: "email", email: "bob@example.com" }, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(sendCallCount).toBe(2);

    // Resolve A (loser) first as "failed". This is when A's cleanup runs.
    // Then resolve B (winner) as "sent".
    sendResolvers[0]!({ status: "failed", detail: "smtp rejected the message", httpStatus: 400 });
    sendResolvers[1]!({
      status: "sent",
      messageId: "m",
      threadId: "t",
    } as unknown as { status: "sent" });
    const [resA, resB] = await Promise.all([callA, callB]);
    const resAJson = JSON.parse(resA as string);
    const resBJson = JSON.parse(resB as string);
    expect(resAJson.status).toBe("failed");
    expect(resBJson.status).toBe("sent");

    // Extract tokens from the verify URLs sent.
    const extractToken = (text: string): string => {
      const m = text.match(/token=([0-9a-f-]+)/i);
      return m?.[1] ?? "";
    };
    const tokenA = extractToken(sendCalls[0]?.text ?? "");
    const tokenB = extractToken(sendCalls[1]?.text ?? "");
    expect(tokenA).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenB).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenA).not.toEqual(tokenB);

    // Probe the underlying store. With F3, tokenB (the winner) is still open.
    // Without F3, tokenB has been wiped by A's failure-path peer-wide invalidate.
    const probe = createSqliteVisitorAuthStore({ dbPath });
    probe.initialize();
    // Probe at a moment well inside the 15-minute default TTL.
    const t = Date.now() + 100;
    expect(probe.tokenStatus(tokenB, t)).toBe("open");
    // tokenA was killed by B's line-192 pre-invalidate; that's the intentional
    // one-open-at-a-time policy and is unaffected by F3.
    expect(probe.tokenStatus(tokenA, t)).toBe("consumed");
    probe.close();

    await aug.onShutdown?.();
  });
});

describe("visitorAuth app request route", () => {
  function buildAug(overrides?: {
    sendImpl?: AgentMailClient["send"];
    rateLimit?: { perHour: number; perDay: number };
  }) {
    const sendCalls: Array<Parameters<AgentMailClient["send"]>[0]> = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      rateLimit: overrides?.rateLimit ?? { perHour: 1, perDay: 3 },
      _agentMailClient: fakeAgentMail({
        send: async (input) => {
          sendCalls.push(input);
          if (overrides?.sendImpl) return overrides.sendImpl(input);
          return { status: "sent", messageId: "m1", threadId: "t1" };
        },
      }),
    });
    return { aug, sendCalls };
  }

  function requestBody(body: unknown): Request {
    return new Request("https://zip.test/visitor-auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("sends a magic link without a model turn", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();

    const res = await aug.httpRoutes![2]!.handler(requestBody({ email: "Alice@Example.com" }), {
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      status: string;
      expiresInSec: number;
    };
    expect(result).toMatchObject({
      status: "sent",
    });
    expect(result.expiresInSec).toBeGreaterThan(0);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toEqual(["alice@example.com"]);
    expect(sendCalls[0]?.text).toMatch(/https:\/\/zip\.test\/visitor-auth\/verify\?token=/);
    await aug.onShutdown?.();
  });

  test("forwards the route cancellation signal to verification delivery", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();
    const controller = new AbortController();

    const res = await aug.httpRoutes![2]!.handler(requestBody({ email: "alice@example.com" }), {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(sendCalls[0]?.signal).toBe(controller.signal);
    await aug.onShutdown?.();
  });

  test("accepts route meta as non-authoritative audit context", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();

    const res = await aug.httpRoutes![2]!.handler(
      requestBody({
        email: "alice@example.com",
        meta: {
          messageId: "msg-ui-123",
          source: "console",
          returnTo: "/account",
        },
      }),
      { signal: new AbortController().signal },
    );

    expect(res.status).toBe(200);
    expect(sendCalls).toHaveLength(1);
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token = new URL(verifyUrl).searchParams.get("token")!;
    const db = new Database(dbPath);
    const row = db
      .query("SELECT source_message_id FROM visitor_auth_tokens WHERE token = ?")
      .get(token) as { source_message_id: string | null } | null;
    db.close();
    expect(row?.source_message_id).toBe("msg-ui-123");
    await aug.onShutdown?.();
  });

  test("rejects caller-supplied threadId so public apps cannot claim anonymous chat memory", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();

    const res = await aug.httpRoutes![2]!.handler(
      requestBody({ email: "alice@example.com", threadId: "victim-thread" }),
      { signal: new AbortController().signal },
    );

    expect(res.status).toBe(400);
    expect(sendCalls).toHaveLength(0);
    await aug.onShutdown?.();
  });

  test("rejects identity-like meta keys so public apps cannot bind visitor identity", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();

    const res = await aug.httpRoutes![2]!.handler(
      requestBody({
        email: "alice@example.com",
        meta: { threadId: "victim-thread" },
      }),
      { signal: new AbortController().signal },
    );

    expect(res.status).toBe(400);
    expect(sendCalls).toHaveLength(0);
    await aug.onShutdown?.();
  });

  test("rejects malformed email with a stable code", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();

    const res = await aug.httpRoutes![2]!.handler(requestBody({ email: "not-an-email" }), {
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      status: "rejected",
      code: "malformed_email",
    });
    expect(sendCalls).toHaveLength(0);
    await aug.onShutdown?.();
  });

  test("uses the same per-email rate limit as the tool route", async () => {
    const { aug } = buildAug({ rateLimit: { perHour: 1, perDay: 3 } });
    await aug.onBoot?.();

    const first = await aug.httpRoutes![2]!.handler(requestBody({ email: "alice@example.com" }), {
      signal: new AbortController().signal,
    });
    expect(first.status).toBe(200);

    const second = await aug.httpRoutes![2]!.handler(requestBody({ email: "alice@example.com" }), {
      signal: new AbortController().signal,
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      status: "rejected",
      code: "rate_limited",
    });
    await aug.onShutdown?.();
  });

  test("route-issued magic link verifies through the existing POST verify flow", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();

    const request = await aug.httpRoutes![2]!.handler(requestBody({ email: "alice@example.com" }), {
      signal: new AbortController().signal,
    });
    expect(request.status).toBe(200);
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token = new URL(verifyUrl).searchParams.get("token")!;

    const verify = await aug.httpRoutes![1]!.handler(
      new Request("https://zip.test/visitor-auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      { signal: new AbortController().signal },
    );

    expect(verify.status).toBe(200);
    const html = await verify.text();
    expect(html).toContain("auggy-visitor-token");
    await aug.onShutdown?.();
  });
});

// F10 — recentByPeer eviction. Without this, a long-running agent under high
// peer churn (anon-* ids change per thread) accumulates per-peer entries
// forever. The amortized sweep evicts entries that haven't been seen within
// RECENT_PEER_TTL_MS (24h).
describe("recentByPeer TTL eviction (F10)", () => {
  // Many-peer eviction. Seeds N stale peers (each with an email in their
  // recent-messages buffer), advances the clock past the 24h TTL, drives the
  // sweep, and asserts that ALL N peers' buffers are evicted — not just the
  // first one in the Map's iteration order. Catches a regression where the
  // sweep loop forgets to fully iterate (e.g., breaks on first match) or
  // forgets to evict from one of the two coupled Maps (recentByPeer vs.
  // lastSeenByPeer).
  test("evicts stale per-peer recent-message entries — all N peers, not just the first", async () => {
    let clock = 1_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();

    function turnFor(peerId: string, text: string) {
      return {
        turnId: "tu",
        threadId: peerId,
        trigger: {
          type: "message",
          turnId: "tu",
          timestamp: clock,
          peer: { id: peerId, kind: "anonymous", trustLevel: "public" },
          payload: {
            parts: [{ kind: "text", text }],
            sourceAugment: "web",
            peer: { id: peerId, kind: "anonymous", trustLevel: "public" },
            timestamp: clock,
          },
        },
        peer: { id: peerId, kind: "anonymous", trustLevel: "public" },
        toolCallsSoFar: 0,
        turnStartedAt: clock,
        metadata: {},
      } as never;
    }

    const ctxFor = (peerId: string): ToolExecuteContext => ({
      turnId: "t",
      threadId: peerId,
      peer: {
        id: peerId,
        kind: "anonymous" as const,
        trustLevel: "public" as const,
        publicSubstate: "anonymous" as const,
        sourceAugment: "web",
      },
    });

    // Seed N=10 stale peers, each with a unique email in their
    // recent-messages buffer. All seeded at the same clock so all expire
    // simultaneously.
    const N = 10;
    const stalePeers = Array.from({ length: N }, (_, i) => ({
      peerId: `anon-stale-${i}`,
      email: `stale-${i}@example.com`,
    }));
    for (const { peerId, email } of stalePeers) {
      await aug.onTurnStart?.(turnFor(peerId, email));
    }

    // Sanity: while still fresh, request_auth for each peer's email passes
    // the recent-messages check (proves the buffers were actually seeded).
    for (const { peerId, email } of stalePeers) {
      const r = JSON.parse(
        (await aug.tools![0]!.execute({ method: "email", email }, ctxFor(peerId))) as string,
      );
      // Either status: "sent" or rate-limit rejection ("Verification rate
      // limit reached") — both prove the recent-messages check passed.
      // What we explicitly should NOT see is "not found in recent messages".
      expect(r.message).not.toMatch(/recent messages/i);
    }

    // Advance clock past the 24h TTL.
    clock += 25 * 60 * 60_000;

    // Drive enough fresh-peer turns to cross the sweep threshold. Need
    // RECENT_PEER_SWEEP_EVERY (50) onTurnStart calls SINCE the last sweep.
    // We've done 10 + N*1 (= 20) seed/sanity-probe turns; drive ~50 more
    // to guarantee the modulo-50 sweep definitely fires after the clock
    // advance.
    for (let i = 0; i < 60; i++) {
      await aug.onTurnStart?.(turnFor(`anon-warm-${i}`, `warm-${i}@example.com`));
    }

    // Now every stale peer's buffer MUST be evicted. Each one's
    // request_auth should be rejected with the recent-messages error,
    // proving recentByPeer.delete fired for each.
    for (const { peerId, email } of stalePeers) {
      const r = JSON.parse(
        (await aug.tools![0]!.execute({ method: "email", email }, ctxFor(peerId))) as string,
      );
      expect(r.status).toBe("rejected");
      expect(r.message).toMatch(/recent messages/i);
    }
    await aug.onShutdown?.();
  });
});

// F11 — rate-limiter background sweep registers in onBoot, clears in
// onShutdown. The sweep itself runs hourly under a real clock; the tests
// here cover three claims:
//   1. sweep() correctness (the unit).
//   2. setInterval is actually wired in onBoot (the callback fires after
//      registration).
//   3. clearInterval in onShutdown stops the cadence (no further callbacks
//      after shutdown).
describe("rate-limiter background sweep (F11)", () => {
  test("sweep() drops keys with no live timestamps", () => {
    const limiter = createVisitorAuthRateLimiter({ perHour: 5, perDay: 10 });
    // Seed at t=0.
    limiter.record("email:alice", 0);
    limiter.record("email:bob", 0);
    // Bob keeps firing inside the day window.
    limiter.record("email:bob", 23 * 60 * 60_000);
    // 25h later: alice's entry is fully stale; bob's still has the t=23h tick.
    const evicted = limiter.sweep(25 * 60 * 60_000);
    expect(evicted).toBe(1);
  });

  // Guards against a regression where the `setInterval` registration is
  // accidentally removed (sweep() unit-tests still pass; only this test would
  // fail). Uses a 30ms test-only sweep cadence + a callback hook to observe
  // each tick.
  test("onBoot wires setInterval — sweep callback fires repeatedly under the test cadence", async () => {
    const ticks: Array<{ evicted: number; now: number }> = [];
    const clock = 0;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _now: () => clock,
      _rateLimitSweepIntervalMs: 30,
      _onRateLimitSweep: (evicted, now) => {
        ticks.push({ evicted, now });
      },
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    // Wait long enough for ~3 ticks at 30ms cadence.
    await new Promise((r) => setTimeout(r, 110));
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    await aug.onShutdown?.();
  });

  test("onShutdown clears the sweep interval — no further callbacks after shutdown", async () => {
    const ticks: Array<{ evicted: number; now: number }> = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _rateLimitSweepIntervalMs: 30,
      _onRateLimitSweep: (evicted, now) => {
        ticks.push({ evicted, now });
      },
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    await new Promise((r) => setTimeout(r, 80));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    await aug.onShutdown?.();
    const post = ticks.length;
    // After shutdown, no further callbacks should arrive even if we wait
    // multiple cadences.
    await new Promise((r) => setTimeout(r, 120));
    expect(ticks.length).toBe(post);
  });

  test("the setInterval-driven sweep actually evicts stale entries (end-to-end)", async () => {
    const ticks: Array<{ evicted: number; now: number }> = [];
    let clock = 0;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _now: () => clock,
      _rateLimitSweepIntervalMs: 30,
      _onRateLimitSweep: (evicted, now) => {
        ticks.push({ evicted, now });
      },
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    // Drive request_auth so the rate limiter has an entry. We exercise the
    // tool's recent-message path, which records into the limiter via
    // rateLimiter.record under the hood.
    await aug.onTurnStart?.({
      turnId: "tu",
      threadId: "thread1",
      trigger: {
        type: "message",
        turnId: "tu",
        timestamp: clock,
        peer: { id: "anon-thread1", kind: "anonymous", trustLevel: "public" },
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer: { id: "anon-thread1", kind: "anonymous", trustLevel: "public" },
          timestamp: clock,
        },
      },
      peer: { id: "anon-thread1", kind: "anonymous", trustLevel: "public" },
      toolCallsSoFar: 0,
      turnStartedAt: clock,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    // Advance the injected clock past the limiter's 24h window. The next
    // sweep tick (real-time 30ms cadence) sees stale entries and evicts
    // them — observable via the callback's `evicted` count.
    clock = 25 * 60 * 60_000;
    // Reset the ticks observed before the clock advance.
    ticks.length = 0;
    await new Promise((r) => setTimeout(r, 80));
    const evictionTicks = ticks.filter((t) => t.evicted > 0);
    expect(evictionTicks.length).toBeGreaterThanOrEqual(1);
    await aug.onShutdown?.();
  });

  test("onShutdown is idempotent — no throw on double-call or shutdown-without-boot", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    await aug.onShutdown?.();
    await aug.onShutdown?.();

    const aug2 = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug2.onShutdown?.();
  });
});

describe("context() block", () => {
  test("emits no block for an unknown peer with no token + no verified row", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-x",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    const result = await aug.context?.({ peer } as never);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });

  test("emits 'awaiting click' block while token is open", async () => {
    let clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      tokenTtlMinutes: 15,
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-c1",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th",
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
      { turnId: "t", threadId: "th", peer },
    );
    clock += 3 * 60_000;
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result![0]?.content).toMatch(/alice@example\.com/);
    expect(result![0]?.content.toLowerCase()).toMatch(/awaiting|sent|expires/);
    await aug.onShutdown?.();
  });

  test("console context consistently says the link was printed and no email was sent", async () => {
    let clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { transport: "console" },
      signingKey: "sig",
      tokenTtlMinutes: 15,
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-console-context",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: clock,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: clock,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: clock,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th", peer },
    );

    clock += 3 * 60_000;
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain("printed to the local agent console");
    expect(result[0]?.content).toContain("no email was sent");
    expect(result[0]?.content).not.toMatch(/verification email sent/i);
    await aug.onShutdown?.();
  });

  test("emits 'expired' block when token TTL has passed", async () => {
    let clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      tokenTtlMinutes: 1,
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-c2",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th",
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
      { turnId: "t", threadId: "th", peer },
    );
    clock += 5 * 60_000;
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result![0]?.content.toLowerCase()).toContain("expired");
    await aug.onShutdown?.();
  });

  test("emits 'verified' block when peer matches a verified-visitor row", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peerId = "vis_aaaa";
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitorAuth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    const t = Date.now();
    seedStore.recordVerifiedVisitor({
      visitorId: peerId,
      email: "alice@example.com",
      verifiedAt: t - 60_000,
      lastSeenAt: t - 60_000,
      reverifyDueAt: t + 90 * 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.close();
    const peer = {
      id: peerId,
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "web",
    };
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result![0]?.content).toMatch(/alice@example\.com/);
    expect(result![0]?.content.toLowerCase()).toContain("verified");
    await aug.onShutdown?.();
  });

  test("emits 'reverify due' block when reverify_due_at is in the past", async () => {
    const clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitorAuth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.recordVerifiedVisitor({
      visitorId: "vis_old",
      email: "stale@x",
      verifiedAt: clock - 100 * 86_400_000,
      lastSeenAt: null,
      reverifyDueAt: clock - 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.close();
    const peer = {
      id: "vis_old",
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "web",
    };
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result![0]?.content.toLowerCase()).toContain("reverif");
    await aug.onShutdown?.();
  });

  test("emits no block when verified row is revoked", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitorAuth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.recordVerifiedVisitor({
      visitorId: "vis_rev",
      email: "revoked@x",
      verifiedAt: Date.now(),
      lastSeenAt: null,
      reverifyDueAt: Date.now() + 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.revokeByEmail("revoked@x", "operator", Date.now());
    seedStore.close();
    const peer = {
      id: "vis_rev",
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "web",
    };
    const result = await aug.context?.({ peer } as never);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });
});

function makeAugWithFirstVerify(dbPath: string) {
  const sends: {
    to: string[];
    subject: string;
    text: string;
    inboxId: string;
    signal?: AbortSignal;
  }[] = [];
  const aug = visitorAuth({
    publicUrl: "https://zip.test",
    dbPath,
    agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
    signingKey: "sig",
    // Open rate limit so two verifications of the same email (from different
    // peers / threadIds) can proceed in the same test. Fix H1 keys the
    // rate-limiter to the EMAIL, so both sends count against the same email
    // quota — bump the cap to 5/10 to allow the multi-verify scenario.
    rateLimit: { perHour: 5, perDay: 10 },
    notifyOnFirstVerify: { to: "ops@x.com", subjectPrefix: "[New verified] " },
    _agentMailClient: {
      send: async (i: {
        to: string[];
        subject: string;
        text: string;
        inboxId: string;
        signal?: AbortSignal;
      }) => {
        sends.push({
          to: i.to,
          subject: i.subject,
          text: i.text,
          inboxId: i.inboxId,
          signal: i.signal,
        });
        return { status: "sent" as const, messageId: "m", threadId: "t" };
      },
      getInbox: async () => ({
        inboxId: "ibx_x",
        email: "agent@example.com",
        status: "ok" as const,
      }),
    } as never,
  });
  return { aug, sends };
}

async function flowThroughVerify(
  aug: ReturnType<typeof visitorAuth>,
  email: string,
  threadId: string,
  sends: { text: string }[],
  signal = new AbortController().signal,
) {
  const peer = {
    id: `anon-${threadId}`,
    kind: "anonymous" as const,
    trustLevel: "public" as const,
    publicSubstate: "anonymous" as const,
    sourceAugment: "web",
  };
  await aug.onTurnStart?.({
    turnId: "t",
    threadId,
    trigger: {
      type: "message",
      turnId: "t",
      timestamp: 0,
      payload: { parts: [{ kind: "text", text: email }], sourceAugment: "web", peer, timestamp: 0 },
    },
    peer,
    toolCallsSoFar: 0,
    turnStartedAt: 0,
    metadata: {},
  } as never);
  await aug.tools![0]!.execute({ method: "email", email }, {
    turnId: "t",
    threadId,
    peer,
  } as ToolExecuteContext);
  // sends[0] is the visitor's magic-link mail; pull the token out of the URL.
  const verifyUrl = sends[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
  const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
  // POST route (index 1) consumes the token and mints the vis_ visitor token.
  return aug.httpRoutes![1]!.handler(
    new Request(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(tokenParam)}`,
    }),
    { signal },
  );
}

describe("notifyOnFirstVerify", () => {
  test("fires AgentMail to operator on first verify per email", async () => {
    const { aug, sends } = makeAugWithFirstVerify(dbPath);
    await aug.onBoot?.();
    const controller = new AbortController();
    const res = await flowThroughVerify(
      aug,
      "alice@example.com",
      "th-fv",
      sends,
      controller.signal,
    );
    expect(res.status).toBe(200);
    // Two sends: visitor's magic link FIRST, then operator notification SECOND.
    expect(sends).toHaveLength(2);
    expect(sends[0]?.to).toEqual(["alice@example.com"]);
    expect(sends[1]?.to).toEqual(["ops@x.com"]);
    expect(sends[1]?.subject).toContain("[New verified]");
    expect(sends[1]?.text).toContain("alice@example.com");
    expect(sends[1]?.signal).toBe(controller.signal);
    await aug.onShutdown?.();
  });

  test("does not fire on subsequent verifications of the same email", async () => {
    const { aug, sends } = makeAugWithFirstVerify(dbPath);
    await aug.onBoot?.();
    await flowThroughVerify(aug, "bob@example.com", "th-b1", sends);
    sends.length = 0;
    await flowThroughVerify(aug, "bob@example.com", "th-b2", sends);
    // Second flow contains ONLY the visitor's magic-link mail; no operator note.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual(["bob@example.com"]);
    await aug.onShutdown?.();
  });

  // F5: mark-after-send tests
  test("does NOT mark the ledger when AgentMail returns failed (F5)", async () => {
    // Stub: first send (visitor magic-link) succeeds; second send (operator note) fails.
    const sends: { to: string[]; subject: string; text: string; inboxId: string }[] = [];
    let sendCount = 0;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      rateLimit: { perHour: 5, perDay: 10 },
      notifyOnFirstVerify: { to: "ops@x.com" },
      _agentMailClient: {
        send: async (i: { to: string[]; subject: string; text: string; inboxId: string }) => {
          sends.push(i);
          sendCount++;
          if (sendCount === 1) {
            // visitor magic-link send succeeds
            return { status: "sent" as const, messageId: "m", threadId: "t" };
          }
          // operator notification send fails
          return { status: "failed" as const, detail: "400 rejected", httpStatus: 400 };
        },
        getInbox: async () => ({
          inboxId: "ibx_x",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as never,
    });
    await aug.onBoot?.();
    // First verify: operator notification send fails → ledger must NOT be marked.
    const res = await flowThroughVerify(aug, "fail-notify@example.com", "th-fn1", sends);
    expect(res.status).toBe(200); // verify itself must still succeed

    // Probe the ledger directly to confirm it was NOT marked.
    const { createSqliteVisitorAuthStore: makeStore } = await import(
      "../../../src/augments/visitorAuth/storage/sqlite-store"
    );
    const probeStore = makeStore({ dbPath });
    probeStore.initialize();
    const marked = probeStore.hasNotifiedFirstVerifyFor("fail-notify@example.com");
    probeStore.close();
    expect(marked).toBe(false); // NOT marked — will retry on next verify

    await aug.onShutdown?.();
  });

  test("persists an ambiguous first-verify notification tombstone across restart", async () => {
    let operatorAttempts = 0;
    const sends: Array<{
      to: string[];
      subject: string;
      text: string;
      inboxId: string;
      signal?: AbortSignal;
    }> = [];
    const build = () =>
      visitorAuth({
        publicUrl: "https://zip.test",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        rateLimit: { perHour: 5, perDay: 10 },
        notifyOnFirstVerify: { to: "ops@x.com" },
        _agentMailClient: {
          send: async (input: {
            to: string[];
            subject: string;
            text: string;
            inboxId: string;
            signal?: AbortSignal;
          }) => {
            sends.push(input);
            if (input.to.includes("ops@x.com")) {
              operatorAttempts++;
              throw new OutcomeUnknownError("provider response lost after dispatch");
            }
            return { status: "sent" as const, messageId: "m", threadId: "t" };
          },
          getInbox: async () => ({
            inboxId: "ibx_x",
            email: "agent@example.com",
            status: "ok" as const,
          }),
        } as never,
      });

    const first = build();
    await first.onBoot?.();
    expect(
      (await flowThroughVerify(first, "ambiguous-note@example.com", "th-note-1", sends)).status,
    ).toBe(200);
    await first.onShutdown?.();
    expect(operatorAttempts).toBe(1);

    sends.length = 0;
    const restarted = build();
    await restarted.onBoot?.();
    expect(
      (await flowThroughVerify(restarted, "ambiguous-note@example.com", "th-note-2", sends)).status,
    ).toBe(200);
    expect(operatorAttempts).toBe(1);
    await restarted.onShutdown?.();
  });

  test("marks the ledger when AgentMail returns sent (F5)", async () => {
    const sends: { to: string[]; subject: string; text: string; inboxId: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      rateLimit: { perHour: 5, perDay: 10 },
      notifyOnFirstVerify: { to: "ops@x.com" },
      _agentMailClient: {
        send: async (i: { to: string[]; subject: string; text: string; inboxId: string }) => {
          sends.push(i);
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({
          inboxId: "ibx_x",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as never,
    });
    await aug.onBoot?.();
    const res = await flowThroughVerify(aug, "mark-after-send@example.com", "th-mas", sends);
    expect(res.status).toBe(200);

    // Probe the ledger: must be marked now that send succeeded.
    const { createSqliteVisitorAuthStore: makeStore } = await import(
      "../../../src/augments/visitorAuth/storage/sqlite-store"
    );
    const probeStore = makeStore({ dbPath });
    probeStore.initialize();
    const marked = probeStore.hasNotifiedFirstVerifyFor("mark-after-send@example.com");
    probeStore.close();
    expect(marked).toBe(true);

    await aug.onShutdown?.();
  });
});

describe("isVisitorRevoked (fix C1)", () => {
  test("returns false before onBoot completes (fail-open)", () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        reply: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        forward: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        getInbox: async () => ({
          inboxId: "i",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as AgentMailClient,
    });
    // isVisitorRevoked is accessible via the VisitorAuthAugmentExtras surface.
    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // Not yet booted — fail-open: returns false rather than erroring.
    expect(augWithExtras.isVisitorRevoked("vis_anything")).toBe(false);
  });

  test("returns false for an unknown visitorId after boot", async () => {
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sends.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        reply: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        forward: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        getInbox: async () => ({
          inboxId: "i",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();
    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    expect(augWithExtras.isVisitorRevoked("vis_no_such_id")).toBe(false);
    await aug.onShutdown?.();
  });

  test("returns false for an active (non-revoked) visitor", async () => {
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sends.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        reply: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        forward: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        getInbox: async () => ({
          inboxId: "i",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();
    // Go through verify flow to get a vis_<uuid> visitor id.
    const resp = await flowThroughVerify(aug, "active@example.com", "th-active", sends);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    const tokenJsonMatch = html.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken = JSON.parse(tokenJsonMatch![1]!) as string;
    const visitorId = JSON.parse(atob(visToken.split(".")[0]!)).visitorId as string;

    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // Active visitor: not revoked.
    expect(augWithExtras.isVisitorRevoked(visitorId)).toBe(false);
    await aug.onShutdown?.();
  });

  test("returns true after revokeByEmail is called on the visitor's email", async () => {
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sends.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        reply: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        forward: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        getInbox: async () => ({
          inboxId: "i",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();
    const resp = await flowThroughVerify(aug, "revoke@example.com", "th-revoke", sends);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    const tokenJsonMatch = html.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken = JSON.parse(tokenJsonMatch![1]!) as string;
    const visitorId = JSON.parse(atob(visToken.split(".")[0]!)).visitorId as string;

    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // Not yet revoked.
    expect(augWithExtras.isVisitorRevoked(visitorId)).toBe(false);

    // Revoke directly via the store (simulating `auggy visitors --revoke`).
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.revokeByEmail("revoke@example.com", "operator", Date.now());
    seedStore.close();

    // isVisitorRevoked reads from the live DB — must now return true.
    expect(augWithExtras.isVisitorRevoked(visitorId)).toBe(true);
    await aug.onShutdown?.();
  });

  test("returns true for OLD visitorId after unrevoke-and-rotate (denylist check, fix H1)", async () => {
    // Regression guard: after unrevokeAndRotate, the old vis_id no longer exists
    // as a row in verified_visitors. Without the denylist, isVisitorRevoked would
    // return false for the old id (row not found → row?.revoked is undefined → false).
    // The denylist must catch it.
    const sends: { text: string }[] = [];
    let clock = 1_000;
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _now: () => clock,
      // Open rate limit so both verifications (pre- and post-revoke) can proceed.
      rateLimit: { perHour: 5, perDay: 10 },
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sends.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        reply: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        forward: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        getInbox: async () => ({
          inboxId: "i",
          email: "agent@example.com",
          status: "ok" as const,
        }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();

    // First verify: get vis_OLD.
    const resp1 = await flowThroughVerify(aug, "rotate@example.com", "th-rot1", sends);
    expect(resp1.status).toBe(200);
    const html1 = await resp1.text();
    const tokenJsonMatch1 = html1.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken1 = JSON.parse(tokenJsonMatch1![1]!) as string;
    const visOld = JSON.parse(atob(visToken1.split(".")[0]!)).visitorId as string;
    expect(visOld).toMatch(/^vis_/);

    // Revoke vis_OLD.
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.revokeByEmail("rotate@example.com", "operator", 2_000);
    seedStore.close();
    clock = 2_001;

    // Re-verify: unrevokeAndRotate fires, minting vis_NEW. OLD row is gone.
    sends.length = 0;
    const resp2 = await flowThroughVerify(aug, "rotate@example.com", "th-rot2", sends);
    expect(resp2.status).toBe(200);
    const html2 = await resp2.text();
    const tokenJsonMatch2 = html2.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken2 = JSON.parse(tokenJsonMatch2![1]!) as string;
    const visNew = JSON.parse(atob(visToken2.split(".")[0]!)).visitorId as string;
    expect(visNew).toMatch(/^vis_/);
    expect(visNew).not.toBe(visOld);

    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // vis_OLD must still be rejected via the denylist.
    expect(augWithExtras.isVisitorRevoked(visOld)).toBe(true);
    // vis_NEW must be admitted.
    expect(augWithExtras.isVisitorRevoked(visNew)).toBe(false);

    await aug.onShutdown?.();
  });
});
