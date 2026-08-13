import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineAgent } from "@/agent";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import { webTransport } from "@/transports/web-transport";
import { createMockModel } from "@tests/fixtures/mock-model";
import type { ModelClient, ToolExecuteContext } from "@/types";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "auggy-g36-p3-1-"));
}

function basicHeader(bearer: string): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

interface AdminBlock {
  augmentName?: string;
  title?: string;
  sections: Array<
    | {
        kind: "keyValue";
        rows: Array<{ label: string; value: string }>;
      }
    | { kind: "table"; columns: string[]; rows: string[][] }
    | { kind: "status"; level: string; message: string }
    | { kind: "eventStream"; events: Array<{ timestamp: string; type: string; summary: string }> }
  >;
  actions?: Array<{ id: string }>;
}
interface DashboardJson {
  card: { provider: { name: string } };
  web: {
    allowAnonymous: { value: boolean | null; source?: string };
    publicIntegration: { value: boolean | null; source?: string };
    publicFrontendUrl?: string;
    corsOrigins: string[];
    visitorTokensEnabled: boolean | null;
    externalAuthEnabled: boolean | null;
    externalAuthHeader?: string;
    agentAccessEntries?: string;
  };
  routes: {
    summary: { totalRoutes: number; publicRoutes: number; privateRoutes: number };
    entries: unknown[];
  };
  blocks: AdminBlock[];
  csrfTokens: { actionId: string; rowKey?: string; token: string }[];
}

async function fetchDashboard(port: number, bearer: string): Promise<DashboardJson> {
  const resp = await fetch(`http://127.0.0.1:${port}/console/api/dashboard`, {
    headers: { authorization: basicHeader(bearer) },
  });
  expect(resp.status).toBe(200);
  return (await resp.json()) as DashboardJson;
}

describe("webTransport adminInfo — posture row (G36 phase 3)", () => {
  it("GET /console/api/dashboard includes the webTransport posture block", async () => {
    const model = createMockModel();
    const port = await freePort();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const data = await fetchDashboard(port, "test-token");
      // Posture block is contributed by webTransport itself.
      const postureBlock = data.blocks.find((b) => b.title?.includes("Posture"));
      expect(postureBlock).toBeDefined();
      // Block carries a keyValue row labeled allowAnonymous.
      const labels = postureBlock!.sections
        .filter((s) => s.kind === "keyValue")
        .flatMap((s) => (s as { rows: Array<{ label: string }> }).rows.map((r) => r.label));
      expect(labels.some((l) => l.toLowerCase().includes("allowanonymous"))).toBe(true);
      // CSRF token minted for the posture-flip action.
      expect(data.csrfTokens.some((t) => t.actionId === "posture-flip")).toBe(true);
      expect(data.csrfTokens.some((t) => t.actionId === "posture-public-integration-set")).toBe(
        true,
      );
      expect(data.web.allowAnonymous.value).toBe(false);
      expect(data.web.publicIntegration.value).toBe(false);
      expect(data.web.corsOrigins).toEqual([]);
      expect(data.web.visitorTokensEnabled).toBe(false);
      expect(data.web.externalAuthEnabled).toBe(false);
      expect(data.web.externalAuthHeader).toBe("x-auggy-auth-assertion");
      expect(data.web.agentAccessEntries).toBe("0");
      expect(data.routes.summary.totalRoutes).toBe(0);
      expect(data.routes.entries).toEqual([]);
    } finally {
      await agent.stop();
    }
  });

  it("POST /console/action/posture-flip writes admin-overrides.json + mutates closure", async () => {
    const agentDir = tempAgentDir();
    const port = await freePort();
    const model = createMockModel();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
      agentDir,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const csrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-flip",
      });

      const resp = await fetch(`http://127.0.0.1:${port}/console/action/posture-flip`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf, value: "true" }).toString(),
        redirect: "manual",
      });
      expect(resp.status).toBe(303);
      expect(resp.headers.get("location")).toContain("/console?msg=");
      await resp.text();

      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.allowAnonymous).toBe(true);

      // Verify the change appears in the dashboard JSON the SPA will fetch.
      const data = await fetchDashboard(port, "test-token");
      const postureBlock = data.blocks.find((b) => b.title?.includes("Posture"));
      const allowRow = postureBlock!.sections
        .filter((s) => s.kind === "keyValue")
        .flatMap((s) => (s as { rows: Array<{ label: string; value: string }> }).rows)
        .find((r) => r.label.toLowerCase().includes("allowanonymous"));
      expect(allowRow?.value).toBe("true");
      expect(data.web.allowAnonymous.value).toBe(true);
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("POST /console/action/posture-reset clears the override and reverts to yaml", async () => {
    const agentDir = tempAgentDir();
    const port = await freePort();
    const model = createMockModel();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
      agentDir,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const flipCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-flip",
      });
      await fetch(`http://127.0.0.1:${port}/console/action/posture-flip`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: flipCsrf, value: "true" }).toString(),
        redirect: "manual",
      });

      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);

      const resetCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-reset",
      });
      const resp = await fetch(`http://127.0.0.1:${port}/console/action/posture-reset`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: resetCsrf }).toString(),
        redirect: "manual",
      });
      expect(resp.status).toBe(303);
      await resp.text();

      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport?.allowAnonymous).toBeUndefined();
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("POST /console/action/posture-public-integration-set publishes and privatizes discovery", async () => {
    const agentDir = tempAgentDir();
    const port = await freePort();
    const model = createMockModel();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
      publicIntegration: false,
      agentDir,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      let resp = await fetch(`http://127.0.0.1:${port}/agent`);
      expect(resp.status).toBe(404);
      resp = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      expect(resp.status).toBe(404);
      resp = await fetch(`http://127.0.0.1:${port}/`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Private");

      const publishCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-public-integration-set",
      });
      resp = await fetch(`http://127.0.0.1:${port}/console/action/posture-public-integration-set`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: publishCsrf, value: "true" }).toString(),
        redirect: "manual",
      });
      expect(resp.status).toBe(303);
      await resp.text();

      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      let parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.publicIntegration).toBe(true);

      resp = await fetch(`http://127.0.0.1:${port}/agent`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Developer surface");
      resp = await fetch(`http://127.0.0.1:${port}/`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain('<a href="/agent">Published</a>');
      resp = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      expect(resp.status).toBe(200);

      let data = await fetchDashboard(port, "test-token");
      let postureBlock = data.blocks.find((b) => b.title?.includes("Posture"));
      let publicRow = postureBlock!.sections
        .filter((s) => s.kind === "keyValue")
        .flatMap((s) => (s as { rows: Array<{ label: string; value: string }> }).rows)
        .find((r) => r.label === "publicIntegration");
      expect(publicRow?.value).toBe("true");
      expect(data.web.publicIntegration.value).toBe(true);

      const privateCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-public-integration-set",
      });
      resp = await fetch(`http://127.0.0.1:${port}/console/action/posture-public-integration-set`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: privateCsrf, value: "false" }).toString(),
        redirect: "manual",
      });
      expect(resp.status).toBe(303);
      await resp.text();

      parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.publicIntegration).toBe(false);
      resp = await fetch(`http://127.0.0.1:${port}/agent`);
      expect(resp.status).toBe(404);
      resp = await fetch(`http://127.0.0.1:${port}/`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Private");

      data = await fetchDashboard(port, "test-token");
      postureBlock = data.blocks.find((b) => b.title?.includes("Posture"));
      publicRow = postureBlock!.sections
        .filter((s) => s.kind === "keyValue")
        .flatMap((s) => (s as { rows: Array<{ label: string; value: string }> }).rows)
        .find((r) => r.label === "publicIntegration");
      expect(publicRow?.value).toBe("false");
      expect(data.web.publicIntegration.value).toBe(false);
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("POST /console/api/chat proxies to /agent/run and invokes the model", async () => {
    const port = await freePort();
    const model = createMockModel({ response: "hello from console chat" });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const csrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "console-chat",
      });
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/chat`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrf, message: "say hello", threadId: "thread-1" }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("RUN_STARTED");
      expect(text).toContain("TEXT_MESSAGE_CONTENT");
      expect(text).toContain("hello from console chat");
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]!.systemBlocks[0]).toContain("(trust: creator)");
      expect(model.calls[0]!.systemBlocks[0]).toContain("Peer: creator (human)");
      expect(model.calls[0]!.systemBlocks[0]).not.toContain("anon-thread-1");
      expect(model.calls[0]!.messages.at(-1)?.content).toBe("say hello");
    } finally {
      await agent.stop();
    }
  });

  it("POST /console/api/chat supplies bound operation identity to tools", async () => {
    const port = await freePort();
    const model = createMockModel();
    model.pushResponse({
      toolCalls: [{ name: "operation_probe", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "operation recorded" });
    let observed: ToolExecuteContext | undefined;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
    });
    const agent = defineAgent(
      {
        name: "zip",
        model: "mock",
        augments: [
          aug,
          {
            name: "operation-probe",
            tools: [
              {
                name: "operation_probe",
                description: "Record the tool execution context.",
                category: "meta",
                input: z.object({}),
                execute: async (_input, context) => {
                  observed = context;
                  return "recorded";
                },
              },
            ],
          },
        ],
      },
      model,
    );
    await agent.start();

    try {
      const csrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "console-chat",
      });
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/chat`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          csrf,
          message: "run the operation probe",
          threadId: "thread-operation-probe",
          chatMode: "creator",
        }),
      });
      expect(resp.status).toBe(200);
      await resp.text();
      expect(observed?.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
      expect(observed?.peer).toMatchObject({ trustLevel: "creator" });
      expect(observed?.threadId).toBe("thread-operation-probe");
      expect(observed?.executionContext).toBeUndefined();
    } finally {
      await agent.stop();
    }
  });

  it("POST /console/api/chat creator mode reaches the model as creator even when anonymous chat is enabled", async () => {
    const port = await freePort();
    const model = createMockModel({ response: "creator mode ok" });
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
      creator: { displayName: "Mike" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const csrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "console-chat",
      });
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/chat`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          csrf,
          message: "who am I?",
          threadId: "thread-creator",
          chatMode: "creator",
        }),
      });
      expect(resp.status).toBe(200);
      await resp.text();
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]!.systemBlocks[0]).toContain("(trust: creator)");
      expect(model.calls[0]!.systemBlocks[0]).toContain("Peer: Mike (human)");
      expect(model.calls[0]!.systemBlocks[0]).toContain("Runtime role: verified creator/operator");
      expect(model.calls[0]!.systemBlocks[0]).toContain("agent-global learned behavior updates");
      expect(model.calls[0]!.systemBlocks[0]).not.toContain("anon-thread-creator");
    } finally {
      await agent.stop();
    }
  });

  it("POST /console/api/chat shows retryable provider overload without raw provider JSON", async () => {
    const rawOverload =
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Ccq89SgGiznewkZxfZDk3"}';
    const model: ModelClient = {
      maxContextTokens: 100_000,
      async complete() {
        throw new Error(rawOverload);
      },
      countTokens(text: string) {
        return Math.ceil(text.length / 4);
      },
    };
    const port = await freePort();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: true,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const csrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "console-chat",
      });
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/chat`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          csrf,
          message: "try provider",
          threadId: "thread-overload",
          chatMode: "creator",
        }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.text();
      const events = body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
        type: string;
        message?: string;
        code?: string;
      }>;

      const errEvent = events.find((e) => e.type === "RUN_ERROR");
      expect(errEvent?.message).toBe(
        "Model provider is overloaded. This is retryable; wait a moment and try again.",
      );
      expect(errEvent?.code).toBe("PROVIDER_OVERLOADED");
      expect(JSON.stringify(errEvent)).not.toContain("request_id");
      expect(JSON.stringify(errEvent)).not.toContain("overloaded_error");
    } finally {
      await agent.stop();
    }
  });
});
