import { describe, expect, it } from "bun:test";
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
  it("GET /admin without bearer → 401", async () => {
    const req = new Request("http://127.0.0.1:8080/admin");
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="auggy-admin zip"');
  });

  it("GET /admin with valid bearer → 503 build-required when no staticDir", async () => {
    // Without a built SPA dist, the transport degrades to a build-required
    // notice. Tests that exercise the served-shell path pass an explicit
    // staticDir via makeCtx({ staticDir }).
    const req = new Request("http://127.0.0.1:8080/admin", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Admin SPA not built");
  });

  it("GET /admin/api/dashboard with valid bearer → 200 + JSON", async () => {
    const req = new Request("http://127.0.0.1:8080/admin/api/dashboard", {
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

  it("GET /admin from non-loopback over http → 426", async () => {
    const req = new Request("http://my-agent.fly.dev/admin");
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("TLS/1.2");
  });
});

describe("handleAdminRoute — POST action dispatch", () => {
  it("POST /admin/action/<id> without CSRF → 403", async () => {
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
    const req = new Request("http://127.0.0.1:8080/admin/action/test-action", {
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

  it("POST /admin/action/<id> with valid CSRF dispatches handler", async () => {
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
    const req = new Request("http://127.0.0.1:8080/admin/action/test-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/admin?msg=");
    expect(res.headers.get("location")).toContain(encodeURIComponent("fired"));
  });

  it("POST /admin/action/<unknown-id> → 404", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "unknown",
    });
    const req = new Request("http://127.0.0.1:8080/admin/action/unknown", {
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

  it("POST /admin/action/<id>/row/<rowKey> dispatches with rowKey", async () => {
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
    const req = new Request("http://127.0.0.1:8080/admin/action/memory-erase/row/vis_abc", {
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
    const req = new Request("http://127.0.0.1:8080/admin/action/broken-action", {
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
    const req = new Request("http://127.0.0.1:8080/admin/action/test-action", {
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
