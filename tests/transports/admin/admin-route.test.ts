import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceInputs } from "@/transports/admin/admin-coerce";
import {
  type AdminActionRegistry,
  type AdminRouteContext,
  buildAdminActionRegistry,
  handleAdminRoute,
} from "@/transports/admin/index";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import type { AdminActionInput, AgentCard, Augment, TransportKernel, TurnResult } from "@/types";

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
  overrides: Partial<AdminRouteContext> & { augments?: Augment[] } = {},
): Promise<AdminRouteContext> {
  const { augments = [], ...rest } = overrides;
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
    getAgentCard: () => card,
    getAugmentRoutes: () => [],
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
    expect(body).not.toContain("AUGGY_WEB_TOKEN");
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

  it("POST /console/logout clears the session cookie", async () => {
    const req = new Request("https://my-agent.fly.dev/console/logout", { method: "POST" });
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/console/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("auggy_console=");
    expect(cookie).toContain("Max-Age=0");
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

  it("GET /console from loopback without bearer → bypass (no 401)", async () => {
    // Loopback bypass: anyone with shell access to the host already has
    // filesystem read on .env → already has the bearer, so the bearer-on-
    // loopback check added friction without protection. The 503 build-required
    // is the next gate (no staticDir in this test setup).
    const req = new Request("http://127.0.0.1:8080/console");
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "127.0.0.1" }));
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(503);
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
      blocks: unknown[];
      csrfTokens: unknown[];
    };
    expect(body.card.provider.name).toBe("zip");
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(Array.isArray(body.csrfTokens)).toBe(true);
  });

  it("GET /console/api/dashboard includes agent.yaml identity and engine metadata", async () => {
    const agentDir = join(tmpdir(), `auggy-console-${crypto.randomUUID()}`);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agent.yaml"),
      [
        "id: agent_123",
        "name: Zip",
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
        purpose?: string;
        engine?: { provider?: string; model?: string };
      };
    };
    expect(body.agentMeta).toEqual({
      id: "agent_123",
      name: "Zip",
      purpose: "Help the operator ship.",
      engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
  });

  it("GET /admin from non-loopback over http → 426", async () => {
    const req = new Request("http://my-agent.fly.dev/admin");
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
