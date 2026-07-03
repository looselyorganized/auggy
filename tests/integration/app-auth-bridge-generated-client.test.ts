import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createExternalAuthAssertion,
  defineAgent,
  defineAugment,
  defineRoute,
  defineTool,
  json,
  webTransport,
} from "@/index";
import { collectAugmentRoutes } from "@/kernel/route-collector";
import { createRouteManifest, summarizeRouteManifest } from "@/kernel/route-manifest";
import { createTypeScriptClient, type ClientRoutesReport } from "@/cli/routes-client";
import { createMockModel } from "@tests/fixtures/mock-model";
import type { AgentHandle, Augment, AuthorizationGrant, RouteAuthContext } from "@/types";

type GeneratedResult = {
  ok: boolean;
  status: number;
  data: unknown;
  visitorToken?: string;
};

type SseEvent = {
  type: string;
  delta?: string;
  content?: string;
  result?: { status?: string; message?: string };
};

interface LoadedClient {
  createAuggyClient(config: {
    baseUrl: string;
    fetch?: typeof fetch;
    authAssertion?: string | (() => string | undefined | Promise<string | undefined>);
    onVisitorToken?: (token: string) => void;
  }): {
    get(path: string, input?: Record<string, unknown>): Promise<GeneratedResult>;
  };
}

interface VerifiedAppSession {
  provider: "supabase" | "clerk";
  subject: string;
  orgId: string;
  roles: readonly string[];
  scopes?: readonly string[];
  grants?: readonly AuthorizationGrant[];
}

const roots: string[] = [];
const APP_AUTH_SECRET = "app-auth-bridge-secret";
const AUDIENCE = "storefront-agent";
const PORT_BASE = 19840;

describe("integration: app auth bridge with generated browser client", () => {
  let agent: AgentHandle | undefined;

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore cleanup errors after failed starts
    }
    agent = undefined;

    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a generated browser client call protected visitor routes with app-minted assertions", async () => {
    let handlerCalls = 0;
    let observedAuth: RouteAuthContext | undefined;
    const orders = defineAugment({
      name: "orders",
      httpRoutes: [
        defineRoute.get("/orders/:id", {
          auth: "visitor.required",
          params: z.object({ id: z.string() }),
          response: z.object({
            orderId: z.string(),
            status: z.literal("ready"),
            authorizedBy: z.string().optional(),
          }),
          requires: {
            action: "orders.read",
            resource: { param: "id" },
          },
          handler: ({ params, auth }) => {
            handlerCalls += 1;
            observedAuth = auth;
            return json({
              orderId: params.id,
              status: "ready",
              authorizedBy:
                auth.mode === "visitor" && auth.state === "recognized"
                  ? auth.externalAuth?.subject
                  : undefined,
            });
          },
        }),
      ],
    });

    const port = PORT_BASE;
    agent = defineAgent(
      {
        name: AUDIENCE,
        purpose: "tests generated clients with delegated app auth",
        model: "mock",
        augments: [orders, appAuthWebTransport(port)],
      },
      createMockModel(),
    );
    await agent.start();

    const client = await loadGeneratedBrowserClient(orders);
    const allowedApi = client.createAuggyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      authAssertion: () => appBackendMintAssertion("supabase-session-orders-allowed"),
    });
    const deniedApi = client.createAuggyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      authAssertion: () => appBackendMintAssertion("supabase-session-wrong-order"),
    });
    const invalidSessionApi = client.createAuggyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      authAssertion: () => appBackendMintAssertion("missing-session"),
    });

    const denied = await deniedApi.get("/orders/:id", {
      params: { id: "order_123" },
    });
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      data: { error: "forbidden", reason: "authorization-grant-missing" },
    });
    expect(handlerCalls).toBe(0);

    const allowed = await allowedApi.get("/orders/:id", {
      params: { id: "order_123" },
    });
    expect(allowed).toMatchObject({
      ok: true,
      status: 200,
      data: { orderId: "order_123", status: "ready", authorizedBy: "user_123" },
    });
    expect(handlerCalls).toBe(1);
    expect(observedAuth).toMatchObject({
      mode: "visitor",
      state: "recognized",
      externalAuth: {
        provider: "supabase",
        subject: "user_123",
        orgId: "org_abc",
      },
    });

    await expect(
      invalidSessionApi.get("/orders/:id", { params: { id: "order_123" } }),
    ).rejects.toThrow("This Auggy route requires a visitorToken or authAssertion.");
  });

  it("carries the same app-auth assertion through /agent/run for protected tools", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { orderId: "order_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Refund started.", finishReason: "end_turn" });

    let executeCalls = 0;
    let observedAuth: RouteAuthContext | undefined;
    const orders = defineAugment({
      name: "orders",
      tools: [
        defineTool({
          name: "refund_order",
          description: "Refund an order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: {
            action: "refund.issue",
            resource: { input: "orderId" },
          },
          execute: async ({ orderId }, context) => {
            executeCalls += 1;
            observedAuth = context?.auth;
            const subject =
              context?.auth?.mode === "visitor" && context.auth.state === "recognized"
                ? context.auth.externalAuth?.subject
                : undefined;
            return `refund-authorized:${orderId}:${subject ?? "unknown"}`;
          },
        }),
      ],
    });

    const port = PORT_BASE + 1;
    agent = defineAgent(
      {
        name: AUDIENCE,
        purpose: "tests generated clients with delegated app auth",
        model: "mock",
        augments: [orders, appAuthWebTransport(port)],
      },
      model,
    );
    await agent.start();

    const assertion = appBackendMintAssertion("clerk-session-refund-allowed");
    expect(assertion).toBeString();
    const events = await runAgent(port, assertion!);

    expect(executeCalls).toBe(1);
    expect(observedAuth).toMatchObject({
      mode: "visitor",
      state: "recognized",
      externalAuth: {
        provider: "clerk",
        subject: "user_123",
        orgId: "org_abc",
      },
    });
    expect(events.find((event) => event.type === "TOOL_CALL_RESULT")?.content).toBe(
      "refund-authorized:order_123:user_123",
    );
    expect(textContent(events)).toContain("Refund started.");
    expect(events.find((event) => event.type === "RUN_FINISHED")?.result?.status).toBe("completed");
  });

  it("denies protected tools before execution when the app session lacks the input-bound grant", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { orderId: "order_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "I cannot refund that order.", finishReason: "end_turn" });

    let executeCalls = 0;
    const orders = defineAugment({
      name: "orders",
      tools: [
        defineTool({
          name: "refund_order",
          description: "Refund an order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: { action: "refund.issue", resource: { input: "orderId" } },
          execute: async () => {
            executeCalls += 1;
            return "should-not-run";
          },
        }),
      ],
    });

    const port = PORT_BASE + 2;
    agent = defineAgent(
      {
        name: AUDIENCE,
        purpose: "tests generated clients with delegated app auth",
        model: "mock",
        augments: [orders, appAuthWebTransport(port)],
      },
      model,
    );
    await agent.start();

    const assertion = appBackendMintAssertion("clerk-session-refund-denied");
    expect(assertion).toBeString();
    const events = await runAgent(port, assertion!);

    expect(executeCalls).toBe(0);
    expect(textContent(events)).toContain("I cannot refund that order.");
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.map((message) => message.content).join("\n")).toContain(
      'Tool "refund_order" authorization denied: authorization-grant-missing',
    );
  });
});

function appAuthWebTransport(port: number) {
  return webTransport({
    port,
    allowAnonymous: true,
    auth: { type: "bearer", token: "creator-token" },
    externalAuth: {
      secret: APP_AUTH_SECRET,
      audience: AUDIENCE,
      allowedProviders: ["supabase", "clerk"],
      maxTtlSeconds: 60,
    },
  });
}

function appBackendMintAssertion(appSessionToken: string): string | undefined {
  const session = verifyAppSession(appSessionToken);
  if (!session) return undefined;

  return createExternalAuthAssertion({
    secret: APP_AUTH_SECRET,
    audience: AUDIENCE,
    provider: session.provider,
    subject: session.subject,
    ttlSeconds: 60,
    orgId: session.orgId,
    roles: session.roles,
    scopes: session.scopes,
    grants: session.grants,
    authzVersion: "test-app-authz-v1",
  });
}

function verifyAppSession(appSessionToken: string): VerifiedAppSession | null {
  if (appSessionToken === "supabase-session-orders-allowed") {
    return {
      provider: "supabase",
      subject: "user_123",
      orgId: "org_abc",
      roles: ["customer"],
      grants: [{ action: "orders.read", resource: "order_123" }],
    };
  }
  if (appSessionToken === "supabase-session-wrong-order") {
    return {
      provider: "supabase",
      subject: "user_123",
      orgId: "org_abc",
      roles: ["customer"],
      grants: [{ action: "orders.read", resource: "order_999" }],
    };
  }
  if (appSessionToken === "clerk-session-refund-allowed") {
    return {
      provider: "clerk",
      subject: "user_123",
      orgId: "org_abc",
      roles: ["support"],
      grants: [{ action: "refund.issue", resource: "order_123" }],
    };
  }
  if (appSessionToken === "clerk-session-refund-denied") {
    return {
      provider: "clerk",
      subject: "user_123",
      orgId: "org_abc",
      roles: ["support"],
      grants: [{ action: "refund.issue", resource: "order_999" }],
    };
  }
  return null;
}

async function loadGeneratedBrowserClient(routesAugment: Augment): Promise<LoadedClient> {
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
  expect(source).toContain('headers.set("x-auggy-auth-assertion", credentials.authAssertion);');
  expect(source).toContain('"GET /orders/:id"');
  expect(source).toContain('auth: "visitor.required"');
  expect(source).toContain("requires:");

  const root = mkdtempSync(join(tmpdir(), "app-auth-bridge-client-"));
  roots.push(root);
  const file = join(root, "client.mjs");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  writeFileSync(file, js);
  return (await import(pathToFileURL(file).href)) as LoadedClient;
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
      messages: [{ role: "user", content: "refund order_123" }],
    }),
  });

  expect(resp.status).toBe(200);
  expect(resp.headers.get("content-type")).toContain("text/event-stream");

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
