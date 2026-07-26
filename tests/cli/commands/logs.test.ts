import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentForTest, setCloud } from "../../../src/cli/agent-index";
import { formatRailwayLogsMessage, runLogs } from "../../../src/cli/commands/logs";

describe("runLogs", () => {
  let auggyDir: string;

  beforeEach(() => {
    auggyDir = mkdtempSync(join(tmpdir(), "auggy-logs-test-"));
  });

  afterEach(() => {
    try {
      rmSync(auggyDir, { recursive: true, force: true });
    } catch {}
  });

  test("fails when the agent is not found", async () => {
    await expect(runLogs("ghost", { auggyDir })).rejects.toThrow(/not found/i);
  });

  test("fails when the agent has no cloud record", async () => {
    seedAgentForTest("zip", {
      auggyDir,
      yaml: "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c\nname: zip\n",
    });
    await expect(runLogs("zip", { auggyDir })).rejects.toThrow(/not deployed/i);
  });

  test("prints a Railway dashboard handoff for deployed agents", async () => {
    seedAgentForTest("zip", {
      auggyDir,
      yaml: "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c\nname: zip\n",
    });
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-12T00:00:00.000Z",
      },
      { auggyDir },
    );
    const message = await captureLog(() => runLogs("zip", { auggyDir }));

    expect(message).toContain('Railway logs for "zip" are available in Railway.');
    expect(message).toContain("https://railway.com/project/proj_abc/service/svc_def");
    expect(message).toContain("App URL:      https://zip.up.railway.app");
    expect(message).toContain("Project:      proj_abc");
    expect(message).toContain("Service:      svc_def");
    expect(message).toContain("Logs or Observability");
  });

  test("can show Railway log handoff from inside a project-local agent without a name", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "auggy-logs-project-"));
    try {
      const agentId = "aug1_11111111-1111-4111-8111-111111111111";
      writeFileSync(join(projectDir, "agent.yaml"), `id: ${agentId}\nname: local\n`);
      writeFileSync(
        join(projectDir, ".auggy-cloud.json"),
        JSON.stringify({
          version: 1,
          agentId,
          provider: "railway",
          projectId: "proj_local",
          serviceId: "svc_local",
          url: "https://local.up.railway.app",
          volumeId: "local-data",
          deployedAt: "2026-05-12T00:00:00.000Z",
        }),
      );
      const message = await captureLog(() => runLogs(undefined, { cwd: projectDir }));

      expect(message).toContain('Railway logs for "local" are available in Railway.');
      expect(message).toContain("https://railway.com/project/proj_local/service/svc_local");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("formats Railway dashboard URLs with encoded IDs", () => {
    const message = formatRailwayLogsMessage("zip", {
      provider: "railway",
      projectId: "proj a/b",
      serviceId: "svc c/d",
      url: "https://zip.up.railway.app",
      volumeId: "zip-data",
      deployedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(message).toContain("https://railway.com/project/proj%20a%2Fb/service/svc%20c%2Fd");
  });
});

async function captureLog(run: () => Promise<string>): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  try {
    const message = await run();
    expect(logs.join("\n")).toBe(message);
    return message;
  } finally {
    console.log = originalLog;
  }
}
