import { describe, expect, it } from "bun:test";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import {
  buildAdminActionRegistry,
  handleAdminRoute,
  type AdminRouteContext,
} from "@/transports/admin";
import type { AgentCard, TransportKernel, TurnResult } from "@/types";

const bearer = "visitor-identity-test-bearer";
const agentName = "visitor-identity-test";

function basicHeader(): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
}

async function context(
  resolveConsoleVisitorIdentity?: AdminRouteContext["resolveConsoleVisitorIdentity"],
): Promise<AdminRouteContext> {
  const card: AgentCard = {
    provider: { name: agentName },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      memory: false,
      transport: true,
    },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
  const kernel: TransportKernel = {
    handleInbound: async () => ({}) as TurnResult,
    onOutbound: () => {},
    quarantineThread: () => true,
    recoverThread: () => false,
    getAgentCard: () => card,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
  return {
    kernel,
    bearer,
    agentDir: undefined,
    callerIp: "127.0.0.1",
    actionRegistry: await buildAdminActionRegistry([]),
    ...(resolveConsoleVisitorIdentity ? { resolveConsoleVisitorIdentity } : {}),
  };
}

async function csrf(): Promise<string> {
  return generateCsrfToken({ bearer, agentName, actionId: "console-chat" });
}

function request(body: unknown, method = "POST"): Request {
  return new Request("http://127.0.0.1:8080/console/api/visitor-identity", {
    method,
    headers: {
      authorization: basicHeader(),
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

describe("console visitor identity summary route", () => {
  it("returns only the verified email and credential expiry", async () => {
    const visitorToken = "private-browser-token";
    const response = await handleAdminRoute(
      request({ csrf: await csrf(), visitorToken }),
      await context(async (token) => {
        expect(token).toBe(visitorToken);
        return {
          status: "verified",
          email: "alice@example.com",
          expiresAt: 1_785_542_400_000,
        };
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text).not.toContain(visitorToken);
    expect(text).not.toContain("visitorId");
    expect(JSON.parse(text)).toEqual({
      identity: {
        status: "verified",
        email: "alice@example.com",
        expiresAt: 1_785_542_400_000,
      },
    });
  });

  it("fails closed with one stable response for invalid, expired, or revoked credentials", async () => {
    const response = await handleAdminRoute(
      request({ csrf: await csrf(), visitorToken: "rejected-token" }),
      await context(async () => null),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Visitor credential is invalid, expired, or revoked.",
      code: "visitor_credential_rejected",
    });
  });

  it("distinguishes unavailable resolution without leaking resolver errors", async () => {
    const unavailable = await handleAdminRoute(
      request({ csrf: await csrf(), visitorToken: "token" }),
      await context(),
    );
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as { code: string }).code).toBe(
      "visitor_identity_unavailable",
    );

    const failed = await handleAdminRoute(
      request({ csrf: await csrf(), visitorToken: "token" }),
      await context(async () => {
        throw new Error("database path and secret internals");
      }),
    );
    expect(failed.status).toBe(503);
    const text = await failed.text();
    expect(text).toContain("visitor_identity_unavailable");
    expect(text).not.toContain("database path");
    expect(text).not.toContain("secret internals");
  });

  it("requires console-chat CSRF and a strict bounded request body", async () => {
    const ctx = await context(async () => null);
    const missingCsrf = await handleAdminRoute(request({ visitorToken: "token" }), ctx);
    expect(missingCsrf.status).toBe(400);

    const wrongCsrf = await generateCsrfToken({ bearer, agentName, actionId: "identity-save" });
    const rejectedCsrf = await handleAdminRoute(
      request({ csrf: wrongCsrf, visitorToken: "token" }),
      ctx,
    );
    expect(rejectedCsrf.status).toBe(403);

    const extraField = await handleAdminRoute(
      request({ csrf: await csrf(), visitorToken: "token", visitorId: "vis_claimed" }),
      ctx,
    );
    expect(extraField.status).toBe(400);
    expect(((await extraField.json()) as { code: string }).code).toBe("invalid_request");

    const wrongMethod = await handleAdminRoute(request(undefined, "GET"), ctx);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });
});
