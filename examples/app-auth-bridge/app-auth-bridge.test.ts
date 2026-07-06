import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineAgent, webTransport } from "auggy";
import { createRouteManifest, summarizeRouteManifest } from "@/kernel/route-manifest";
import { collectAugmentRoutes } from "@/kernel/route-collector";
import { createTypeScriptClient, type ClientRoutesReport } from "@/cli/routes-client";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createStorefrontAuggyClient } from "./browser-client";
import { ordersAugment } from "./orders-augment";
import {
  createClerkAuggyAssertionHandler,
  createSupabaseAuggyAssertionHandler,
  type ClerkAuthAdapter,
  type SupabaseAuthAdapter,
} from "./provider-routes";
import type { AgentHandle, Augment } from "auggy";

interface GeneratedClientModule {
  createAuggyClient(config: {
    baseUrl: string | URL;
    fetch?: typeof fetch;
    authAssertion?: string | (() => string | undefined | Promise<string | undefined>);
  }): {
    get(path: string, input?: Record<string, unknown>): Promise<GeneratedClientResult>;
    post(path: string, input?: Record<string, unknown>): Promise<GeneratedClientResult>;
  };
}

interface GeneratedClientResult {
  ok: boolean;
  status: number;
  data: unknown;
}

interface SseEvent {
  type: string;
  delta?: string;
  content?: string;
  result?: { status?: string };
}

const APP_AUTH_SECRET = "example-app-auth-secret";
const APP_AUTH_KEY_ID = "2026-07";
const AUDIENCE = "storefront-agent";
const roots: string[] = [];
let agent: AgentHandle | undefined;

afterEach(async () => {
  try {
    await agent?.stop();
  } finally {
    agent = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

describe("app auth bridge example", () => {
  test("generated browser client calls protected routes with Supabase-style assertions", async () => {
    const orders = ordersAugment();
    const port = freePort();

    agent = defineAgent(
      {
        name: AUDIENCE,
        model: "mock",
        purpose: "app auth bridge example",
        augments: [orders, appAuthWebTransport(port)],
      },
      createMockModel(),
    );
    await agent.start();

    const generated = await loadGeneratedBrowserClient(orders);
    const allowedHandler = createSupabaseAuggyAssertionHandler(fakeSupabase(), {
      assertion: assertionOptions(),
    });
    const allowedApi = createStorefrontAuggyClient(generated, {
      baseUrl: `http://127.0.0.1:${port}`,
      fetch: appBackendFetch(allowedHandler),
      appAccessToken: () => "supabase-access-user-123",
    });

    const allowed = await allowedApi.get("/orders");
    expect(allowed).toMatchObject({
      ok: true,
      status: 200,
      data: {
        orders: [{ id: "order_123", status: "ready" }],
      },
    });

    const deniedApi = createStorefrontAuggyClient(generated, {
      baseUrl: `http://127.0.0.1:${port}`,
      fetch: appBackendFetch(allowedHandler),
      appAccessToken: () => "supabase-access-no-orders",
    });

    const denied = await deniedApi.get("/orders");
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      data: { error: "forbidden", reason: "authorization-scope-missing" },
    });
  });

  test("agent run executes protected tools with Clerk-style assertions", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        {
          name: "refund_order",
          arguments: { orderId: "order_123", reason: "customer request" },
        },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Refund started.", finishReason: "end_turn" });

    const port = freePort();
    agent = defineAgent(
      {
        name: AUDIENCE,
        model: "mock",
        purpose: "app auth bridge example",
        augments: [ordersAugment(), appAuthWebTransport(port)],
      },
      model,
    );
    await agent.start();

    const clerkHandler = createClerkAuggyAssertionHandler(fakeClerk(), {
      assertion: assertionOptions(),
    });
    const assertion = await assertionFromResponse(await clerkHandler());
    const events = await runAgent(port, assertion);

    expect(events.find((event) => event.type === "TOOL_CALL_RESULT")?.content).toBe(
      "refund-started:order_123",
    );
    expect(textContent(events)).toContain("Refund started.");
    expect(events.find((event) => event.type === "RUN_FINISHED")?.result?.status).toBe(
      "completed",
    );
  });
});

function appAuthWebTransport(port: number) {
  return webTransport({
    port,
    allowAnonymous: false,
    auth: { type: "bearer", token: "creator-token" },
    externalAuth: {
      secret: APP_AUTH_SECRET,
      keyId: APP_AUTH_KEY_ID,
      audience: AUDIENCE,
      allowedProviders: ["supabase", "clerk"],
      maxTtlSeconds: 60,
      replayProtection: { enabled: true },
    },
  });
}

function assertionOptions() {
  return {
    secret: APP_AUTH_SECRET,
    keyId: APP_AUTH_KEY_ID,
    audience: AUDIENCE,
    ttlSeconds: 60,
    authzVersion: "orders-v1",
  };
}

function fakeSupabase(): SupabaseAuthAdapter {
  return {
    auth: {
      async getUser(accessToken) {
        if (accessToken === "supabase-access-user-123") {
          return {
            data: {
              user: {
                id: "user_123",
                email: "ada@example.com",
                email_confirmed_at: "2026-07-06T00:00:00.000Z",
                app_metadata: { org_id: "org_abc", roles: ["customer"] },
              },
            },
          };
        }
        if (accessToken === "supabase-access-no-orders") {
          return {
            data: {
              user: {
                id: "user_without_orders",
                email: "viewer@example.com",
                email_confirmed_at: "2026-07-06T00:00:00.000Z",
                app_metadata: { org_id: "org_abc", roles: ["viewer"] },
              },
            },
          };
        }
        return { data: { user: null }, error: new Error("invalid token") };
      },
    },
  };
}

function fakeClerk(): ClerkAuthAdapter {
  return {
    auth: () => ({
      isAuthenticated: true,
      userId: "support_123",
      orgId: "org_abc",
      orgRole: "support",
    }),
    currentUser: () => ({
      primaryEmailAddress: {
        emailAddress: "support@example.com",
        verification: { status: "verified" },
      },
    }),
  };
}

function appBackendFetch(handler: (req: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/auggy-auth-assertion" || url.endsWith("/api/auggy-auth-assertion")) {
      return handler(new Request("http://app.local/api/auggy-auth-assertion", init));
    }
    return fetch(input, init);
  };
}

async function assertionFromResponse(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { assertion?: unknown };
  expect(body.assertion).toBeString();
  return body.assertion;
}

async function loadGeneratedBrowserClient(routesAugment: Augment): Promise<GeneratedClientModule> {
  const collected = collectAugmentRoutes([routesAugment]);
  expect(collected.errors).toEqual([]);

  const manifest = createRouteManifest(collected.routes);
  const report: ClientRoutesReport = {
    agent: { name: AUDIENCE, configPath: "/tmp/storefront-agent/agent.yaml" },
    summary: summarizeRouteManifest(manifest),
    routes: manifest,
  };
  const source = createTypeScriptClient(report, { target: "browser" });
  expect(source).toContain("authAssertion?: TokenProvider;");
  expect(source).toContain('"GET /orders"');
  expect(source).toContain('"POST /orders/:id/refund"');

  const root = mkdtempSync(join(tmpdir(), "app-auth-bridge-example-client-"));
  roots.push(root);
  const file = join(root, "client.mjs");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  writeFileSync(file, js);
  return (await import(pathToFileURL(file).href)) as GeneratedClientModule;
}

async function runAgent(port: number, assertion: string): Promise<SseEvent[]> {
  const resp = await fetch(`http://127.0.0.1:${port}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-auggy-auth-assertion": assertion,
    },
    body: JSON.stringify({
      threadId: `thread-${crypto.randomUUID()}`,
      messages: [{ role: "user", content: "Refund order_123" }],
    }),
  });

  expect(resp.status).toBe(200);
  const body = await resp.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as SseEvent);
}

function textContent(events: readonly SseEvent[]): string {
  return events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta ?? "")
    .join("");
}

function freePort(): number {
  return 30_000 + Math.floor(Math.random() * 9999);
}
