import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgent, getAgent, setCloud } from "../../src/cli/agent-index";
import { runDeploy } from "../../src/cli/commands/deploy";
import type { RailwayCli } from "../../src/cli/deploy/railway-cli";

interface MockCliCalls {
  checkPresence: number;
  checkAuth: number;
  link: Array<{ projectId: string; serviceName: string; cwd: string }>;
  setVariable: Array<{ key: string; value: string }>;
  up: number;
  generateDomain: number;
  addVolume: Array<{ name: string; mountPath: string }>;
  status: number;
  destroyService: number;
}

function mockRailwayCli(): { cli: RailwayCli; calls: MockCliCalls; capturedCwds: string[] } {
  const calls: MockCliCalls = {
    checkPresence: 0,
    checkAuth: 0,
    link: [],
    setVariable: [],
    up: 0,
    generateDomain: 0,
    addVolume: [],
    status: 0,
    destroyService: 0,
  };
  const capturedCwds: string[] = [];
  const cli: RailwayCli = {
    async checkPresence() {
      calls.checkPresence++;
      return true as const;
    },
    async checkAuth() {
      calls.checkAuth++;
      return "operator@example.com";
    },
    async link({ projectId, serviceName, cwd }) {
      calls.link.push({ projectId, serviceName, cwd });
      capturedCwds.push(cwd);
    },
    async setVariable({ key, value }) {
      calls.setVariable.push({ key, value });
    },
    async up() {
      calls.up++;
    },
    async generateDomain() {
      calls.generateDomain++;
      return "https://zip-production-abcd.up.railway.app";
    },
    async addVolume({ name, mountPath }) {
      calls.addVolume.push({ name, mountPath });
    },
    async status() {
      calls.status++;
      return {
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status: "SUCCESS" },
      };
    },
    async destroyService() {
      calls.destroyService++;
    },
  };
  return { cli, calls, capturedCwds };
}

describe("runDeploy", () => {
  let auggyDir: string;
  let agentDir: string;

  beforeEach(() => {
    auggyDir = mkdtempSync(join(tmpdir(), "auggy-deploy-test-"));
    agentDir = join(auggyDir, "agents", "zip");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), "name: zip\nmodel: claude-sonnet-4-6\n");
    writeFileSync(join(agentDir, "identity.md"), "# Zip\n");
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-test\nAUGGY_WEB_TOKEN=tok-1\n");
    addAgent("zip", agentDir, { auggyDir });
  });

  afterEach(() => {
    try {
      rmSync(auggyDir, { recursive: true, force: true });
    } catch {}
  });

  test("first deploy: links, addsVolume, generates domain, pushes secrets + AUGGY_PUBLIC_URL, runs up, writes CloudRecord", async () => {
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy("zip", {
      to: "railway",
      yes: false,
      auggyDir,
      cli,
      promptProjectId: async () => "proj_abc",
      promptConfirm: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(calls.checkPresence).toBe(1);
    expect(calls.checkAuth).toBe(1);
    expect(calls.link).toEqual([
      expect.objectContaining({ projectId: "proj_abc", serviceName: "zip" }),
    ]);
    expect(calls.addVolume).toEqual([{ name: "zip-data", mountPath: "/app/data" }]);
    expect(calls.generateDomain).toBe(1);

    // Three secrets: ANTHROPIC_API_KEY + AUGGY_WEB_TOKEN + AUGGY_PUBLIC_URL.
    const keys = calls.setVariable.map((v) => v.key).sort();
    expect(keys).toEqual(["ANTHROPIC_API_KEY", "AUGGY_PUBLIC_URL", "AUGGY_WEB_TOKEN"]);
    expect(calls.setVariable.find((v) => v.key === "AUGGY_PUBLIC_URL")?.value).toBe(
      "https://zip-production-abcd.up.railway.app",
    );

    expect(calls.up).toBe(1);
    expect(result.url).toBe("https://zip-production-abcd.up.railway.app");
    expect(result.serviceId).toBe("svc_def");
    expect(result.volumeId).toBe("zip-data");

    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud).toMatchObject({
      provider: "railway",
      projectId: "proj_abc",
      serviceId: "svc_def",
      url: "https://zip-production-abcd.up.railway.app",
      volumeId: "zip-data",
    });
  });

  test("D7 sequencing: generateDomain runs BEFORE setVariable so AUGGY_PUBLIC_URL is set before up", async () => {
    const orderLog: string[] = [];
    const { cli } = mockRailwayCli();
    // Wrap to record call order.
    const origGen = cli.generateDomain.bind(cli);
    cli.generateDomain = async (args) => {
      orderLog.push("generateDomain");
      return origGen(args);
    };
    const origSet = cli.setVariable.bind(cli);
    cli.setVariable = async (args) => {
      orderLog.push(`setVariable:${args.key}`);
      return origSet(args);
    };
    const origUp = cli.up.bind(cli);
    cli.up = async (args) => {
      orderLog.push("up");
      return origUp(args);
    };

    await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => "proj_abc",
      promptConfirm: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const domainIdx = orderLog.indexOf("generateDomain");
    const publicUrlIdx = orderLog.indexOf("setVariable:AUGGY_PUBLIC_URL");
    const upIdx = orderLog.indexOf("up");
    expect(domainIdx).toBeGreaterThan(-1);
    expect(publicUrlIdx).toBeGreaterThan(domainIdx);
    expect(upIdx).toBeGreaterThan(publicUrlIdx);
  });

  test("aborts when operator declines secrets-push confirmation", async () => {
    const { cli, calls } = mockRailwayCli();
    await expect(
      runDeploy("zip", {
        to: "railway",
        yes: false,
        auggyDir,
        cli,
        promptProjectId: async () => "proj_abc",
        promptConfirm: async () => false,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/aborted/i);
    expect(calls.up).toBe(0);
    expect(calls.setVariable).toEqual([]);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("--yes flag skips the confirmation prompt", async () => {
    const { cli } = mockRailwayCli();
    let promptCalled = false;
    await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => "proj_abc",
      promptConfirm: async () => {
        promptCalled = true;
        return true;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(promptCalled).toBe(false);
  });

  test("rejects unknown providers", async () => {
    const { cli } = mockRailwayCli();
    await expect(
      runDeploy("zip", {
        to: "fly" as never as "railway",
        yes: false,
        auggyDir,
        cli,
        promptProjectId: async () => "x",
        promptConfirm: async () => true,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/only "railway" is supported/i);
  });

  test("throws when agent is not registered", async () => {
    const { cli } = mockRailwayCli();
    await expect(
      runDeploy("ghost", {
        to: "railway",
        yes: true,
        auggyDir,
        cli,
        promptProjectId: async () => "x",
        promptConfirm: async () => true,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/not registered/i);
  });

  test("redeploy: reuses existing projectId from CloudRecord, skips addVolume", async () => {
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_existing",
        serviceId: "svc_existing",
        url: "https://zip-old.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli, calls } = mockRailwayCli();
    let projectIdPromptCalled = false;
    const result = await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => {
        projectIdPromptCalled = true;
        return "should-not-be-used";
      },
      promptConfirm: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(projectIdPromptCalled).toBe(false);
    expect(calls.link[0]?.projectId).toBe("proj_existing");
    expect(calls.addVolume).toEqual([]); // no addVolume on redeploy
    expect(calls.up).toBe(1);
    expect(result.projectId).toBe("proj_existing");
    // deployedAt was refreshed.
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud?.deployedAt).not.toBe("2026-05-10T00:00:00.000Z");
  });

  test("writes Dockerfile + entrypoint into the staging dir", async () => {
    const { cli, calls } = mockRailwayCli();
    // Capture the cwd `link` was called with — that's the staging dir.
    let stagingDir: string | undefined;
    cli.link = async (args) => {
      stagingDir = args.cwd;
      calls.link.push(args);
    };
    await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => "proj_abc",
      promptConfirm: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(stagingDir).toBeDefined();
    expect(existsSync(join(stagingDir!, "Dockerfile"))).toBe(true);
    expect(existsSync(join(stagingDir!, "auggy-entrypoint.sh"))).toBe(true);
    const dockerfile = readFileSync(join(stagingDir!, "Dockerfile"), "utf-8");
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh", "zip"\]/);
    const entrypoint = readFileSync(join(stagingDir!, "auggy-entrypoint.sh"), "utf-8");
    expect(entrypoint).toMatch(/exec bunx auggy dev "\$1"/);
  });
});
