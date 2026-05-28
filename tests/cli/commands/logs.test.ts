import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentForTest, setCloud } from "../../../src/cli/agent-index";
import { runLogs } from "../../../src/cli/commands/logs";
import type { RailwayCli } from "../../../src/cli/deploy/railway-cli";

function mockRailwayCli() {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const cli: RailwayCli = {
    async checkPresence() {
      calls.push({ name: "checkPresence" });
      return true as const;
    },
    async checkAuth() {
      calls.push({ name: "checkAuth" });
      return "operator@example.com";
    },
    async link(args) {
      calls.push({ name: "link", args });
    },
    async linkProject(args) {
      calls.push({ name: "linkProject", args });
    },
    async linkService(args) {
      calls.push({ name: "linkService", args });
    },
    async createService(args) {
      calls.push({ name: "createService", args });
    },
    async logs(args) {
      calls.push({ name: "logs", args });
    },
    async setVariable() {},
    async up() {},
    async generateDomain() {
      return "https://zip.up.railway.app";
    },
    async addVolume() {},
    async status() {
      return {
        project: { id: "proj_abc", name: "zip" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status: "SUCCESS" },
      };
    },
    async destroyService() {},
  };
  return { cli, calls };
}

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

  test("fails when the agent is not registered", async () => {
    const { cli } = mockRailwayCli();
    await expect(runLogs("ghost", { auggyDir, railwayCli: cli })).rejects.toThrow(/not found/i);
  });

  test("fails when the agent has no cloud record", async () => {
    seedAgentForTest("zip", {
      auggyDir,
      yaml: "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c\nname: zip\n",
    });
    const { cli } = mockRailwayCli();
    await expect(runLogs("zip", { auggyDir, railwayCli: cli })).rejects.toThrow(/not deployed/i);
  });

  test("links to the saved Railway project and streams logs", async () => {
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
    const { cli, calls } = mockRailwayCli();
    await runLogs("zip", { auggyDir, railwayCli: cli });

    expect(calls.map((call) => call.name)).toEqual([
      "checkPresence",
      "checkAuth",
      "link",
      "logs",
    ]);
    expect(calls.find((call) => call.name === "link")?.args).toMatchObject({
      projectId: "proj_abc",
      serviceName: "zip",
    });
  });
});
