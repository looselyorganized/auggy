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

describe("webTransport adminInfo — posture row (G36 phase 3)", () => {
  it("GET /admin renders the webTransport posture block", async () => {
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
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: basicHeader("test-token") },
      });
      expect(resp.status).toBe(200);
      const body = await resp.text();
      expect(body).toContain("Posture");
      expect(body).toContain("allowAnonymous");
      expect(body).toContain('action="/admin/action/posture-flip"');
    } finally {
      await agent.stop();
    }
  });

  it("POST /admin/action/posture-flip writes admin-overrides.json + mutates closure", async () => {
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

      const resp = await fetch(`http://127.0.0.1:${port}/admin/action/posture-flip`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf, value: "true" }).toString(),
        redirect: "manual",
      });
      expect(resp.status).toBe(303);
      expect(resp.headers.get("location")).toContain("/admin?msg=");
      await resp.text();

      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.allowAnonymous).toBe(true);

      const getResp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: basicHeader("test-token") },
      });
      const body = await getResp.text();
      expect(body).toContain("true");
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("POST /admin/action/posture-reset clears the override and reverts to yaml", async () => {
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
      await fetch(`http://127.0.0.1:${port}/admin/action/posture-flip`, {
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
      const resp = await fetch(`http://127.0.0.1:${port}/admin/action/posture-reset`, {
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
});
