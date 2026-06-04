import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import { webTransport } from "@/transports/web-transport";
import { createMockModel } from "@tests/fixtures/mock-model";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "auggy-g36-p3-1-"));
}

function basicHeader(bearer: string): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
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
    const port = 19310;
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
    } finally {
      await agent.stop();
    }
  });

  it("POST /console/action/posture-flip writes admin-overrides.json + mutates closure", async () => {
    const agentDir = tempAgentDir();
    const port = 19311;
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
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("POST /console/action/posture-reset clears the override and reverts to yaml", async () => {
    const agentDir = tempAgentDir();
    const port = 19312;
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
    const port = 19313;
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

      const publishCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-public-integration-set",
      });
      resp = await fetch(
        `http://127.0.0.1:${port}/console/action/posture-public-integration-set`,
        {
          method: "POST",
          headers: {
            authorization: basicHeader("test-token"),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ _csrf: publishCsrf, value: "true" }).toString(),
          redirect: "manual",
        },
      );
      expect(resp.status).toBe(303);
      await resp.text();

      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      let parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.publicIntegration).toBe(true);

      resp = await fetch(`http://127.0.0.1:${port}/agent`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Integration details");
      resp = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      expect(resp.status).toBe(200);

      let data = await fetchDashboard(port, "test-token");
      let postureBlock = data.blocks.find((b) => b.title?.includes("Posture"));
      let publicRow = postureBlock!.sections
        .filter((s) => s.kind === "keyValue")
        .flatMap((s) => (s as { rows: Array<{ label: string; value: string }> }).rows)
        .find((r) => r.label === "publicIntegration");
      expect(publicRow?.value).toBe("true");

      const privateCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-public-integration-set",
      });
      resp = await fetch(
        `http://127.0.0.1:${port}/console/action/posture-public-integration-set`,
        {
          method: "POST",
          headers: {
            authorization: basicHeader("test-token"),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ _csrf: privateCsrf, value: "false" }).toString(),
          redirect: "manual",
        },
      );
      expect(resp.status).toBe(303);
      await resp.text();

      parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.publicIntegration).toBe(false);
      resp = await fetch(`http://127.0.0.1:${port}/agent`);
      expect(resp.status).toBe(404);

      data = await fetchDashboard(port, "test-token");
      postureBlock = data.blocks.find((b) => b.title?.includes("Posture"));
      publicRow = postureBlock!.sections
        .filter((s) => s.kind === "keyValue")
        .flatMap((s) => (s as { rows: Array<{ label: string; value: string }> }).rows)
        .find((r) => r.label === "publicIntegration");
      expect(publicRow?.value).toBe("false");
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
