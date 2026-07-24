import { describe, expect, it } from "bun:test";
import {
  classifyIntegrationPath,
  isBrowserCallableAppRoute,
  isServerCallableAppRoute,
  selectBrowserConnection,
  selectServerConnection,
} from "./integration-guidance";
import type { RouteAuthMode, WebDashboardState } from "./types";

const SECRET_SENTINEL = "never-ship-this-secret";

function posture(patch: Partial<WebDashboardState> = {}): WebDashboardState {
  return {
    allowAnonymous: { value: false },
    publicIntegration: { value: false },
    trustedProxies: [],
    corsOrigins: [],
    visitorTokensEnabled: false,
    externalAuthEnabled: false,
    ...patch,
  };
}

function assertBrowserSafe(example: string | null): void {
  if (example === null) return;
  expect(example).not.toMatch(/authorization\s*:/i);
  expect(example).not.toMatch(/bearer/i);
  expect(example).not.toMatch(/creator.?token/i);
  expect(example).not.toContain(SECRET_SENTINEL);
}

describe("browser integration guidance", () => {
  it("prefers externally asserted application identity without exposing server credentials", () => {
    const guidance = selectBrowserConnection("https://agent.example/", posture({
      allowAnonymous: { value: true },
      visitorTokensEnabled: true,
      externalAuthEnabled: true,
      externalAuthHeader: "X-My-App-Identity",
      agentAccessEntries: SECRET_SENTINEL,
    }));

    expect(guidance).toMatchObject({
      mode: "external-auth",
      ready: true,
      endpoint: "https://agent.example/agent/run",
      protocol: "AG-UI over SSE",
    });
    expect(guidance.typescript).toContain('"x-my-app-identity": assertion');
    expect(guidance.typescript).toContain("getAuggyAuthAssertion()");
    assertBrowserSafe(guidance.typescript);
  });

  it("uses the default assertion header when no override is configured", () => {
    const guidance = selectBrowserConnection("", posture({
      externalAuthEnabled: true,
    }));

    expect(guidance.endpoint).toBe("/agent/run");
    expect(guidance.typescript).toContain('"x-auggy-auth-assertion": assertion');
    assertBrowserSafe(guidance.typescript);
  });

  it("fails closed for invalid or credential-conflicting assertion headers", () => {
    for (const externalAuthHeader of [
      'unsafe\nheader: "value"',
      "authorization",
      "idempotency-key",
      "cookie",
      "x-forwarded-for",
    ]) {
      const guidance = selectBrowserConnection(
        "https://agent.example",
        posture({ externalAuthEnabled: true, externalAuthHeader }),
      );
      expect(guidance).toMatchObject({
        mode: "configuration-required",
        ready: false,
        typescript: null,
      });
      expect(guidance.summary).toContain("conflicts with another Auggy credential");
    }
  });

  it("uses anonymous-session bootstrap without minting visitor authority", () => {
    const guidance = selectBrowserConnection("http://localhost:8080", posture({
      allowAnonymous: { value: true },
      visitorTokensEnabled: true,
    }));

    expect(guidance.mode).toBe("visitor-token");
    expect(guidance.typescript).toContain('localStorage.getItem("auggy:visitor-token")');
    expect(guidance.typescript).toContain(
      'if (visitorToken) headers["x-visitor-token"] = visitorToken',
    );
    expect(guidance.typescript).not.toContain('?? "bootstrap"');
    expect(guidance.typescript).not.toContain('response.headers.get("x-visitor-token")');
    expect(guidance.typescript).toContain(
      'response.headers.get("x-auggy-anonymous-session")',
    );
    expect(guidance.typescript).toContain(
      'response.headers.get("x-auggy-anonymous-session-status") === "invalid"',
    );
    expect(guidance.typescript).toContain(
      'localStorage.removeItem("auggy:anonymous-session")',
    );
    expect(guidance.typescript).toContain("response.status === 428");
    assertBrowserSafe(guidance.typescript);
  });

  it("never claims that visitor tokens bypass a disabled anonymous gate", () => {
    const guidance = selectBrowserConnection("http://localhost:8080", posture({
      allowAnonymous: { value: false },
      visitorTokensEnabled: true,
    }));

    expect(guidance).toMatchObject({ mode: "configuration-required", ready: false });
    expect(guidance.summary).toContain("cannot open /agent/run");
    expect(guidance.typescript).toBeNull();
  });

  it("supports intentionally anonymous conversations without inventing identity", () => {
    const guidance = selectBrowserConnection("http://localhost:8080/", posture({
      allowAnonymous: { value: true },
    }));

    expect(guidance).toMatchObject({ mode: "anonymous", ready: true });
    expect(guidance.typescript).not.toContain("x-visitor-token");
    expect(guidance.summary).toContain("not retain a verified identity");
    assertBrowserSafe(guidance.typescript);
  });

  it("fails closed when no browser-safe posture is configured", () => {
    const guidance = selectBrowserConnection("http://localhost:8080", posture({
      agentAccessEntries: SECRET_SENTINEL,
    }));

    expect(guidance).toMatchObject({
      mode: "configuration-required",
      ready: false,
      typescript: null,
    });
    expect(JSON.stringify(guidance)).not.toContain(SECRET_SENTINEL);
  });

  it("parses named SSE frames and JSON data instead of logging arbitrary chunks", () => {
    for (const web of [
      posture({ allowAnonymous: { value: true } }),
      posture({ allowAnonymous: { value: true }, visitorTokensEnabled: true }),
      posture({ externalAuthEnabled: true }),
    ]) {
      const example = selectBrowserConnection("http://localhost:8080", web).typescript ?? "";
      expect(example).toContain("readAgentEvents(response)");
      expect(example).toContain('contentType.includes("text/event-stream")');
      expect(example).toContain('line.startsWith("data:")');
      expect(example).toContain("JSON.parse(data)");
      expect(example).toContain('payload.type === "RUN_ERROR"');
      expect(example).toContain('payload.type === "RUN_FINISHED"');
      expect(example).toContain('headers["idempotency-key"] = idempotencyKey');
      expect(example).toContain("signal,");
      expect(example).toContain("reader.cancel()");
      expect(example).not.toContain("console.log(chunk)");
      assertBrowserSafe(example);
    }
  });

  it("keeps external assertions isolated from visitor bootstrap state", () => {
    const example = selectBrowserConnection(
      "http://localhost:8080",
      posture({ externalAuthEnabled: true, visitorTokensEnabled: true }),
    ).typescript;

    expect(example).not.toContain("x-visitor-token");
    expect(example).not.toContain("bootstrap");
    assertBrowserSafe(example);
  });
});

describe("server integration guidance", () => {
  it("uses only a server environment variable for the creator credential", () => {
    const guidance = selectServerConnection("https://agent.example/");

    expect(guidance).toMatchObject({
      environmentVariable: "AUGGY_WEB_TOKEN",
      endpoint: "https://agent.example/agent/run",
    });
    expect(guidance.typescript).toContain("process.env.AUGGY_WEB_TOKEN");
    expect(guidance.typescript).toContain("Bearer ${token}");
    expect(guidance.typescript).toContain('"idempotency-key": idempotencyKey');
    expect(guidance.typescript).toContain("signal,");
    expect(guidance.typescript).not.toContain("<token>");
    expect(guidance.typescript).not.toContain(SECRET_SENTINEL);
    expect(guidance.curl).toContain('"Authorization: Bearer $AUGGY_WEB_TOKEN"');
    expect(guidance.curl).toContain("AUGGY_WEB_TOKEN:?");
    expect(guidance.curl).toContain("Idempotency-Key: support-turn-123");
    expect(guidance.curl).not.toContain("<token>");
    expect(guidance.curl).not.toContain(SECRET_SENTINEL);
  });

  it("parses SSE in the server example too", () => {
    const { typescript } = selectServerConnection("");
    expect(typescript).toContain("readAgentEvents(response)");
    expect(typescript).toContain('contentType.includes("text/event-stream")');
    expect(typescript).toContain("JSON.parse(data)");
    expect(typescript).toContain('payload.type === "RUN_ERROR"');
    expect(typescript).toContain('payload.type === "RUN_FINISHED"');
    expect(typescript).not.toContain("console.log(chunk)");
  });
});

describe("integration surface and route policy", () => {
  it("keeps conversation, health, and generated app-route clients distinct", () => {
    expect(classifyIntegrationPath("/agent/run")).toBe("agent-conversation");
    expect(classifyIntegrationPath("/health")).toBe("runtime-health");
    expect(classifyIntegrationPath("/orders/:id")).toBe("app-route");
  });

  it("restricts browser routes to public and visitor-oriented policies", () => {
    const browser = posture({ visitorTokensEnabled: true });
    const canCall = (auth: RouteAuthMode) =>
      isBrowserCallableAppRoute({ path: "/orders/:id", auth }, browser);

    expect(canCall("none")).toBeTrue();
    expect(canCall("visitor.optional")).toBeTrue();
    expect(canCall("visitor.required")).toBeTrue();
    expect(canCall("bearer")).toBeFalse();
    expect(canCall("creator")).toBeFalse();
    expect(canCall("agent.required")).toBeFalse();
    expect(isBrowserCallableAppRoute({ path: "/agent/run", auth: "none" }, browser)).toBeFalse();
    expect(
      isBrowserCallableAppRoute(
        { path: "/webhooks/stripe", auth: "none", policy: { kind: "webhook.signature" } },
        browser,
      ),
    ).toBeFalse();
  });

  it("does not claim visitor-required routes are callable without an identity mechanism", () => {
    expect(
      isBrowserCallableAppRoute(
        { path: "/orders/:id", auth: "visitor.required" },
        posture(),
      ),
    ).toBeFalse();
  });

  it("restricts the generic trusted-server client to public and creator policies", () => {
    expect(isServerCallableAppRoute({ path: "/orders/:id", auth: "none" })).toBeTrue();
    expect(isServerCallableAppRoute({ path: "/orders/:id", auth: "bearer" })).toBeTrue();
    expect(isServerCallableAppRoute({ path: "/orders/:id", auth: "creator" })).toBeTrue();
    expect(isServerCallableAppRoute({ path: "/orders/:id", auth: "visitor.required" })).toBeFalse();
    expect(isServerCallableAppRoute({ path: "/orders/:id", auth: "agent.required" })).toBeFalse();
    expect(
      isServerCallableAppRoute({
        path: "/webhooks/stripe",
        auth: "none",
        policy: { kind: "webhook.signature" },
      }),
    ).toBeFalse();
  });
});
