import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { coerceInputs } from "@/transports/admin/admin-coerce";
import { serveStaticFile } from "@/transports/admin/admin-static";
import {
  type AdminActionRegistry,
  type AdminRouteContext,
  buildAdminActionRegistry,
  handleAdminRoute,
} from "@/transports/admin/index";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import { createConsoleCliLoginTicketStore } from "@/transports/admin/cli-login-tickets";
import type {
  AdminActionInput,
  AgentCard,
  Augment,
  RuntimeOperationalSnapshot,
  TransportKernel,
  TurnResult,
} from "@/types";

const expectedAuggyVersion = (
  JSON.parse(readFileSync(join(import.meta.dir, "../../..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

const numberInput: AdminActionInput = {
  name: "value",
  label: "Value",
  type: "number",
  required: true,
};
const boolInput: AdminActionInput = {
  name: "flag",
  label: "Flag",
  type: "boolean",
  required: true,
};
const textInput: AdminActionInput = {
  name: "msg",
  label: "Msg",
  type: "text",
  required: false,
};
type KernelRoutes = ReturnType<TransportKernel["getAugmentRoutes"]>;
type TestCollectedRoute = KernelRoutes[number] & { augmentName: string };

describe("admin-coerce", () => {
  it("coerces number string to typed string", () => {
    const r = coerceInputs([numberInput], { value: "42" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.value).toBe("42");
  });

  it("rejects non-numeric value for number input", () => {
    const r = coerceInputs([numberInput], { value: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("value");
      expect(r.reason).toMatch(/number/i);
    }
  });

  it("accepts 'true' / 'on' for boolean input", () => {
    expect(coerceInputs([boolInput], { flag: "true" }).ok).toBe(true);
    expect(coerceInputs([boolInput], { flag: "on" }).ok).toBe(true);
  });

  it("accepts 'false' / unset for boolean input", () => {
    expect(coerceInputs([boolInput], { flag: "false" }).ok).toBe(true);
    expect(coerceInputs([boolInput], {}).ok).toBe(true);
  });

  it("rejects required input when missing", () => {
    const r = coerceInputs([numberInput], {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("value");
  });

  it("optional text input is OK when missing", () => {
    const r = coerceInputs([textInput], {});
    expect(r.ok).toBe(true);
  });
});

async function makeCtx(
  overrides: Partial<AdminRouteContext> & {
    augments?: Augment[];
    routes?: readonly TestCollectedRoute[];
  } = {},
): Promise<AdminRouteContext> {
  const { augments = [], routes = [], ...rest } = overrides;
  const card: AgentCard = {
    provider: { name: "zip" },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      memory: false,
      transport: true,
    },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
  const kernel: TransportKernel = {
    handleInbound: async () => ({}) as unknown as TurnResult,
    onOutbound: () => {},
    quarantineThread: () => true,
    recoverThread: () => false,
    getAgentCard: () => card,
    getAugmentRoutes: () => routes as KernelRoutes,
    getAugments: () => augments,
  };
  const actionRegistry: AdminActionRegistry = await buildAdminActionRegistry(augments);
  return {
    kernel,
    bearer: "test-bearer",
    agentDir: undefined,
    callerIp: "127.0.0.1",
    actionRegistry,
    ...rest,
  };
}

function basicHeader(bearer: string): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
}

describe("handleAdminRoute — auth", () => {
  it("GET /console without bearer from non-loopback → 401", async () => {
    const req = new Request("https://my-agent.fly.dev/console", {
      headers: { accept: "application/json" },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Basic realm="auggy-admin zip (username auggy, password AUGGY_WEB_TOKEN)"',
    );
  });

  it("GET /console html navigation without auth redirects to first-party login", async () => {
    const req = new Request("https://my-agent.fly.dev/console/chat", {
      headers: { accept: "text/html" },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/login?next=%2Fconsole%2Fchat");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("GET /console/api/dashboard without auth returns JSON 401, not login HTML", async () => {
    const req = new Request("https://my-agent.fly.dev/console/api/dashboard", {
      headers: { accept: "text/html" },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("www-authenticate")).toContain("auggy-admin zip");
  });

  it("GET /console/login serves a first-party login page", async () => {
    const req = new Request("https://my-agent.fly.dev/console/login");
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Console sign-in");
    expect(body).toContain("AUGGY_WEB_TOKEN");
    expect(body).not.toContain("test-bearer");
  });

  it("exchanges explicit Basic auth for a single-use browser session ticket", async () => {
    const cliLoginTickets = createConsoleCliLoginTicketStore();
    const ctx = await makeCtx({
      callerIp: "10.0.0.5",
      requestOrigin: "https://my-agent.fly.dev",
      cliLoginTickets,
    });
    const issueRes = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/api/cli-login", {
        method: "POST",
        headers: { authorization: basicHeader("test-bearer") },
      }),
      ctx,
    );
    expect(issueRes.status).toBe(200);
    const issued = (await issueRes.json()) as {
      loginPath: string;
      expiresInSeconds: number;
    };
    expect(issued.loginPath).toMatch(/^\/console\/cli-login\/[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresInSeconds).toBe(30);

    const consume = () =>
      handleAdminRoute(new Request(`https://my-agent.fly.dev${issued.loginPath}`), ctx);
    const loginRes = await consume();
    expect(loginRes.status).toBe(303);
    expect(loginRes.headers.get("location")).toBe("/console/chat");
    expect(loginRes.headers.get("set-cookie")).toContain("HttpOnly");
    expect(loginRes.headers.get("set-cookie")).toContain("Secure");

    const replayRes = await consume();
    expect(replayRes.status).toBe(401);
    expect(await replayRes.text()).toContain("invalid or expired");
  });

  it("does not issue CLI tickets from a browser origin or session cookie", async () => {
    const cliLoginTickets = createConsoleCliLoginTicketStore();
    const ctx = await makeCtx({
      callerIp: "10.0.0.5",
      requestOrigin: "https://my-agent.fly.dev",
      cliLoginTickets,
    });
    const browserRes = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/api/cli-login", {
        method: "POST",
        headers: {
          authorization: basicHeader("test-bearer"),
          origin: "https://my-agent.fly.dev",
        },
      }),
      ctx,
    );
    expect(browserRes.status).toBe(401);

    const loginRes = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-bearer" }).toString(),
      }),
      ctx,
    );
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const sessionRes = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/api/cli-login", {
        method: "POST",
        headers: { cookie },
      }),
      ctx,
    );
    expect(sessionRes.status).toBe(401);
  });

  it("requires HTTPS before consuming a remote CLI login ticket", async () => {
    const cliLoginTickets = createConsoleCliLoginTicketStore({
      randomToken: () => "A".repeat(43),
    });
    cliLoginTickets.issue({ bearer: "test-bearer", origin: "http://my-agent.fly.dev" });
    const res = await handleAdminRoute(
      new Request(`http://my-agent.fly.dev/console/cli-login/${"A".repeat(43)}`),
      await makeCtx({
        callerIp: "10.0.0.5",
        requestOrigin: "http://my-agent.fly.dev",
        cliLoginTickets,
      }),
    );
    expect(res.status).toBe(426);
  });

  it("POST /console/login with valid password sets an HttpOnly session cookie", async () => {
    const req = new Request("https://my-agent.fly.dev/console/login?next=%2Fconsole%2Fchat", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-bearer" }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/chat");
    expect(cookie).toContain("auggy_console=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/console");
    expect(cookie).toContain("Secure");
  });

  it("POST /console/login rejects an oversized body before form parsing", async () => {
    const req = new Request("https://my-agent.fly.dev/console/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${"x".repeat(5000)}`,
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.55" }));
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain("x".repeat(100));
  });

  it("session cookie admits subsequent console requests without Basic auth", async () => {
    const login = new Request("https://my-agent.fly.dev/console/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "test-bearer" }).toString(),
    });
    const loginRes = await handleAdminRoute(login, await makeCtx({ callerIp: "10.0.0.5" }));
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const req = new Request("https://my-agent.fly.dev/console/api/dashboard", {
      headers: { cookie },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(200);
  });

  it("tampered session cookie is rejected", async () => {
    const req = new Request("https://my-agent.fly.dev/console/api/dashboard", {
      headers: { cookie: "auggy_console=bad.payload" },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(401);
  });

  it("GET /console/logout is non-mutating", async () => {
    const req = new Request("https://my-agent.fly.dev/console/logout", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST /console/logout requires authentication and action-bound CSRF", async () => {
    const unauthenticated = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/logout", {
        method: "POST",
        headers: {
          origin: "https://my-agent.fly.dev",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: "missing-auth" }),
      }),
      await makeCtx({ callerIp: "10.0.0.5" }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("set-cookie")).toBeNull();

    const missingCsrf = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/logout", {
        method: "POST",
        headers: {
          authorization: basicHeader("test-bearer"),
          origin: "https://my-agent.fly.dev",
        },
      }),
      await makeCtx({ callerIp: "10.0.0.5" }),
    );
    expect(missingCsrf.status).toBe(400);
    expect(missingCsrf.headers.get("set-cookie")).toBeNull();
  });

  it("POST /console/logout clears the session only with same-origin logout CSRF", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-logout",
    });
    const req = new Request("https://my-agent.fly.dev/console/logout", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        origin: "https://my-agent.fly.dev",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("auggy_console=");
    expect(cookie).toContain("Max-Age=0");
  });

  it("uses the transport-validated HTTPS origin for logout behind TLS termination", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-logout",
    });
    const req = new Request("http://agent.internal/console/logout", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        origin: "https://agent.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf }),
    });
    const res = await handleAdminRoute(
      req,
      await makeCtx({
        callerIp: "203.0.113.8",
        secureRequest: true,
        requestOrigin: "https://agent.example",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("POST /console/login rejects open redirect next values", async () => {
    const req = new Request(
      "https://my-agent.fly.dev/console/login?next=https%3A%2F%2Fevil.example",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "test-bearer" }).toString(),
      },
    );
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.headers.get("location")).toBe("/console");
  });

  it("GET /console from loopback without bearer requires authentication", async () => {
    const req = new Request("http://127.0.0.1:8080/console");
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "127.0.0.1" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/login?next=%2Fconsole");
  });

  it("decorates every console response with an anti-framing policy", async () => {
    const responses = [
      await handleAdminRoute(
        new Request("https://my-agent.fly.dev/console/login"),
        await makeCtx({ callerIp: "10.0.0.5" }),
      ),
      await handleAdminRoute(
        new Request("https://my-agent.fly.dev/console/api/dashboard"),
        await makeCtx({ callerIp: "10.0.0.5" }),
      ),
      await handleAdminRoute(
        new Request("http://127.0.0.1:8080/console", {
          headers: { authorization: basicHeader("test-bearer") },
        }),
        await makeCtx(),
      ),
    ];

    for (const response of responses) {
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  it("GET /console with valid bearer → 503 build-required when no staticDir", async () => {
    // Without a built SPA dist, the transport degrades to a build-required
    // notice. Tests that exercise the served-shell path pass an explicit
    // staticDir via makeCtx({ staticDir }).
    const req = new Request("http://127.0.0.1:8080/console", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Console SPA not built");
  });

  it("GET /console/api/dashboard with valid bearer → 200 + JSON", async () => {
    const req = new Request("http://127.0.0.1:8080/console/api/dashboard", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      card: { provider: { name: string } };
      auggyVersion?: string;
      routes: {
        summary: {
          totalRoutes: number;
          publicRoutes: number;
          privateRoutes: number;
          publicRoutePaths: string[];
        };
        entries: Array<{ method: string; path: string; auth: string; public: boolean }>;
      };
      web: {
        allowAnonymous: { value: boolean | null };
        publicIntegration: { value: boolean | null };
      };
      tools: { totalTools: number; entries: unknown[] };
      blocks: unknown[];
      csrfTokens: unknown[];
    };
    expect(body.card.provider.name).toBe("zip");
    expect(body.auggyVersion).toBe(expectedAuggyVersion);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(Array.isArray(body.csrfTokens)).toBe(true);
    expect(body.routes.summary).toEqual({
      totalRoutes: 0,
      publicRoutes: 0,
      privateRoutes: 0,
      publicRoutePaths: [],
    });
    expect(body.routes.entries).toEqual([]);
    expect(body.web.allowAnonymous.value).toBeNull();
    expect(body.web.publicIntegration.value).toBeNull();
    expect(body.tools).toEqual({ totalTools: 0, entries: [] });
  });

  it("includes detailed runtime signals only behind console authentication", async () => {
    const ctx = await makeCtx();
    ctx.kernel.getOperationalSnapshot = () =>
      ({
        schemaVersion: 1,
        scope: "process",
        readiness: { accepting: true, state: "accepting" },
        scheduler: { activeTurns: 2, queuedTurns: 3 },
        turns: { total: 5 },
        memory: { rssBytes: 123 },
      }) as unknown as RuntimeOperationalSnapshot;

    const denied = await handleAdminRoute(
      new Request("https://my-agent.fly.dev/console/api/dashboard"),
      ctx,
    );
    expect(denied.status).toBe(401);

    const allowed = await handleAdminRoute(
      new Request("http://127.0.0.1:8080/console/api/dashboard", {
        headers: { authorization: basicHeader("test-bearer") },
      }),
      ctx,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store, must-revalidate");
    const body = (await allowed.json()) as { runtime: RuntimeOperationalSnapshot };
    expect(body.runtime).toMatchObject({
      scope: "process",
      readiness: { accepting: true },
      scheduler: { activeTurns: 2, queuedTurns: 3 },
      turns: { total: 5 },
    });
  });

  it("GET /console/api/dashboard includes safe tool inventory metadata", async () => {
    const aug: Augment = {
      name: "catalog",
      type: "catalog",
      category: "capabilities",
      constraints: {
        maxToolCallsPerTurn: 2,
        requiresHumanApproval: ["catalog_reindex"],
        perTrustLevel: {
          public: { neverExpose: ["catalog_reindex"] },
        },
      },
      tools: [
        {
          name: "catalog_reindex",
          description: "Rebuild the catalog index",
          category: "meta",
          input: z.object({ force: z.boolean().optional() }),
          inputJsonSchema: { type: "object" },
          requires: { scope: "catalog:write" },
          execute: async () => "ok",
        },
      ],
    };
    const req = new Request("http://127.0.0.1:8080/console/api/dashboard", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: {
        totalTools: number;
        entries: Array<{
          name: string;
          description: string;
          category: string;
          augmentName: string;
          augmentType: string;
          hasInputSchema: boolean;
          requires?: unknown;
          execute?: unknown;
          input?: unknown;
          constraints: {
            maxToolCallsPerTurn?: number;
            neverExpose: boolean;
            requiresHumanApproval: boolean;
            hiddenFromTrustLevels: string[];
          };
        }>;
      };
    };
    expect(body.tools.totalTools).toBe(1);
    expect(body.tools.entries[0]).toMatchObject({
      name: "catalog_reindex",
      description: "Rebuild the catalog index",
      category: "meta",
      augmentName: "catalog",
      augmentType: "catalog",
      hasInputSchema: true,
      requires: { scope: "catalog:write" },
      constraints: {
        maxToolCallsPerTurn: 2,
        neverExpose: false,
        requiresHumanApproval: true,
        hiddenFromTrustLevels: ["public"],
      },
    });
    expect(body.tools.entries[0]?.execute).toBeUndefined();
    expect(body.tools.entries[0]?.input).toBeUndefined();
  });

  it("GET /console/api/dashboard includes live route manifest entries", async () => {
    const req = new Request("http://127.0.0.1:8080/console/api/dashboard", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(
      req,
      await makeCtx({
        routes: [
          {
            method: "GET",
            path: "/orders/:id",
            auth: "visitor.optional",
            augmentName: "orders",
            rateLimit: { maxPerMinute: 30 },
            handler: async () => new Response(null),
          },
          {
            method: "POST",
            path: "/admin-task",
            auth: "bearer",
            augmentName: "ops",
            handler: async () => new Response(null),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      routes: {
        summary: {
          totalRoutes: number;
          publicRoutes: number;
          privateRoutes: number;
          publicRoutePaths: string[];
        };
        entries: Array<{
          method: string;
          path: string;
          augmentName: string;
          auth: string;
          params: string[];
          public: boolean;
          security: string;
          rateLimit?: { maxPerMinute: number };
        }>;
      };
    };
    expect(body.routes.summary).toEqual({
      totalRoutes: 2,
      publicRoutes: 1,
      privateRoutes: 1,
      publicRoutePaths: ["GET /orders/:id"],
    });
    expect(body.routes.entries[0]).toMatchObject({
      method: "GET",
      path: "/orders/:id",
      augmentName: "orders",
      auth: "visitor.optional",
      params: ["id"],
      public: true,
      security: "public",
      rateLimit: { maxPerMinute: 30 },
    });
    expect(body.routes.entries[1]).toMatchObject({
      method: "POST",
      path: "/admin-task",
      augmentName: "ops",
      auth: "bearer",
      public: false,
      security: "private",
    });
  });

  it("GET /console/api/dashboard includes agent.yaml identity and engine metadata", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "auggy-console-"));
    try {
      writeFileSync(
        join(agentDir, "agent.yaml"),
        [
          "id: agent_123",
          "name: Zip",
          "displayName: Jim",
          "purpose: Help the operator ship.",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
        ].join("\n"),
      );

      const req = new Request("http://127.0.0.1:8080/console/api/dashboard", {
        headers: { authorization: basicHeader("test-bearer") },
      });
      const res = await handleAdminRoute(req, await makeCtx({ agentDir }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agentMeta: {
          id?: string;
          name?: string;
          displayName?: string;
          purpose?: string;
          engine?: { provider?: string; model?: string };
        };
      };
      expect(body.agentMeta).toEqual({
        id: "agent_123",
        name: "Zip",
        displayName: "Jim",
        purpose: "Help the operator ship.",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("GET /console from non-loopback over http → 426", async () => {
    const req = new Request("http://my-agent.fly.dev/console");
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("TLS/1.2");
  });

  it("GET /console from non-loopback over trusted forwarded https → no 426", async () => {
    const req = new Request("http://my-agent.up.railway.app/console", {
      headers: {
        authorization: basicHeader("test-bearer"),
        "x-forwarded-proto": "https",
      },
    });
    const res = await handleAdminRoute(
      req,
      await makeCtx({ callerIp: "10.0.0.5", trustForwardedProto: true }),
    );
    expect(res.status).not.toBe(426);
    expect(res.status).toBe(503);
  });

  it("GET /console does not trust spoofed forwarded https by default", async () => {
    const req = new Request("http://my-agent.example.com/console", {
      headers: {
        authorization: basicHeader("test-bearer"),
        "x-forwarded-proto": "https",
      },
    });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(426);
  });
});

describe("handleAdminRoute — static console", () => {
  it("fails closed for static namespaces while preserving files and SPA deep links", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "auggy-console-static-"));
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    mkdirSync(join(staticDir, "brand"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Console shell</title>");
    writeFileSync(join(staticDir, "assets", "app.js"), "console.log('console');");
    writeFileSync(join(staticDir, "assets", "app.css"), "body { color: black; }");
    writeFileSync(join(staticDir, "assets", "app.woff2"), "font");
    writeFileSync(join(staticDir, "brand", "auggy-wave.png"), Buffer.from([137, 80, 78, 71]));

    try {
      const ctx = await makeCtx({ staticDir });
      const get = (pathname: string) =>
        handleAdminRoute(
          new Request(`http://127.0.0.1:8080${pathname}`, {
            headers: { authorization: basicHeader("test-bearer") },
          }),
          ctx,
        );

      const script = await get("/console/assets/app.js");
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("application/javascript");
      expect(await script.text()).toContain("console.log");

      const stylesheet = await get("/console/assets/app.css");
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get("content-type")).toContain("text/css");
      expect(await stylesheet.text()).toContain("color: black");

      const font = await get("/console/assets/app.woff2");
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(font.headers.get("x-content-type-options")).toBe("nosniff");

      const brand = await get("/console/brand/auggy-wave.png");
      expect(brand.status).toBe(200);
      expect(brand.headers.get("content-type")).toBe("image/png");

      for (const pathname of [
        "/console/assets/missing.js",
        "/console/assets",
        "/console/brand/missing.png",
        "/console/brand/missing",
        "/console/brand",
      ]) {
        const missing = await get(pathname);
        expect(missing.status).toBe(404);
        expect(missing.headers.get("cache-control")).toBe("no-store");
        expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await missing.text()).toBe("");
      }

      for (const pathname of ["/console/chat/saved-thread", "/console/chat/saved.thread"]) {
        const deepLink = await get(pathname);
        expect(deepLink.status).toBe(200);
        expect(deepLink.headers.get("content-type")).toContain("text/html");
        expect(await deepLink.text()).toContain("Console shell");
      }
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("decodes static paths once and rejects unsafe encoded segments", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "auggy-console-encoded-static-"));
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    mkdirSync(join(staticDir, "brand"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Console shell</title>");
    writeFileSync(join(staticDir, "assets", "app.js"), "encoded asset");

    try {
      const ctx = await makeCtx({ staticDir });
      const get = (pathname: string) =>
        handleAdminRoute(
          new Request(`http://127.0.0.1:8080${pathname}`, {
            headers: { authorization: basicHeader("test-bearer") },
          }),
          ctx,
        );

      const encodedAsset = await get("/console/%61ssets/%61pp.js");
      expect(encodedAsset.status).toBe(200);
      expect(await encodedAsset.text()).toBe("encoded asset");

      for (const pathname of [
        "/console/%61ssets/missing.js",
        "/console/%62rand/missing.png",
        "/console/assets/%",
        "/console/assets/%2Fetc",
        "/console/assets/%5Cetc",
        "/console/assets/%00",
        "/console/assets/%2E%2E%2Fsecret.txt",
        "/console/assets//app.js",
      ]) {
        const response = await get(pathname);
        expect(response.status).toBe(404);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await response.text()).not.toContain("Console shell");
      }

      for (const pathname of ["/console/assets-old/missing.js", "/console/branding/missing.png"]) {
        const nearCollision = await get(pathname);
        expect(nearCollision.status).toBe(200);
        expect(await nearCollision.text()).toContain("Console shell");
      }
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("returns a non-HTML 503 for static namespaces when the bundle is unavailable", async () => {
    const response = await handleAdminRoute(
      new Request("http://127.0.0.1:8080/console/%61ssets/app.js", {
        headers: { authorization: basicHeader("test-bearer") },
      }),
      await makeCtx(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("");
  });

  it("rejects lexical traversal before reading outside the static root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "auggy-console-traversal-"));
    const staticDir = join(fixtureRoot, "dist");
    mkdirSync(staticDir);
    writeFileSync(join(fixtureRoot, "secret.txt"), "outside static root");

    try {
      const response = serveStaticFile(staticDir, "../secret.txt");
      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response?.text()).toBe("forbidden");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects static files reached through a symlink outside the static root", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "auggy-console-symlink-"));
    const staticDir = join(fixtureRoot, "dist");
    const outsideDir = join(fixtureRoot, "outside");
    mkdirSync(staticDir);
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.txt"), "outside static root");
    symlinkSync(outsideDir, join(staticDir, "assets"), "dir");

    try {
      const response = serveStaticFile(staticDir, "assets/secret.txt");
      expect(response).not.toBeNull();
      expect(response?.status).toBe(403);
      expect(await response?.text()).toBe("forbidden");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("handleAdminRoute — POST action dispatch", () => {
  it("POST /console/action/<id> without CSRF → 403", async () => {
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "test-action", label: "Do it", confirmRequired: false }],
      }),
      adminActions: {
        "test-action": async () => ({ ok: true, message: "ok" }),
      },
    };
    const req = new Request("http://127.0.0.1:8080/console/action/test-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(403);
  });

  it("POST /console/action/<id> with valid CSRF dispatches handler", async () => {
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "test-action", label: "Do it", confirmRequired: false }],
      }),
      adminActions: {
        "test-action": async () => ({ ok: true, message: "fired" }),
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "test-action",
    });
    const req = new Request("http://127.0.0.1:8080/console/action/test-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/console?msg=");
    expect(res.headers.get("location")).toContain(encodeURIComponent("fired"));
  });

  it("releases a scheduler lane only after a successful durable recovery action", async () => {
    const recovered: string[] = [];
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "recover-action", label: "Recover", confirmRequired: true }],
      }),
      adminActions: {
        "recover-action": async () => ({
          ok: true,
          message: "durably reconciled",
          recoverThreadId: "opaque-thread-id",
        }),
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "recover-action",
    });
    const ctx = await makeCtx({ augments: [aug] });
    ctx.kernel.recoverThread = (threadId) => {
      recovered.push(threadId);
      return true;
    };
    const req = new Request("http://127.0.0.1:8080/console/action/recover-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });

    expect((await handleAdminRoute(req, ctx)).status).toBe(303);
    expect(recovered).toEqual(["opaque-thread-id"]);
  });

  it("does not release a scheduler lane when durable recovery is rejected", async () => {
    const recovered: string[] = [];
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "stale-recovery", label: "Recover", confirmRequired: true }],
      }),
      adminActions: {
        "stale-recovery": async () => ({
          ok: false,
          message: "stale incident",
          recoverThreadId: "must-not-release",
        }),
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "stale-recovery",
    });
    const ctx = await makeCtx({ augments: [aug] });
    ctx.kernel.recoverThread = (threadId) => {
      recovered.push(threadId);
      return true;
    };
    const req = new Request("http://127.0.0.1:8080/console/action/stale-recovery", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });

    expect((await handleAdminRoute(req, ctx)).status).toBe(303);
    expect(recovered).toEqual([]);
  });

  it("POST /console/action/<unknown-id> → 404", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "unknown",
    });
    const req = new Request("http://127.0.0.1:8080/console/action/unknown", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(404);
  });

  it("POST /console/action/<id>/row/<rowKey> dispatches with rowKey", async () => {
    let receivedParams: Record<string, string> = {};
    const aug: Augment = {
      name: "memory",
      adminInfo: async () => ({
        augmentName: "memory",
        title: "Memory",
        sections: [
          {
            kind: "table",
            columns: ["peer"],
            rows: [["vis_abc"]],
            rowActions: [
              { id: "memory-erase", label: "Erase", confirmRequired: true, rowKeyColumn: 0 },
            ],
          },
        ],
      }),
      adminActions: {
        "memory-erase": async (params) => {
          receivedParams = params;
          return { ok: true, message: `erased ${params.rowKey}` };
        },
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    const req = new Request("http://127.0.0.1:8080/console/action/memory-erase/row/vis_abc", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(303);
    expect(receivedParams.rowKey).toBe("vis_abc");
  });

  it("action handler throws → caught, returns ok=false flash", async () => {
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "broken-action", label: "Broken", confirmRequired: false }],
      }),
      adminActions: {
        "broken-action": async () => {
          throw new Error("boom");
        },
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "broken-action",
    });
    const req = new Request("http://127.0.0.1:8080/console/action/broken-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(encodeURIComponent("internal error"));
  });

  it("POST /console/action with JSON accept invokes handler and returns JSON for SPA actions", async () => {
    let receivedParams: Record<string, string> | undefined;
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [
          {
            id: "json-action",
            label: "JSON",
            confirmRequired: false,
            inputs: [{ name: "value", label: "Value", type: "text", required: true }],
          },
        ],
      }),
      adminActions: {
        "json-action": async (params) => {
          receivedParams = params;
          return { ok: true, message: "updated" };
        },
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "json-action",
    });
    const req = new Request("http://127.0.0.1:8080/console/action/json-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf, value: "enabled" }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, message: "updated", csrfExpired: false });
    expect(receivedParams).toEqual({ value: "enabled" });
  });

  it("POST /console/api/chat without CSRF → 400 (cross-site forgery defense)", async () => {
    // The chat endpoint proxies to /agent/run with the server-side bearer.
    // Without CSRF, a third-party page could induce the operator's browser
    // (already authenticated via HTTP Basic) to send a simple-request POST
    // and inject prompts with full creator-level tool side effects. Codex
    // adversarial-review High-1 — regression test guards against re-removal.
    const req = new Request("http://127.0.0.1:8080/console/api/chat", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello", threadId: "abc" }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/csrf/i);
  });

  it("POST /console/api/chat with tampered CSRF → 403", async () => {
    const req = new Request("http://127.0.0.1:8080/console/api/chat", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csrf: "AAAA.9999999999", // syntactically valid but wrong signature
        message: "hello",
        threadId: "abc",
      }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
    expect(res.status).toBe(403);
  });

  it("POST /console/api/chat with another action's CSRF → 403 (binding to actionId)", async () => {
    // A token minted for `cred-set` must not be replayable against
    // `console-chat`. CSRF is bound to (bearer, agentName, actionId).
    const wrongActionCsrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "cred-set",
    });
    const req = new Request("http://127.0.0.1:8080/console/api/chat", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ csrf: wrongActionCsrf, message: "hello", threadId: "abc" }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
    expect(res.status).toBe(403);
  });

  it("POST /console/api/chat creator mode forwards bearer only to /agent/run", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-chat",
    });
    const originalFetch = globalThis.fetch;
    const forwarded: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      forwarded.headers = new Headers(init?.headers);
      return new Response("event: RUN_STARTED\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const req = new Request("http://127.0.0.1:8080/console/api/chat", {
        method: "POST",
        headers: {
          authorization: basicHeader("test-bearer"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          csrf,
          message: "creator check",
          threadId: "abc",
          chatMode: "creator",
        }),
      });
      const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
      expect(res.status).toBe(200);
      expect(forwarded.headers?.get("authorization")).toBe("Bearer test-bearer");
      expect(forwarded.headers?.get("x-visitor-token")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POST /console/api/chat anonymous mode strips bearer and visitor token", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-chat",
    });
    const originalFetch = globalThis.fetch;
    const forwarded: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      forwarded.headers = new Headers(init?.headers);
      return new Response("event: RUN_STARTED\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const req = new Request("http://127.0.0.1:8080/console/api/chat", {
        method: "POST",
        headers: {
          authorization: basicHeader("test-bearer"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          csrf,
          message: "anonymous check",
          threadId: "abc",
          chatMode: "anonymous",
        }),
      });
      const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
      expect(res.status).toBe(200);
      expect(forwarded.headers?.get("authorization")).toBeNull();
      expect(forwarded.headers?.get("x-visitor-token")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POST /console/api/chat visitor mode forwards visitor token only to /agent/run", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-chat",
    });
    const originalFetch = globalThis.fetch;
    const forwarded: { headers?: Headers } = {};
    globalThis.fetch = (async (_input, init) => {
      forwarded.headers = new Headers(init?.headers);
      return new Response("event: RUN_STARTED\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const req = new Request("http://127.0.0.1:8080/console/api/chat", {
        method: "POST",
        headers: {
          authorization: basicHeader("test-bearer"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          csrf,
          message: "am I verified?",
          threadId: "abc",
          chatMode: "visitor",
          visitorToken: "visitor.payload.signature",
        }),
      });
      const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
      expect(res.status).toBe(200);
      expect(forwarded.headers?.get("authorization")).toBeNull();
      expect(forwarded.headers?.get("x-visitor-token")).toBe("visitor.payload.signature");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POST /console/api/chat visitor mode requires a visitor token", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-chat",
    });
    const req = new Request("http://127.0.0.1:8080/console/api/chat", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csrf,
        message: "hello",
        threadId: "abc",
        chatMode: "visitor",
      }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/visitor token/i);
  });

  it("POST /console/api/chat rejects invalid preview mode", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-chat",
    });
    const req = new Request("http://127.0.0.1:8080/console/api/chat", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csrf,
        message: "hello",
        threadId: "abc",
        chatMode: "operator",
      }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/preview mode/i);
  });

  it("POST /console/api/chat rejects visitor tokens that cannot be forwarded as headers", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "console-chat",
    });
    const req = new Request("http://127.0.0.1:8080/console/api/chat", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csrf,
        message: "hello",
        threadId: "abc",
        visitorToken: "visitor\r\nx-bad: yes",
      }),
    });
    const res = await handleAdminRoute(req, await makeCtx({ selfPort: 9999 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/visitor token/i);
  });

  it("S7 — POST with expired CSRF token returns 200 + auto-refresh HTML (not 403)", async () => {
    const aug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "test-action", label: "X", confirmRequired: false }],
      }),
      adminActions: { "test-action": async () => ({ ok: true, message: "ok" }) },
    };
    const expiredTs = Math.floor((Date.now() - 25 * 3600 * 1000) / 1000);
    const expiredCsrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "test-action",
      _timestamp: expiredTs,
    });
    const req = new Request("http://127.0.0.1:8080/console/action/test-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: expiredCsrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Session expired");
    expect(body).toContain('http-equiv="refresh"');
  });
});
