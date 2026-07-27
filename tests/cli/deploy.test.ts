import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { getAgent, seedAgentForTest, setCloud } from "../../src/cli/agent-index";
import { type DeployOptions, runDeploy } from "../../src/cli/commands/deploy";
import { RailwayWorkspaceRequiredError, type RailwayCli } from "../../src/cli/deploy/railway-cli";
import { getAuggyVersion } from "../../src/cli/scaffold-package-json";

interface MockCliCalls {
  checkPresence: number;
  checkAuth: number;
  listWorkspaces: number;
  listProjects: number;
  link: Array<{ projectId: string; serviceName: string; cwd: string }>;
  setVariable: Array<{ key: string; value: string }>;
  up: number;
  generateDomain: number;
  addVolume: Array<{ name: string; mountPath: string }>;
  status: number;
  destroyService: number;
  logs: number;
  createProject: Array<{ projectName: string; workspace?: string; cwd: string }>;
  linkProject: Array<{ projectId: string; cwd: string }>;
  linkService: Array<{ serviceName: string; cwd: string }>;
  createService: Array<{ serviceName: string; cwd: string }>;
}

function mockRailwayCli(): { cli: RailwayCli; calls: MockCliCalls; capturedCwds: string[] } {
  const calls: MockCliCalls = {
    checkPresence: 0,
    checkAuth: 0,
    listWorkspaces: 0,
    listProjects: 0,
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
    async listWorkspaces() {
      calls.listWorkspaces++;
      return [];
    },
    async listProjects() {
      calls.listProjects++;
      return [];
    },
    async link({ projectId, serviceName, cwd }) {
      calls.link.push({ projectId, serviceName, cwd });
      capturedCwds.push(cwd);
    },
    async createProject({ projectName, workspace, cwd }) {
      calls.createProject.push({ projectName, workspace, cwd });
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
    promptWorkspace: async () => "workspace_abc",
    promptSavedDeploymentTarget: async () => "saved",
    promptServiceTarget: async () => "new",
    promptServiceName: async (defaultName) => defaultName,
    promptConfirm: async () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    healthCheck: {
      fetch: async () => new Response(null, { status: 200 }),
      sleep: async () => {},
      timeoutMs: 1,
      intervalMs: 1,
    },
    deployWait: {
      sleep: async () => {},
      timeoutMs: 1,
      intervalMs: 1,
    },
    ...opts,
  };
}

function writeAugmentMetadata(
  agentDir: string,
  id: string,
  metadata: Record<string, unknown>,
): void {
  mkdirSync(join(agentDir, "augments", id), { recursive: true });
  writeFileSync(join(agentDir, "augments", id, "augment.yaml"), stringify(metadata));
}

function appendAugmentId(agentDir: string, id: string): void {
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `${readFileSync(join(agentDir, "agent.yaml"), "utf-8")}  - ${id}\n`,
  );
}

function appendJobsSettings(agentDir: string, dbPath: string): void {
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `${readFileSync(join(agentDir, "agent.yaml"), "utf-8")}settings:\n  jobs:\n    enabled: true\n    dbPath: ${JSON.stringify(dbPath)}\n`,
  );
}

function writeWebTransportWithVisitorBinding(agentDir: string): void {
  writeAugmentMetadata(agentDir, "webTransport", {
    type: "webTransport",
    config: {
      port: 8080,
      auth: {
        type: "bearer",
        token: "${AUGGY_WEB_TOKEN}",
      },
      visitorTokens: {
        agentBinding: "${AUGGY_AGENT_ID}",
      },
    },
  });
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
        "  - webTransport",
        "",
      ].join("\n"),
    });
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 8080,
        auth: {
          type: "bearer",
          token: "${AUGGY_WEB_TOKEN}",
        },
      },
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
    mkdirSync(join(agentDir, "node_modules", "auggy", "src"), { recursive: true });
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

    // Two secrets plus the immutable agent id and generated public URL.
    const keys = calls.setVariable.map((v) => v.key).sort();
    expect(keys).toEqual([
      "ANTHROPIC_API_KEY",
      "AUGGY_AGENT_ID",
      "AUGGY_PUBLIC_URL",
      "AUGGY_WEB_TOKEN",
    ]);
    expect(calls.setVariable.find((v) => v.key === "AUGGY_AGENT_ID")?.value).toBe(
      "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    );
    expect(calls.setVariable.find((v) => v.key === "AUGGY_PUBLIC_URL")?.value).toBe(
      "https://zip-production-abcd.up.railway.app",
    );

    expect(calls.up).toBe(1);
    expect(result.name).toBe("zip");
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

  test("rejects disabled coordination before doctor imports or Railway calls", async () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `${readFileSync(join(agentDir, "agent.yaml"), "utf8")}settings:\n  coordination:\n    mode: postgres\n    namespace: a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c\n`,
    );
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /runtime-not-enabled/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("rejects deployment metadata bound to another immutable agent before Railway access", async () => {
    writeFileSync(
      join(agentDir, ".auggy-cloud.json"),
      JSON.stringify({
        version: 1,
        agentId: "aug1_99999999-9999-4999-8999-999999999999",
        provider: "railway",
        projectId: "victim-project",
        serviceId: "victim-service",
        url: "https://victim.example",
        volumeId: "victim-volume",
        deployedAt: new Date().toISOString(),
      }),
    );
    const { cli, calls } = mockRailwayCli();
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /belongs to another immutable agent/i,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.up).toBe(0);
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

  test("first deploy prompts for Railway workspace when project creation requires it", async () => {
    const { cli, calls } = mockRailwayCli();
    let promptWorkspaceCalled = false;
    cli.createProject = async ({ projectName, workspace, cwd }) => {
      calls.createProject.push({ projectName, workspace, cwd });
      if (!workspace) {
        throw new RailwayWorkspaceRequiredError("--workspace required");
      }
      return "proj_created_workspace";
    };

    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptProjectTarget: async () => "new",
        promptProjectName: async () => "zip-project",
        promptWorkspace: async () => {
          promptWorkspaceCalled = true;
          return "looselyorganized";
        },
      }),
    );

    expect(promptWorkspaceCalled).toBe(true);
    expect(calls.createProject).toEqual([
      expect.objectContaining({ projectName: "zip-project", workspace: undefined }),
      expect.objectContaining({ projectName: "zip-project", workspace: "looselyorganized" }),
    ]);
    expect(result.projectId).toBe("proj_created_workspace");
  });

  test("first deploy selects from discovered Railway workspaces before creating a project", async () => {
    const { cli, calls } = mockRailwayCli();
    cli.listWorkspaces = async () => {
      calls.listWorkspaces++;
      return [
        { id: "workspace_a", name: "Team A" },
        { id: "workspace_b", name: "Team B" },
      ];
    };
    let promptedWorkspaces: unknown = null;

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptProjectTarget: async () => "new",
        promptProjectName: async () => "zip-project",
        promptWorkspace: async (workspaces) => {
          promptedWorkspaces = workspaces;
          return "workspace_b";
        },
      }),
    );

    expect(promptedWorkspaces).toEqual([
      { id: "workspace_a", name: "Team A" },
      { id: "workspace_b", name: "Team B" },
    ]);
    expect(calls.createProject).toEqual([
      expect.objectContaining({ projectName: "zip-project", workspace: "workspace_b" }),
    ]);
  });

  test("first deploy selects workspace before choosing an existing project", async () => {
    const { cli, calls } = mockRailwayCli();
    cli.listWorkspaces = async () => {
      calls.listWorkspaces++;
      return [{ id: "workspace_a", name: "Team A" }];
    };
    cli.listProjects = async (args) => {
      calls.listProjects++;
      expect(args).toEqual({ workspace: "workspace_a" });
      return [
        {
          id: "project_1",
          name: "Existing API",
          workspaceId: "workspace_a",
          workspaceName: "Team A",
        },
      ];
    };
    const events: string[] = [];
    let promptedProjects: unknown = null;

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptWorkspace: async (workspaces) => {
          events.push("workspace");
          expect(workspaces).toEqual([{ id: "workspace_a", name: "Team A" }]);
          return "workspace_a";
        },
        promptProjectTarget: async ({ workspace, projects } = {}) => {
          events.push("target");
          expect(workspace).toEqual({ id: "workspace_a", name: "Team A" });
          expect(projects?.map((project) => project.id)).toEqual(["project_1"]);
          return "existing";
        },
        promptProjectId: async (projects) => {
          events.push("project");
          promptedProjects = projects;
          return "project_1";
        },
      }),
    );

    expect(events).toEqual(["workspace", "target", "project"]);
    expect(promptedProjects).toEqual([
      {
        id: "project_1",
        name: "Existing API",
        workspaceId: "workspace_a",
        workspaceName: "Team A",
      },
    ]);
    expect(calls.linkProject).toEqual([expect.objectContaining({ projectId: "project_1" })]);
    expect(calls.createProject).toEqual([]);
  });

  test("interactive first deploy prompts even with one discovered Railway workspace", async () => {
    const { cli, calls } = mockRailwayCli();
    cli.listWorkspaces = async () => {
      calls.listWorkspaces++;
      return [{ id: "workspace_only", name: "Personal Projects" }];
    };
    let promptedWorkspaces: unknown = null;

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        promptProjectTarget: async () => "new",
        promptProjectName: async () => "zip-project",
        promptWorkspace: async (workspaces) => {
          promptedWorkspaces = workspaces;
          return "workspace_only";
        },
      }),
    );

    expect(promptedWorkspaces).toEqual([{ id: "workspace_only", name: "Personal Projects" }]);
    expect(calls.createProject).toEqual([
      expect.objectContaining({ projectName: "zip-project", workspace: "workspace_only" }),
    ]);
  });

  test("--workspace is used when creating a new Railway project", async () => {
    const { cli, calls } = mockRailwayCli();
    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        workspace: "looselyorganized",
        promptProjectTarget: async () => "new",
        promptProjectName: async () => "zip-project",
      }),
    );

    expect(calls.createProject).toEqual([
      expect.objectContaining({ projectName: "zip-project", workspace: "looselyorganized" }),
    ]);
    expect(calls.listWorkspaces).toBe(0);
  });

  test("--project-name creates a new Railway project without first-deploy prompts", async () => {
    const { cli, calls } = mockRailwayCli();
    let targetPromptCalled = false;
    let namePromptCalled = false;

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        projectName: "release-smoke",
        workspace: "workspace_abc",
        promptProjectTarget: async () => {
          targetPromptCalled = true;
          return "existing";
        },
        promptProjectName: async () => {
          namePromptCalled = true;
          return "prompted-name";
        },
      }),
    );

    expect(targetPromptCalled).toBe(false);
    expect(namePromptCalled).toBe(false);
    expect(calls.createProject).toEqual([
      expect.objectContaining({ projectName: "release-smoke", workspace: "workspace_abc" }),
    ]);
  });

  test("--project-name uses the only discovered Railway workspace without prompting", async () => {
    const { cli, calls } = mockRailwayCli();
    cli.listWorkspaces = async () => {
      calls.listWorkspaces++;
      return [{ id: "workspace_only", name: "Personal Projects" }];
    };
    let promptWorkspaceCalled = false;

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        projectName: "release-smoke",
        promptWorkspace: async () => {
          promptWorkspaceCalled = true;
          return "manual_workspace";
        },
      }),
    );

    expect(promptWorkspaceCalled).toBe(false);
    expect(calls.createProject).toEqual([
      expect.objectContaining({ projectName: "release-smoke", workspace: "workspace_only" }),
    ]);
  });

  test("first deploy can run from a project-local agent.yaml outside ~/.auggy", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "auggy-project-agent-"));
    try {
      writeFileSync(
        join(projectDir, "agent.yaml"),
        [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: project",
          "identity: ./identity.md",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - webTransport",
          "",
        ].join("\n"),
      );
      writeAugmentMetadata(projectDir, "webTransport", {
        type: "webTransport",
        config: {
          port: 8080,
          auth: {
            type: "bearer",
            token: "${AUGGY_WEB_TOKEN}",
          },
        },
      });
      writeFileSync(join(projectDir, "identity.md"), "# Project\n");
      writeFileSync(join(projectDir, ".env"), "ANTHROPIC_API_KEY=sk-test\nAUGGY_WEB_TOKEN=tok-1\n");
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({
          name: "auggy-agent-project",
          private: true,
          type: "module",
          dependencies: {
            auggy: "^0.3.1",
            "@auggy/anthropic": "^0.3.1",
          },
        }),
      );
      mkdirSync(join(projectDir, "node_modules", "auggy"), { recursive: true });
      mkdirSync(join(projectDir, "node_modules", "@auggy", "anthropic"), { recursive: true });

      const { cli, calls } = mockRailwayCli();
      const result = await runDeploy(
        undefined,
        baseDeployOptions(cli, auggyDir, { cwd: projectDir }),
      );

      expect(calls.linkProject[0]?.cwd).toContain("auggy-deploy-project-");
      expect(result.name).toBe("project");
      expect(result.serviceId).toBe("svc_def");
      expect(
        JSON.parse(readFileSync(join(projectDir, ".auggy-cloud.json"), "utf-8")),
      ).toMatchObject({
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip-production-abcd.up.railway.app",
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
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

  test("secret confirmation prompt contains no value-derived bytes", async () => {
    const sentinel = "ABCDE";
    writeFileSync(join(agentDir, ".env"), `ANTHROPIC_API_KEY=${sentinel}\nAUGGY_WEB_TOKEN=FGHIJ\n`);
    const prompts: string[] = [];
    const { cli } = mockRailwayCli();
    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, {
          yes: false,
          promptConfirm: async (message) => {
            prompts.push(message);
            return false;
          },
        }),
      ),
    ).rejects.toThrow(/aborted/i);

    const captured = prompts.join("\n");
    expect(captured).toContain("ANTHROPIC_API_KEY = <set>");
    expect(captured).not.toContain(sentinel);
    for (const fragment of ["AB", "BC", "CD", "DE"]) {
      expect(captured).not.toContain(fragment);
    }
  });

  test("aborts before Railway calls when local deploy preflight fails", async () => {
    const webTransportMetadataPath = join(agentDir, "augments", "webTransport", "augment.yaml");
    writeFileSync(
      webTransportMetadataPath,
      readFileSync(webTransportMetadataPath, "utf-8").replace(
        "${AUGGY_WEB_TOKEN}",
        "${AUGGY_DEPLOY_PREFLIGHT_MISSING_TOKEN}",
      ),
    );
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-test\n");
    const { cli, calls } = mockRailwayCli();
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /Deploy preflight failed:[\s\S]*AUGGY_DEPLOY_PREFLIGHT_MISSING_TOKEN/,
    );

    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.link).toEqual([]);
    expect(calls.up).toBe(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("aborts before Railway calls when webTransport is not on port 8080", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 18080,
        auth: {
          type: "bearer",
          token: "${AUGGY_WEB_TOKEN}",
        },
      },
    });
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /webTransport must listen on port 8080 for Railway deploys \(found 18080\)/,
    );

    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.link).toEqual([]);
    expect(calls.up).toBe(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("aborts before Railway calls when visitorAuth uses console mail for deploy", async () => {
    appendAugmentId(agentDir, "visitorAuth");
    writeWebTransportWithVisitorBinding(agentDir);
    writeAugmentMetadata(agentDir, "visitorAuth", {
      type: "visitorAuth",
      config: {
        publicUrl: "${AUGGY_PUBLIC_URL}",
        dbPath: "./visitor-auth.db",
        agentMail: { transport: "console" },
        signingKey: "${VISITOR_SIGNING_KEY}",
        agentBinding: "${AUGGY_AGENT_ID}",
      },
    });
    writeFileSync(
      join(agentDir, ".env"),
      [
        "ANTHROPIC_API_KEY=sk-test",
        "AUGGY_WEB_TOKEN=tok-1",
        "AUGGY_PUBLIC_URL=http://localhost:8080",
        "VISITOR_SIGNING_KEY=signing-test",
        "AUGGY_AGENT_ID=zip",
        "",
      ].join("\n"),
    );

    const { cli, calls } = mockRailwayCli();
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /visitorAuth is using agentMail\.transport: "console"[\s\S]*augments\/visitorAuth\/augment\.yaml/,
    );

    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.up).toBe(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("allows visitorAuth console mail deploy when explicitly acknowledged", async () => {
    appendAugmentId(agentDir, "visitorAuth");
    writeWebTransportWithVisitorBinding(agentDir);
    writeAugmentMetadata(agentDir, "visitorAuth", {
      type: "visitorAuth",
      config: {
        publicUrl: "${AUGGY_PUBLIC_URL}",
        dbPath: "./visitor-auth.db",
        agentMail: { transport: "console" },
        signingKey: "${VISITOR_SIGNING_KEY}",
        agentBinding: "${AUGGY_AGENT_ID}",
        allowConsoleInProduction: true,
      },
    });
    writeFileSync(
      join(agentDir, ".env"),
      [
        "ANTHROPIC_API_KEY=sk-test",
        "AUGGY_WEB_TOKEN=tok-1",
        "AUGGY_PUBLIC_URL=http://localhost:8080",
        "VISITOR_SIGNING_KEY=signing-test",
        "AUGGY_AGENT_ID=zip",
        "",
      ].join("\n"),
    );

    const { cli, calls } = mockRailwayCli();
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(calls.checkPresence).toBe(1);
    expect(calls.up).toBe(1);
  });

  test("rejects custom legacy SQLite paths outside the Railway volume", async () => {
    appendAugmentId(agentDir, "budgets");
    writeAugmentMetadata(agentDir, "budgets", {
      type: "budgets",
      config: { dbPath: "./runtime/budget-ledger.bin" },
    });
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /budgets\.dbPath must remain \.\/budgets\.db or resolve below \.\/data/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("accepts an absolute core SQLite path contained by the Railway volume", async () => {
    appendAugmentId(agentDir, "budgets");
    writeAugmentMetadata(agentDir, "budgets", {
      type: "budgets",
      config: { dbPath: "/app/data/budget-ledger.db" },
    });
    const { cli, calls } = mockRailwayCli();

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(calls.checkPresence).toBe(1);
    expect(calls.up).toBe(1);
  });

  test("requires durable jobs to live on the Railway runtime volume", async () => {
    appendJobsSettings(agentDir, "/app/runtime/durable-jobs.sqlite");
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /settings\.jobs\.dbPath must resolve below \/app\/data/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("accepts durable jobs on the Railway runtime volume", async () => {
    appendJobsSettings(agentDir, "./data/durable-jobs.sqlite");
    const { cli, calls } = mockRailwayCli();

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(calls.checkPresence).toBe(1);
    expect(calls.up).toBe(1);
  });

  test("rejects an absolute core SQLite path outside the Railway volume", async () => {
    appendAugmentId(agentDir, "budgets");
    writeAugmentMetadata(agentDir, "budgets", {
      type: "budgets",
      config: { dbPath: "/app/runtime/budget-ledger.db" },
    });
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /budgets\.dbPath must remain \.\/budgets\.db or resolve below \.\/data/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("rejects a console chat database path outside the Railway volume", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 8080,
        auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        consoleChat: { dbPath: "/app/runtime/console-chat.db" },
      },
    });
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /webTransport\.consoleChat\.dbPath must resolve below \/app\/data/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("rejects a relative console chat database escape before Railway calls", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 8080,
        auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        consoleChat: { dbPath: "../console-chat.db" },
      },
    });
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /webTransport\.consoleChat\.dbPath must resolve below \/app\/data/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("validates an explicit console chat path even when the console route is disabled", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 8080,
        auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        adminRoute: false,
        consoleChat: { dbPath: "/app/runtime/console-chat.db" },
      },
    });
    const { cli, calls } = mockRailwayCli();

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /webTransport\.consoleChat\.dbPath must resolve below \/app\/data/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("accepts console chat storage below the Railway volume", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 8080,
        auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        consoleChat: { dbPath: "/app/data/console/history.db" },
      },
    });
    const { cli, calls } = mockRailwayCli();

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(calls.checkPresence).toBe(1);
    expect(calls.up).toBe(1);
  });

  test("aborts before Railway calls when budgets deploy posture is not acknowledged", async () => {
    appendAugmentId(agentDir, "budgets");
    writeAugmentMetadata(agentDir, "budgets", {
      type: "budgets",
      config: {
        dbPath: "./data/budgets.db",
        dailyBudgetUsd: 5,
      },
    });

    const prompts: string[] = [];
    const warnings: string[] = [];
    const { cli, calls } = mockRailwayCli();

    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, {
          yes: false,
          promptConfirm: async (message) => {
            prompts.push(message);
            return false;
          },
          logger: { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} },
        }),
      ),
    ).rejects.toThrow(/declined budgets deploy acknowledgement/);

    expect(warnings.join("\n")).toContain("budgets.dailyBudgetUsd is set to $5.00");
    expect(warnings.join("\n")).toContain("runtime soft cap, not billing control");
    expect(warnings.join("\n")).toContain("provider-side hard spend caps");
    expect(warnings.join("\n")).toContain("single-process/single-replica");
    expect(prompts.join("\n")).toContain("Proceed with Railway deploy?");
    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.up).toBe(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("aborts when any budgets augment sets dailyBudgetUsd", async () => {
    appendAugmentId(agentDir, "budgets-observe");
    appendAugmentId(agentDir, "budgets-capped");
    writeAugmentMetadata(agentDir, "budgets-observe", {
      type: "budgets",
      config: {
        dbPath: "./data/budgets-observe.db",
      },
    });
    writeAugmentMetadata(agentDir, "budgets-capped", {
      type: "budgets",
      config: {
        dbPath: "./data/budgets-capped.db",
        dailyBudgetUsd: 7,
      },
    });

    const prompts: string[] = [];
    const warnings: string[] = [];
    const { cli, calls } = mockRailwayCli();

    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, {
          yes: false,
          promptConfirm: async (message) => {
            prompts.push(message);
            return false;
          },
          logger: { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} },
        }),
      ),
    ).rejects.toThrow(/declined budgets deploy acknowledgement/);

    expect(warnings.join("\n")).toContain("budgets.dailyBudgetUsd is set to $7.00");
    expect(prompts.join("\n")).toContain("Proceed with Railway deploy?");
    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("--yes logs budgets deploy posture warning and proceeds", async () => {
    appendAugmentId(agentDir, "budgets");
    writeAugmentMetadata(agentDir, "budgets", {
      type: "budgets",
      config: {
        dbPath: "./data/budgets.db",
        dailyBudgetUsd: 5,
      },
    });

    const warnings: string[] = [];
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        yes: true,
        promptConfirm: async () => {
          throw new Error("promptConfirm should not be called with --yes");
        },
        logger: { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} },
      }),
    );

    expect(warnings.join("\n")).toContain("budgets.dailyBudgetUsd is set to $5.00");
    expect(warnings.join("\n")).toContain("provider-side hard spend caps");
    expect(calls.checkPresence).toBe(1);
    expect(calls.up).toBe(1);
    expect(result.projectId).toBe("proj_abc");
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
    expect(taskMessages).toContain("Pushing 4 env var(s)");
    expect(taskMessages).toContain("Starting Railway build");
    expect(taskMessages).toContain("Waiting for Railway deployment");
    expect(taskMessages).toContain("Verifying deployment health");
  });

  test("health timeout reports pending health but still records the deployment", async () => {
    const warnings: string[] = [];
    const infos: string[] = [];
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: {
          info: (msg) => infos.push(msg),
          warn: (msg) => warnings.push(msg),
          error: () => {},
        },
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
    expect(infos.join("\n")).toMatch(/Deployment health is pending/);
    expect(infos.join("\n")).toMatch(/Railway may still be building/);
    expect(warnings).toHaveLength(0);
    expect(calls.status).toBe(1);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      url: "https://zip-production-abcd.up.railway.app",
    });
  });

  test("waits for Railway deployment to reach success before checking health", async () => {
    const infos: string[] = [];
    const { cli, calls } = mockRailwayCli();
    const statuses = ["BUILDING", "DEPLOYING", "SUCCESS"];
    cli.status = async () => {
      calls.status++;
      const status = statuses.shift() ?? "SUCCESS";
      return {
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status },
      };
    };

    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: { info: (msg) => infos.push(msg), warn: () => {}, error: () => {} },
        deployWait: {
          sleep: async () => {},
          now: (() => {
            let ticks = 0;
            return () => ticks++;
          })(),
          timeoutMs: 10,
          intervalMs: 1,
        },
      }),
    );

    expect(result.health.ok).toBe(true);
    expect(calls.status).toBe(3);
    expect(infos.join("\n")).toMatch(/Railway deployment finished: SUCCESS/);
  });

  test("throws when Railway deployment reaches a failed terminal status", async () => {
    const { cli } = mockRailwayCli();
    cli.status = async () => ({
      project: { id: "proj_abc", name: "lorf" },
      service: { id: "svc_def", name: "zip" },
      deployment: { status: "FAILED" },
    });

    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, {
          deployWait: {
            sleep: async () => {},
            timeoutMs: 1,
            intervalMs: 1,
          },
        }),
      ),
    ).rejects.toThrow(/Railway deployment failed with status FAILED/);
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
    expect(infos.join("\n")).toMatch(
      /Service status: not reported yet; build may still be deploying/,
    );
    expect(infos.join("\n")).toMatch(/Deployment health is pending/);
    expect(warnings).toHaveLength(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      serviceId: "zip",
      url: "https://zip-production-abcd.up.railway.app",
    });
  });

  test("healthy deploy with missing Railway deployment status reports clean success", async () => {
    const infos: string[] = [];
    const { cli } = mockRailwayCli();
    cli.status = async () => ({
      project: { id: "proj_abc", name: "lorf" },
      service: { name: "zip" },
    });

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: {
          info: (msg) => infos.push(msg),
          warn: () => {},
          error: () => {},
        },
      }),
    );

    const output = infos.join("\n");
    expect(output).toContain("Deployment health verified");
    expect(output).toContain("Service status: healthy.");
    expect(output).not.toContain("Railway deployment status not final yet");
    expect(output).not.toContain("new build status was not reported yet");
  });

  test("reads Railway deployment status from alternate CLI shapes", async () => {
    const infos: string[] = [];
    const { cli } = mockRailwayCli();
    cli.status = async () =>
      ({
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployments: [{ status: "DEPLOYING" }],
      }) as Awaited<ReturnType<RailwayCli["status"]>>;

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: {
          info: (msg) => infos.push(msg),
          warn: () => {},
          error: () => {},
        },
      }),
    );

    expect(infos.join("\n")).toMatch(/Service status: DEPLOYING/);
  });

  test("rejects unknown providers", async () => {
    const { cli } = mockRailwayCli();
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { to: "fly" as never as "railway" })),
    ).rejects.toThrow(/only "railway" is supported/i);
  });

  test("throws when agent is not found", async () => {
    const { cli } = mockRailwayCli();
    await expect(runDeploy("ghost", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /not found/i,
    );
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

  test("plain redeploy asks what to do with the saved Railway target", async () => {
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
    const prompts: string[] = [];

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        yes: false,
        promptSavedDeploymentTarget: async ({ cloud, metadataPath }) => {
          prompts.push(
            `${cloud.projectId}:${cloud.serviceId}:${metadataPath.endsWith(".auggy-cloud.json")}`,
          );
          return "saved";
        },
      }),
    );

    expect(prompts).toEqual(["proj_existing:svc_existing:true"]);
    expect(calls.link[0]?.projectId).toBe("proj_existing");
    expect(calls.link[0]?.serviceName).toBe("svc_existing");
    expect(calls.addVolume).toEqual([]);
  });

  test("plain redeploy can recreate the service in the saved project", async () => {
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_existing",
        serviceId: "svc_old",
        url: "https://zip-old.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli, calls } = mockRailwayCli();

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        yes: false,
        promptSavedDeploymentTarget: async () => "recreate",
      }),
    );

    expect(calls.linkProject).toEqual([expect.objectContaining({ projectId: "proj_existing" })]);
    expect(calls.createService).toEqual([expect.objectContaining({ serviceName: "zip" })]);
    expect(calls.link).toEqual([]);
    expect(calls.addVolume).toEqual([{ name: "zip-data", mountPath: "/app/data" }]);
  });

  test("plain redeploy can choose another Railway project and service", async () => {
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_old",
        serviceId: "svc_old",
        url: "https://zip-old.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli, calls } = mockRailwayCli();
    cli.listWorkspaces = async () => {
      calls.listWorkspaces++;
      return [{ id: "workspace_a", name: "Team A" }];
    };
    cli.listProjects = async () => [
      {
        id: "proj_new",
        name: "New Project",
        workspaceId: "workspace_a",
        workspaceName: "Team A",
      },
    ];

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        yes: false,
        promptSavedDeploymentTarget: async () => "choose",
        promptWorkspace: async () => "workspace_a",
        promptProjectTarget: async () => "existing",
        promptProjectId: async () => "proj_new",
        promptServiceTarget: async () => "existing",
        promptServiceName: async () => "svc_new",
      }),
    );

    expect(calls.linkProject).toEqual([expect.objectContaining({ projectId: "proj_new" })]);
    expect(calls.linkService).toEqual([expect.objectContaining({ serviceName: "svc_new" })]);
    expect(calls.link).toEqual([]);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      projectId: "proj_new",
      serviceId: "svc_def",
    });
  });

  test("plain redeploy can clear saved metadata and restart first-deploy flow", async () => {
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_old",
        serviceId: "svc_old",
        url: "https://zip-old.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli, calls } = mockRailwayCli();

    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        yes: false,
        promptSavedDeploymentTarget: async () => "reset",
        promptProjectTarget: async () => "existing",
        promptProjectId: async () => "proj_new",
      }),
    );

    expect(calls.linkProject).toEqual([expect.objectContaining({ projectId: "proj_new" })]);
    expect(calls.createService).toEqual([expect.objectContaining({ serviceName: "zip" })]);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      projectId: "proj_new",
    });
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

  test("redeploy with stale cloud metadata clears it and continues as first deploy", async () => {
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_existing",
        serviceId: "missing-service",
        url: "https://zip-old.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const warnings: string[] = [];
    const { cli, calls } = mockRailwayCli();
    cli.link = async ({ projectId, serviceName, cwd }) => {
      calls.link.push({ projectId, serviceName, cwd });
      throw new Error(
        `railway service link ${serviceName} exited 1: Service "${serviceName}" not found.`,
      );
    };

    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        logger: { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} },
      }),
    );

    expect(warnings.join("\n")).toMatch(/Stale Railway deploy metadata detected/);
    expect(warnings.join("\n")).not.toMatch(/WARNING:/);
    expect(warnings.join("\n")).toMatch(/Cleared .*\.auggy-cloud\.json/);
    expect(calls.createService).toEqual([expect.objectContaining({ serviceName: "zip" })]);
    expect(calls.addVolume).toEqual([{ name: "zip-data", mountPath: "/app/data" }]);
    expect(calls.up).toBe(1);
    expect(result.projectId).toBe("proj_existing");
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      projectId: "proj_existing",
      serviceId: "svc_def",
      url: "https://zip-production-abcd.up.railway.app",
    });
  });

  test("redeploy with missing explicit --service still fails", async () => {
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
    cli.link = async ({ projectId, serviceName, cwd }) => {
      calls.link.push({ projectId, serviceName, cwd });
      throw new Error(
        `railway service link ${serviceName} exited 1: Service "${serviceName}" not found.`,
      );
    };

    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { service: "missing-explicit" })),
    ).rejects.toThrow(/Railway service "missing-explicit" was not found/);
    expect(calls.createService).toEqual([]);
    expect(calls.up).toBe(0);
  });

  test("writes Dockerfile + entrypoint into the staging dir", async () => {
    const { cli, calls } = mockRailwayCli();
    let stagingDir: string | undefined;
    let stagedDockerfile: string | undefined;
    let stagedEntrypoint: string | undefined;
    cli.linkProject = async (args) => {
      stagingDir = args.cwd;
      calls.linkProject.push(args);
      stagedDockerfile = readFileSync(join(args.cwd, "Dockerfile"), "utf-8");
      stagedEntrypoint = readFileSync(join(args.cwd, "auggy-entrypoint.sh"), "utf-8");
    };
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(stagingDir).toBeDefined();
    expect(stagedDockerfile).toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh", "zip"\]/);
    expect(stagedEntrypoint).toMatch(
      /exec bunx auggy dev "\$1" --config \/app\/agent\.yaml --internal-mode railway/,
    );
    expect(existsSync(stagingDir!)).toBe(false);
  });

  test("excludes a configured AgentMail ledger and sidecars with a custom extension", async () => {
    writeAugmentMetadata(agentDir, "agentMail", {
      type: "agentMail",
      config: {
        apiKey: "am_deploy_test",
        inboxId: "inbox_deploy_test",
        dbPath: "./runtime/mail-ledger.bin",
      },
    });
    appendAugmentId(agentDir, "agentMail");
    const runtimeDir = join(agentDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });

    const { cli, calls } = mockRailwayCli();
    cli.checkPresence = async () => {
      calls.checkPresence++;
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        writeFileSync(
          join(runtimeDir, `mail-ledger.bin${suffix}`),
          `recipient=private@example.com body=DO_NOT_STAGE_AGENTMAIL${suffix}`,
        );
      }
      return true as const;
    };
    let leaked = false;
    cli.linkProject = async (args) => {
      calls.linkProject.push(args);
      leaked = ["", "-wal", "-shm", "-journal"].some((suffix) =>
        existsSync(join(args.cwd, "runtime", `mail-ledger.bin${suffix}`)),
      );
    };

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(leaked).toBe(false);
  });

  test("excludes a configured console chat database and sidecars with a custom extension", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: {
        port: 8080,
        auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        consoleChat: { dbPath: "./runtime/console-ledger.bin" },
      },
    });
    const runtimeDir = join(agentDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });

    const { cli, calls } = mockRailwayCli();
    cli.checkPresence = async () => {
      calls.checkPresence++;
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        writeFileSync(
          join(runtimeDir, `console-ledger.bin${suffix}`),
          `private transcript DO_NOT_STAGE_CONSOLE_CHAT${suffix}`,
        );
      }
      return true as const;
    };
    let leaked = false;
    cli.linkProject = async (args) => {
      calls.linkProject.push(args);
      leaked = ["", "-wal", "-shm", "-journal"].some((suffix) =>
        existsSync(join(args.cwd, "runtime", `console-ledger.bin${suffix}`)),
      );
    };

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(leaked).toBe(false);
  });

  test("vendors a local packed auggy runtime into the staging dir when available", async () => {
    const version = getAuggyVersion();
    const tarballName = `auggy-${version}.tgz`;
    writeFileSync(join(dirname(agentDir), tarballName), "packed runtime");
    const { cli, calls } = mockRailwayCli();
    let stagingDir: string | undefined;
    let stagedTarball = false;
    let stagedAuggyDependency: unknown;
    let stagedDockerfile: string | undefined;
    cli.linkProject = async (args) => {
      stagingDir = args.cwd;
      calls.linkProject.push(args);
      stagedTarball = existsSync(join(args.cwd, tarballName));
      const stagedPackage = JSON.parse(readFileSync(join(args.cwd, "package.json"), "utf-8")) as {
        dependencies?: { auggy?: unknown };
      };
      stagedAuggyDependency = stagedPackage.dependencies?.auggy;
      stagedDockerfile = readFileSync(join(args.cwd, "Dockerfile"), "utf-8");
    };

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(stagingDir).toBeDefined();
    expect(stagedTarball).toBe(true);
    expect(stagedAuggyDependency).toBe(`file:./${tarballName}`);
    expect(stagedDockerfile!.indexOf(`COPY ${tarballName} /app/`)).toBeGreaterThan(-1);
    expect(stagedDockerfile!.indexOf("RUN bun install")).toBeGreaterThan(
      stagedDockerfile!.indexOf(`COPY ${tarballName} /app/`),
    );
    expect(existsSync(stagingDir!)).toBe(false);
  });

  test("vendors an existing file: auggy tarball dependency before bun install", async () => {
    const version = getAuggyVersion();
    const tarballName = `auggy-${version}.tgz`;
    writeFileSync(join(dirname(agentDir), tarballName), "packed runtime");
    writeFileSync(
      join(agentDir, "package.json"),
      `${JSON.stringify({
        name: "auggy-agent-zip",
        private: true,
        type: "module",
        dependencies: {
          auggy: `file:../${tarballName}`,
          "@auggy/anthropic": "^0.3.1",
        },
      })}\n`,
    );
    const { cli, calls } = mockRailwayCli();
    let stagingDir: string | undefined;
    let stagedTarball = false;
    let stagedAuggyDependency: unknown;
    let stagedDockerfile: string | undefined;
    cli.linkProject = async (args) => {
      stagingDir = args.cwd;
      calls.linkProject.push(args);
      stagedTarball = existsSync(join(args.cwd, tarballName));
      const stagedPackage = JSON.parse(readFileSync(join(args.cwd, "package.json"), "utf-8")) as {
        dependencies?: { auggy?: unknown };
      };
      stagedAuggyDependency = stagedPackage.dependencies?.auggy;
      stagedDockerfile = readFileSync(join(args.cwd, "Dockerfile"), "utf-8");
    };

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(stagingDir).toBeDefined();
    expect(stagedTarball).toBe(true);
    expect(stagedAuggyDependency).toBe(`file:./${tarballName}`);
    expect(stagedDockerfile!.indexOf(`COPY ${tarballName} /app/`)).toBeGreaterThan(-1);
    expect(stagedDockerfile!.indexOf("RUN bun install")).toBeGreaterThan(
      stagedDockerfile!.indexOf(`COPY ${tarballName} /app/`),
    );
    expect(existsSync(stagingDir!)).toBe(false);
  });

  test("removes the staging directory when Railway setup fails", async () => {
    const { cli, calls } = mockRailwayCli();
    let stagingDir: string | undefined;
    cli.linkProject = async (args) => {
      stagingDir = args.cwd;
      calls.linkProject.push(args);
      expect(existsSync(join(args.cwd, "Dockerfile"))).toBe(true);
    };
    cli.createService = async (args) => {
      calls.createService.push(args);
      throw new Error("synthetic Railway setup failure");
    };

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /synthetic Railway setup failure/,
    );
    expect(stagingDir).toBeDefined();
    expect(existsSync(stagingDir!)).toBe(false);
  });

  test("removes the staging directory when bundle logging fails", async () => {
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("auggy-deploy-zip-")),
    );
    const { cli } = mockRailwayCli();
    const logger = {
      info(message: string) {
        if (message.startsWith("Bundle staged at ")) throw new Error("synthetic logger failure");
      },
      warn() {},
      error() {},
    };

    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir, { logger }))).rejects.toThrow(
      /synthetic logger failure/,
    );
    const leaked = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("auggy-deploy-zip-") && !before.has(name),
    );
    expect(leaked).toEqual([]);
  });
});
