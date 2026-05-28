import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgent, seedAgentForTest, setCloud } from "../../src/cli/agent-index";
import { type DeployOptions, runDeploy } from "../../src/cli/commands/deploy";
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
  logs: number;
  createProject: Array<{ projectName: string; cwd: string }>;
  linkProject: Array<{ projectId: string; cwd: string }>;
  linkService: Array<{ serviceName: string; cwd: string }>;
  createService: Array<{ serviceName: string; cwd: string }>;
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
    logs: 0,
    createProject: [],
    linkProject: [],
    linkService: [],
    createService: [],
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
    async createProject({ projectName, cwd }) {
      calls.createProject.push({ projectName, cwd });
      capturedCwds.push(cwd);
      return "proj_created";
    },
    async linkProject({ projectId, cwd }) {
      calls.linkProject.push({ projectId, cwd });
      capturedCwds.push(cwd);
    },
    async linkService({ serviceName, cwd }) {
      calls.linkService.push({ serviceName, cwd });
      capturedCwds.push(cwd);
    },
    async createService({ serviceName, cwd }) {
      calls.createService.push({ serviceName, cwd });
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
    async logs() {
      calls.logs++;
    },
  };
  return { cli, calls, capturedCwds };
}

function baseDeployOptions(
  cli: RailwayCli,
  auggyDir: string,
  opts: Partial<DeployOptions> = {},
): DeployOptions {
  return {
    to: "railway",
    yes: true,
    auggyDir,
    cli,
    promptProjectTarget: async () => "existing",
    promptProjectName: async (defaultName) => defaultName,
    promptProjectId: async () => "proj_abc",
    promptConfirm: async () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    healthCheck: {
      fetch: async () => new Response(null, { status: 200 }),
      sleep: async () => {},
      timeoutMs: 1,
      intervalMs: 1,
    },
    ...opts,
  };
}

describe("runDeploy", () => {
  let auggyDir: string;
  let agentDir: string;

  beforeEach(() => {
    auggyDir = mkdtempSync(join(tmpdir(), "auggy-deploy-test-"));
    agentDir = seedAgentForTest("zip", {
      auggyDir,
      yaml: [
        "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
        "name: zip",
        "identity: ./identity.md",
        "engine:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "augments:",
        "  - name: web",
        "    type: webTransport",
        "    options:",
        "      port: 8080",
        "      auth:",
        "        type: bearer",
        "        token: ${AUGGY_WEB_TOKEN}",
        "",
      ].join("\n"),
    });
    writeFileSync(join(agentDir, "identity.md"), "# Zip\n");
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-test\nAUGGY_WEB_TOKEN=tok-1\n");
    writeFileSync(
      join(agentDir, "package.json"),
      `${JSON.stringify({
        name: "auggy-agent-zip",
        private: true,
        type: "module",
        dependencies: {
          auggy: "^0.3.1",
          "@auggy/anthropic": "^0.3.1",
        },
      })}\n`,
    );
    mkdirSync(join(agentDir, "node_modules", "auggy"), { recursive: true });
    mkdirSync(join(agentDir, "node_modules", "@auggy", "anthropic"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(auggyDir, { recursive: true, force: true });
    } catch {}
  });

  test("first deploy: links project, creates service, addsVolume, generates domain, pushes secrets + AUGGY_PUBLIC_URL, runs up, writes CloudRecord", async () => {
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy("zip", baseDeployOptions(cli, auggyDir, { yes: false }));

    expect(calls.checkPresence).toBe(1);
    expect(calls.checkAuth).toBe(1);
    expect(calls.linkProject).toEqual([expect.objectContaining({ projectId: "proj_abc" })]);
    expect(calls.createService).toEqual([expect.objectContaining({ serviceName: "zip" })]);
    expect(calls.link).toEqual([]);
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
    expect(result.health).toMatchObject({
      ok: true,
      url: "https://zip-production-abcd.up.railway.app/health",
    });

    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud).toMatchObject({
      provider: "railway",
      projectId: "proj_abc",
      serviceId: "svc_def",
      url: "https://zip-production-abcd.up.railway.app",
      volumeId: "zip-data",
    });
  });

  test("first deploy can create a new Railway project", async () => {
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptProjectTarget: async () => "new",
        promptProjectName: async () => "zip-project",
      }),
    );

    expect(calls.createProject).toEqual([expect.objectContaining({ projectName: "zip-project" })]);
    expect(calls.linkProject).toEqual([]);
    expect(calls.createService).toEqual([expect.objectContaining({ serviceName: "zip" })]);
    expect(result.projectId).toBe("proj_created");
    expect(getAgent("zip", { auggyDir })?.cloud?.projectId).toBe("proj_created");
  });

  test("--project skips the project target prompt and uses an existing project", async () => {
    const { cli, calls } = mockRailwayCli();
    let promptCalled = false;
    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        project: "proj_flag",
        promptProjectTarget: async () => {
          promptCalled = true;
          return "new";
        },
      }),
    );

    expect(promptCalled).toBe(false);
    expect(calls.createProject).toEqual([]);
    expect(calls.linkProject[0]?.projectId).toBe("proj_flag");
  });

  test("first deploy with --service links an existing Railway service instead of creating one", async () => {
    const { cli, calls } = mockRailwayCli();
    await runDeploy("zip", baseDeployOptions(cli, auggyDir, { service: "existing-api" }));

    expect(calls.linkProject).toEqual([expect.objectContaining({ projectId: "proj_abc" })]);
    expect(calls.linkService).toEqual([expect.objectContaining({ serviceName: "existing-api" })]);
    expect(calls.createService).toEqual([]);
    expect(calls.addVolume).toEqual([{ name: "zip-data", mountPath: "/app/data" }]);
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

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

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
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, {
          yes: false,
          promptConfirm: async () => false,
        }),
      ),
    ).rejects.toThrow(/aborted/i);
    expect(calls.up).toBe(0);
    expect(calls.setVariable).toEqual([]);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("aborts before Railway calls when local deploy preflight fails", async () => {
    const agentYamlPath = join(agentDir, "agent.yaml");
    writeFileSync(
      agentYamlPath,
      readFileSync(agentYamlPath, "utf-8").replace(
        "${AUGGY_WEB_TOKEN}",
        "${AUGGY_DEPLOY_PREFLIGHT_MISSING_TOKEN}",
      ),
    );
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-test\n");
    const { cli, calls } = mockRailwayCli();
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir)),
    ).rejects.toThrow(/Deploy preflight failed:[\s\S]*AUGGY_DEPLOY_PREFLIGHT_MISSING_TOKEN/);

    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.link).toEqual([]);
    expect(calls.up).toBe(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("--yes flag skips the confirmation prompt", async () => {
    const { cli } = mockRailwayCli();
    let promptCalled = false;
    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptConfirm: async () => {
          promptCalled = true;
          return true;
        },
      }),
    );
    expect(promptCalled).toBe(false);
  });

  test("uses task logger around long Railway operations", async () => {
    const taskMessages: string[] = [];
    const { cli } = mockRailwayCli();
    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          task: async (message, run) => {
            taskMessages.push(message);
            return run();
          },
        },
      }),
    );

    expect(taskMessages).toContain("Linking Railway project");
    expect(taskMessages).toContain("Creating Railway service zip");
    expect(taskMessages).toContain("Mounting Railway volume");
    expect(taskMessages).toContain("Generating public Railway URL");
    expect(taskMessages).toContain("Pushing 3 env var(s)");
    expect(taskMessages).toContain("Starting Railway build");
    expect(taskMessages).toContain("Verifying deployment health");
  });

  test("health timeout warns but still records the deployment", async () => {
    const warnings: string[] = [];
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} },
        healthCheck: {
          fetch: async () => new Response(null, { status: 503 }),
          sleep: async () => {},
          now: (() => {
            let ticks = 0;
            return () => ticks++;
          })(),
          timeoutMs: 1,
          intervalMs: 1,
        },
      }),
    );

    expect(result.health).toMatchObject({
      ok: false,
      status: 503,
      url: "https://zip-production-abcd.up.railway.app/health",
    });
    expect(warnings.join("\n")).toMatch(/Deployment is not healthy yet/);
    expect(warnings.join("\n")).toMatch(/railway logs/);
    expect(calls.status).toBe(1);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      url: "https://zip-production-abcd.up.railway.app",
    });
  });

  test("missing Railway deployment status does not crash after build is queued", async () => {
    const warnings: string[] = [];
    const infos: string[] = [];
    const { cli } = mockRailwayCli();
    cli.status = async () => ({
      project: { id: "proj_abc", name: "lorf" },
      service: { name: "zip" },
    });

    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: {
          info: (msg) => infos.push(msg),
          warn: (msg) => warnings.push(msg),
          error: () => {},
        },
        healthCheck: {
          fetch: async () => new Response(null, { status: 404 }),
          sleep: async () => {},
          now: (() => {
            let ticks = 0;
            return () => ticks++;
          })(),
          timeoutMs: 1,
          intervalMs: 1,
        },
      }),
    );

    expect(result.health).toMatchObject({ ok: false, status: 404 });
    expect(result.serviceId).toBe("zip");
    expect(infos.join("\n")).toMatch(/Service status: unknown/);
    expect(warnings.join("\n")).toMatch(/Deployment is not healthy yet/);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      serviceId: "zip",
      url: "https://zip-production-abcd.up.railway.app",
    });
  });

  test("rejects unknown providers", async () => {
    const { cli } = mockRailwayCli();
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { to: "fly" as never as "railway" })),
    ).rejects.toThrow(/only "railway" is supported/i);
  });

  test("throws when agent is not registered", async () => {
    const { cli } = mockRailwayCli();
    await expect(
      runDeploy("ghost", baseDeployOptions(cli, auggyDir)),
    ).rejects.toThrow(/not registered|not found/i);
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
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptProjectId: async () => {
          projectIdPromptCalled = true;
          return "should-not-be-used";
        },
      }),
    );
    expect(projectIdPromptCalled).toBe(false);
    expect(calls.link[0]?.projectId).toBe("proj_existing");
    expect(calls.link[0]?.serviceName).toBe("svc_existing");
    expect(calls.addVolume).toEqual([]); // no addVolume on redeploy
    expect(calls.up).toBe(1);
    expect(result.projectId).toBe("proj_existing");
    // deployedAt was refreshed.
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud?.deployedAt).not.toBe("2026-05-10T00:00:00.000Z");
  });

  test("redeploy with --service overrides the stored service id", async () => {
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
    await runDeploy("zip", baseDeployOptions(cli, auggyDir, { service: "existing-api" }));

    expect(calls.link[0]?.projectId).toBe("proj_existing");
    expect(calls.link[0]?.serviceName).toBe("existing-api");
    expect(calls.createService).toEqual([]);
  });

  test("writes Dockerfile + entrypoint into the staging dir", async () => {
    const { cli, calls } = mockRailwayCli();
    // Capture the cwd `linkProject` was called with — that's the staging dir.
    let stagingDir: string | undefined;
    cli.linkProject = async (args) => {
      stagingDir = args.cwd;
      calls.linkProject.push(args);
    };
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(stagingDir).toBeDefined();
    expect(existsSync(join(stagingDir!, "Dockerfile"))).toBe(true);
    expect(existsSync(join(stagingDir!, "auggy-entrypoint.sh"))).toBe(true);
    const dockerfile = readFileSync(join(stagingDir!, "Dockerfile"), "utf-8");
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh", "zip"\]/);
    const entrypoint = readFileSync(join(stagingDir!, "auggy-entrypoint.sh"), "utf-8");
    expect(entrypoint).toMatch(/exec bunx auggy dev "\$1"/);
  });
});
