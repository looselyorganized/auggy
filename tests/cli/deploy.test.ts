import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { getAgent, seedAgentForTest, setCloud } from "../../src/cli/agent-index";
import { type DeployOptions, runDeploy } from "../../src/cli/commands/deploy";
import { serializeEnv } from "../../src/cli/env-parse";
import {
  RailwayWorkspaceRequiredError,
  RailwayDeploymentPolicyError,
  RailwaySubprocessCleanupError,
  type RailwayCli,
} from "../../src/cli/deploy/railway-cli";
import {
  generatePortableEntrypoint,
  generateRailwayEntrypoint,
} from "../../src/cli/deploy/dockerfile";
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
  inspectIngress: number;
  domainPorts: Array<number | undefined>;
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
    inspectIngress: 0,
    domainPorts: [],
    destroyService: 0,
    logs: 0,
    createProject: [],
    linkProject: [],
    linkService: [],
    createService: [],
  };
  const capturedCwds: string[] = [];
  let selectedProject = "proj_abc";
  let selectedService = "svc_def";
  let mountedVolume: string | null = null;
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
      selectedProject = projectId;
      mountedVolume = "volume-observed";
      selectedService = serviceName.startsWith("svc_") ? serviceName : "svc_def";
      calls.link.push({ projectId, serviceName, cwd });
      capturedCwds.push(cwd);
    },
    async createProject({ projectName, workspace, cwd }) {
      selectedProject = "proj_created";
      calls.createProject.push({ projectName, workspace, cwd });
      capturedCwds.push(cwd);
      return "proj_created";
    },
    async linkProject({ projectId, cwd }) {
      selectedProject = projectId;
      calls.linkProject.push({ projectId, cwd });
      capturedCwds.push(cwd);
    },
    async linkService({ serviceName, cwd }) {
      selectedService = serviceName.startsWith("svc_") ? serviceName : "svc_def";
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
    async generateDomain({ port }) {
      calls.domainPorts.push(port);
      calls.generateDomain++;
      return "https://zip-production-abcd.up.railway.app";
    },
    async inspectVolume() {
      return mountedVolume;
    },
    async addVolume({ name, mountPath }) {
      mountedVolume = "volume-observed";
      calls.addVolume.push({ name, mountPath });
    },
    async inspectIngress() {
      calls.inspectIngress++;
      return {
        projectId: selectedProject,
        serviceId: selectedService,
        serviceName: "zip",
        environmentId: "env-production",
        domains: [],
        httpVariables: [],
        healthPath: null,
        replicas: 1,
        latestDeploymentId: null,
      };
    },
    async status() {
      calls.status++;
      return {
        project: { id: selectedProject, name: "lorf" },
        service: { id: selectedService, name: "zip" },
        deployment: { id: "deployment-new", status: "SUCCESS" },
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
      timeoutMs: 100,
      intervalMs: 1,
    },
    deployWait: {
      sleep: async () => {},
      timeoutMs: 100,
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
    writeFixtureLock(agentDir);
    mkdirSync(join(agentDir, "node_modules", "auggy", "src"), { recursive: true });
    writeFileSync(
      join(agentDir, "node_modules", "auggy", "package.json"),
      JSON.stringify({ name: "auggy", version: "0.5.0", bin: "src/index.ts" }),
    );
    writeFileSync(
      join(agentDir, "node_modules", "auggy", "src", "index.ts"),
      'throw new Error("preflight must not execute runtime");',
    );
    mkdirSync(join(agentDir, "node_modules", "@auggy", "anthropic"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(auggyDir, { recursive: true, force: true });
    } catch {}
  });

  function expectNoHostedMutation(calls: MockCliCalls): void {
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createService).toHaveLength(0);
    expect(calls.addVolume).toHaveLength(0);
    expect(calls.setVariable).toHaveLength(0);
    expect(calls.generateDomain).toBe(0);
    expect(calls.up).toBe(0);
    expect(existsSync(join(agentDir, ".auggy-cloud.json"))).toBe(false);
  }

  test.each(["RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID"])(
    "rejects ambient %s before any Railway call, including empty selectors",
    async (key) => {
      const previous = process.env[key];
      const source = readFileSync(join(agentDir, "agent.yaml"), "utf8");
      try {
        for (const value of ["PRIVATE_TARGET_SENTINEL", ""]) {
          process.env[key] = value;
          const { cli, calls } = mockRailwayCli();
          await expect(
            runDeploy("zip", baseDeployOptions(cli, auggyDir, { projectName: "must-not-create" })),
          ).rejects.toThrow(`Unset ${key} before deploying`);
          expect(calls).toEqual(mockRailwayCli().calls);
          expectNoHostedMutation(calls);
          expect(readFileSync(join(agentDir, "agent.yaml"), "utf8")).toBe(source);
        }
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    },
  );

  test.each(["mismatched", "missing", "malformed"])(
    "rejects alternate config with %s canonical identity before any Railway call",
    async (variant) => {
      const canonicalPath = join(agentDir, "agent.yaml");
      const selectedPath = join(agentDir, "production.yaml");
      const source = readFileSync(canonicalPath, "utf8");
      const selected =
        variant === "mismatched" ? source.replace("aug1_a3f7c2e1", "aug1_b3f7c2e1") : source;
      writeFileSync(selectedPath, selected);
      if (variant === "missing") rmSync(canonicalPath);
      else if (variant === "malformed") writeFileSync(canonicalPath, "id: [PRIVATE_SENTINEL\n");
      const { cli, calls } = mockRailwayCli();
      await expect(
        runDeploy(
          "zip",
          baseDeployOptions(cli, auggyDir, {
            config: selectedPath,
            projectName: "must-not-create",
          }),
        ),
      ).rejects.toThrow(
        variant === "mismatched" ? /same immutable agent id/ : /adjacent canonical agent.yaml/,
      );
      expect(calls).toEqual(mockRailwayCli().calls);
      expectNoHostedMutation(calls);
      expect(readFileSync(selectedPath, "utf8")).toBe(selected);
      if (variant === "mismatched") expect(readFileSync(canonicalPath, "utf8")).toBe(source);
      else if (variant === "missing") expect(existsSync(canonicalPath)).toBe(false);
      else expect(readFileSync(canonicalPath, "utf8")).toBe("id: [PRIVATE_SENTINEL\n");
    },
  );

  test("alternate config sharing the canonical immutable identity uploads that config and writes its bound record", async () => {
    const canonicalPath = join(agentDir, "agent.yaml");
    const source = readFileSync(canonicalPath, "utf8");
    const selectedPath = join(agentDir, "production.yaml");
    const selected = `${source}# Production selection\n`;
    writeFileSync(selectedPath, selected);
    const { cli, calls } = mockRailwayCli();
    cli.up = async ({ cwd }) => {
      calls.up++;
      expect(readFileSync(join(cwd, "production.yaml"), "utf8")).toBe(selected);
      expect(readFileSync(join(cwd, "agent.yaml"), "utf8")).toBe(source);
      expect(JSON.parse(readFileSync(join(cwd, "auggy-deployment.json"), "utf8")).configPath).toBe(
        "production.yaml",
      );
      expect(readFileSync(join(cwd, "Dockerfile"), "utf8")).toContain("/app/production.yaml");
    };
    await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, { config: selectedPath, projectName: "valid-alternate" }),
    );
    expect(calls.createProject).toHaveLength(1);
    expect(calls.up).toBe(1);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      version: 2,
      agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    });
    expect(readFileSync(canonicalPath, "utf8")).toBe(source);
    expect(readFileSync(selectedPath, "utf8")).toBe(selected);
  });

  test.each([
    "railway.json",
    "railway.toml",
    "RAILWAY.JSON",
    "RaIlWaY.ToMl",
    ".railwayignore",
    ".RAILWAYIGNORE",
    ".ignore",
    ".IGNORE",
  ])("rejects root %s before project creation without changing source", async (filename) => {
    const text = '{"deploy":{"startCommand":"sleep infinity","numReplicas":2}}';
    const path = join(agentDir, filename);
    writeFileSync(path, text);
    const { cli, calls } = mockRailwayCli();
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { projectName: "must-not-create" })),
    ).rejects.toBeInstanceOf(RailwayDeploymentPolicyError);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(calls.checkPresence).toBe(0);
    expectNoHostedMutation(calls);
  });

  test.each(["railway.json", ".railwayignore", ".ignore"])(
    "rejects a root %s symbolic link without following it",
    async (filename) => {
      symlinkSync(join(auggyDir, "absent-target"), join(agentDir, filename));
      const { cli, calls } = mockRailwayCli();
      await expect(
        runDeploy("zip", baseDeployOptions(cli, auggyDir, { projectName: "must-not-create" })),
      ).rejects.toBeInstanceOf(RailwayDeploymentPolicyError);
      expectNoHostedMutation(calls);
    },
  );

  test.each([".ignore", ".RAILWAYIGNORE"])(
    "rejects a nested upload %s before project creation",
    async (filename) => {
      mkdirSync(join(agentDir, "source"));
      writeFileSync(join(agentDir, "source", filename), "*\n");
      const { cli, calls } = mockRailwayCli();
      await expect(
        runDeploy("zip", baseDeployOptions(cli, auggyDir, { projectName: "must-not-create" })),
      ).rejects.toThrow(/upload ignore/);
      expectNoHostedMutation(calls);
    },
  );

  test.each([".ignore", ".RAILWAYIGNORE", ".git", ".ignore-link"])(
    "rejects temporary-directory ancestor %s input before project creation",
    async (variant) => {
      const temporaryParent = join(auggyDir, "upload-parent");
      mkdirSync(temporaryParent);
      const marker = variant === ".ignore-link" ? ".ignore" : variant;
      const path = join(temporaryParent, marker);
      if (variant === ".ignore-link") symlinkSync(join(temporaryParent, "absent"), path);
      else writeFileSync(path, "*\n");
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = temporaryParent;
      const { cli, calls } = mockRailwayCli();
      try {
        await expect(
          runDeploy("zip", baseDeployOptions(cli, auggyDir, { projectName: "must-not-create" })),
        ).rejects.toThrow(/upload ignore/);
        expectNoHostedMutation(calls);
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
    },
  );

  test("gitignore cannot remove generated deployment files from the upload context", async () => {
    const ignore = "Dockerfile\nauggy-entrypoint.sh\nauggy-deployment.json\nagent.yaml\n";
    writeFileSync(join(agentDir, ".gitignore"), ignore);
    const { cli, calls } = mockRailwayCli();
    cli.up = async ({ cwd }) => {
      calls.up++;
      for (const file of [
        "Dockerfile",
        "auggy-entrypoint.sh",
        "auggy-deployment.json",
        "agent.yaml",
      ])
        expect(existsSync(join(cwd, file))).toBe(true);
      expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(ignore);
    };
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(calls.up).toBe(1);
    expect(readFileSync(join(agentDir, ".gitignore"), "utf8")).toBe(ignore);
  });

  test.each([
    "PORT",
    "AUGGY_DATA_DIR",
    "AUGGY_DEPLOYMENT_MANIFEST",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_VOLUME_MOUNT_PATH",
    "RAILWAY_DOCKERFILE_PATH",
    "RAILPACK_START_CMD",
    "NIXPACKS_BUILD_CMD",
    "RAILWAY_RUN_UID",
  ])("refuses local %s before creating a remote project", async (key) => {
    if (key === "PORT") configureTelegram();
    const path = join(agentDir, ".env");
    const source = `${readFileSync(path, "utf8")}${key}=PRIVATE_OVERRIDE\n`;
    writeFileSync(path, source);
    const { cli, calls } = mockRailwayCli();
    const previous = process.env[key];
    try {
      await expect(
        runDeploy("zip", baseDeployOptions(cli, auggyDir, { projectName: "must-not-create" })),
      ).rejects.toThrow();
      expect(calls.checkPresence).toBe(0);
      expectNoHostedMutation(calls);
      expect(readFileSync(path, "utf8")).toBe(source);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("an existing target with effective overrides fails before hosted mutation", async () => {
    const { cli, calls } = mockRailwayCli();
    cli.inspectIngress = async () => {
      throw new RailwayDeploymentPolicyError("Service overrides require review.");
    };
    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, { project: "proj_abc", service: "svc_def" }),
      ),
    ).rejects.toBeInstanceOf(RailwayDeploymentPolicyError);
    expectNoHostedMutation(calls);
  });

  test.each(["cleanup", "policy", "final-inspection"])(
    "fatal %s uncertainty cannot become an unverified success or write cloud metadata",
    async (variant) => {
      const { cli } = mockRailwayCli();
      let fetches = 0;
      const error =
        variant === "cleanup"
          ? new RailwaySubprocessCleanupError()
          : new RailwayDeploymentPolicyError("Effective settings changed.");
      if (variant === "final-inspection") {
        const inspect = cli.inspectIngress;
        let calls = 0;
        cli.inspectIngress = async (args) => {
          if (++calls > 1) throw error;
          return inspect(args);
        };
      } else
        cli.status = async () => {
          throw error;
        };
      await expect(
        runDeploy(
          "zip",
          baseDeployOptions(cli, auggyDir, {
            healthCheck: {
              fetch: async () => {
                fetches++;
                return new Response(null, { status: 200 });
              },
            },
          }),
        ),
      ).rejects.toBe(error);
      if (variant !== "final-inspection") expect(fetches).toBe(0);
      expect(existsSync(join(agentDir, ".auggy-cloud.json"))).toBe(false);
    },
  );

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
      "PORT",
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
    expect(result.volumeId).toBe("volume-observed");
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
      volumeId: "volume-observed",
    });
  });

  test("pushes the exact serialized AgentMail key and no legacy key aliases", async () => {
    const exact = `am_!@#$%^&*()[]{};:'"\\|,./<>?~`;
    const agentMailEnvKeys = [
      "AGENTMAIL_API_KEY",
      "AGENTMAIL_ACCOUNT_API_KEY",
      "AGENTMAIL_PARENT_API_KEY",
      "AGENTMAIL_INBOX_ID",
      "AGENTMAIL_INBOX_EMAIL",
    ] as const;
    const previous = new Map(agentMailEnvKeys.map((key) => [key, process.env[key]]));
    for (const key of agentMailEnvKeys) delete process.env[key];

    try {
      writeFileSync(
        join(agentDir, ".env"),
        serializeEnv([
          { kind: "kv", key: "ANTHROPIC_API_KEY", value: "sk-test", raw: "" },
          { kind: "kv", key: "AUGGY_WEB_TOKEN", value: "tok-1", raw: "" },
          { kind: "kv", key: "AGENTMAIL_API_KEY", value: exact, raw: "" },
          {
            kind: "kv",
            key: "AGENTMAIL_ACCOUNT_API_KEY",
            value: "must-not-deploy",
            raw: "",
          },
        ]),
      );

      const { cli, calls } = mockRailwayCli();
      await runDeploy("zip", baseDeployOptions(cli, auggyDir));

      expect(calls.setVariable.find(({ key }) => key === "AGENTMAIL_API_KEY")?.value).toBe(exact);
      expect(calls.setVariable.some(({ key }) => key === "AGENTMAIL_ACCOUNT_API_KEY")).toBe(false);
    } finally {
      for (const key of agentMailEnvKeys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
      await cli.linkProject({ projectId: "proj_created_workspace", cwd });
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
      writeFixtureLock(projectDir);
      mkdirSync(join(projectDir, "node_modules", "auggy"), { recursive: true });
      writeFileSync(
        join(projectDir, "node_modules", "auggy", "package.json"),
        JSON.stringify({ name: "auggy", version: "0.5.0", bin: "index.ts" }),
      );
      writeFileSync(
        join(projectDir, "node_modules", "auggy", "index.ts"),
        'throw new Error("preflight must not execute runtime");',
      );
      mkdirSync(join(projectDir, "node_modules", "@auggy", "anthropic"), { recursive: true });

      const { cli, calls } = mockRailwayCli();
      const result = await runDeploy(
        undefined,
        baseDeployOptions(cli, auggyDir, { cwd: projectDir }),
      );

      expect(calls.linkProject[0]?.cwd).toContain("auggy-railway-");
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
          projectName: "must-not-create",
          promptConfirm: async () => false,
        }),
      ),
    ).rejects.toThrow(/aborted/i);
    expect(calls.checkPresence).toBe(0);
    expect(calls.createProject).toHaveLength(0);
    expect(calls.createService).toHaveLength(0);
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

  test("deploys the actual configured HTTP port without rewriting source", async () => {
    writeAugmentMetadata(agentDir, "webTransport", {
      type: "webTransport",
      config: { port: 18080, auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" } },
    });
    const before = readFileSync(join(agentDir, "augments/webTransport/augment.yaml"), "utf8");
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(result.profile).toMatchObject({ kind: "http", port: 18080 });
    expect(calls.domainPorts).toEqual([18080]);
    expect(calls.setVariable).toContainEqual({ key: "PORT", value: "18080" });
    expect(readFileSync(join(agentDir, "augments/webTransport/augment.yaml"), "utf8")).toBe(before);
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

  test("prints the shared-inbox recovery sequence when AgentMail is also installed", async () => {
    appendAugmentId(agentDir, "agentMail");
    appendAugmentId(agentDir, "visitorAuth");
    writeWebTransportWithVisitorBinding(agentDir);
    writeAugmentMetadata(agentDir, "agentMail", {
      type: "agentMail",
      config: {
        apiKey: "am_deploy_test",
        inboxId: "inbox_deploy_test",
        inbound: { mode: "none" },
      },
    });
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
      /augment setup agentMail --mode connect[\s\S]*augment setup visitorAuth --mode env/,
    );

    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
  });

  test("does not recommend canonical automatic setup for a renamed AgentMail mount", async () => {
    appendAugmentId(agentDir, "mail");
    appendAugmentId(agentDir, "visitorAuth");
    writeWebTransportWithVisitorBinding(agentDir);
    writeAugmentMetadata(agentDir, "mail", {
      type: "agentMail",
      config: {
        apiKey: "am_deploy_test",
        inboxId: "inbox_deploy_test",
        inbound: { mode: "none" },
      },
    });
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
    let error: Error | undefined;
    try {
      await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain("inline, renamed, or additional agentMail mount");
    expect(error?.message).toMatch(/Configure exact\s+AGENTMAIL_\* references/);
    expect(error?.message).not.toContain("auggy augment setup agentMail\n");
    expect(calls.checkPresence).toBe(0);
    expect(calls.up).toBe(0);
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
    expect(taskMessages).toContain("Pushing 5 env var(s)");
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
          timeoutMs: 100,
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
    expect(result.readiness.http.state).toBe("timed-out");
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
        deployment: { id: "deployment-new", status },
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
          timeoutMs: 100,
          intervalMs: 1,
        },
      }),
    );

    expect(result.health?.ok).toBe(true);
    expect(calls.status).toBe(3);
    expect(infos.join("\n")).toMatch(/Railway deployment finished: SUCCESS/);
  });

  test("throws when Railway deployment reaches a failed terminal status", async () => {
    const { cli } = mockRailwayCli();
    cli.status = async () => ({
      project: { id: "proj_abc", name: "lorf" },
      service: { id: "svc_def", name: "zip" },
      deployment: { id: "deployment-new", status: "FAILED" },
    });

    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, {
          deployWait: {
            sleep: async () => {},
            timeoutMs: 100,
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
          timeoutMs: 100,
          intervalMs: 1,
        },
      }),
    );

    expect(result.health).toMatchObject({ ok: false, status: 404 });
    expect(result.serviceId).toBe("svc_def");
    expect(infos.join("\n")).toMatch(/Platform readiness: unverified/);
    expect(infos.join("\n")).toMatch(/Deployment health is pending/);
    expect(warnings).toHaveLength(0);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      serviceId: "svc_def",
      url: "https://zip-production-abcd.up.railway.app",
    });
  });

  test("healthy HTTP with missing Railway status remains platform unverified", async () => {
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
    expect(output).toContain(
      "Platform readiness: unverified; HTTP readiness: ready; channel: unverified.",
    );
    expect(output).not.toContain("Railway deployment status not final yet");
    expect(output).not.toContain("new build status was not reported yet");
  });

  test("unrecognized CLI status shape cannot verify the selected deployment", async () => {
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

    expect(infos.join("\n")).toContain("Platform readiness: unverified");
  });

  function configureTelegram(mode: "polling" | "webhook" = "polling") {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      readFileSync(join(agentDir, "agent.yaml"), "utf8").replace(
        "  - webTransport",
        "  - telegramTransport",
      ),
    );
    writeAugmentMetadata(agentDir, "telegramTransport", {
      type: "telegramTransport",
      config: {
        botToken: "${TELEGRAM_BOT_TOKEN}",
        auth: { creatorUserIds: [1234] },
        inbound:
          mode === "polling"
            ? { mode }
            : {
                mode,
                webhook: {
                  publicUrl: "https://agent.example/telegram",
                  secretToken: "test-secret",
                },
              },
      },
    });
    writeFileSync(
      join(agentDir, ".env"),
      "ANTHROPIC_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=test-bot-token\n",
    );
  }

  test("Telegram polling first deploy and redeploy stay workers with no HTTP artifacts or requests", async () => {
    configureTelegram();
    const originalYaml = readFileSync(join(agentDir, "agent.yaml"), "utf8");
    const originalLock = readFileSync(join(agentDir, "bun.lock"), "utf8");
    const { cli, calls } = mockRailwayCli();
    const inspect = cli.inspectIngress;
    cli.inspectIngress = async (args) => {
      const dockerfile = readFileSync(join(args.cwd, "Dockerfile"), "utf8");
      expect(dockerfile).not.toMatch(/(?:ENV PORT=|EXPOSE|HEALTHCHECK)/);
      expect(dockerfile).toContain("RUN bun install --frozen-lockfile");
      expect(readFileSync(join(args.cwd, "auggy-entrypoint.sh"), "utf8")).toContain(
        "--internal-mode railway",
      );
      return inspect(args);
    };
    const options = baseDeployOptions(cli, auggyDir, {
      healthCheck: {
        fetch: async () => {
          throw new Error("worker must not fetch HTTP");
        },
      },
    });
    const first = await runDeploy("zip", options);
    const second = await runDeploy("zip", options);
    for (const result of [first, second])
      expect(result).toMatchObject({
        profile: { kind: "none" },
        url: null,
        health: null,
        readiness: {
          platform: "ready",
          http: { state: "not-applicable", reason: "no-ingress" },
          channel: { state: "unverified" },
        },
      });
    expect(calls.generateDomain).toBe(0);
    expect(calls.setVariable.some(({ key }) => ["PORT", "AUGGY_PUBLIC_URL"].includes(key))).toBe(
      false,
    );
    expect(calls.addVolume).toHaveLength(1);
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      version: 2,
      profile: { kind: "none" },
      url: null,
      serviceId: "svc_def",
    });
    expect(readFileSync(join(agentDir, "agent.yaml"), "utf8")).toBe(originalYaml);
    expect(readFileSync(join(agentDir, "bun.lock"), "utf8")).toBe(originalLock);
  });

  test("Telegram webhook uses its own 8081 listener with no invented health or Console", async () => {
    configureTelegram("webhook");
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        healthCheck: {
          fetch: async () => {
            throw new Error("no health route");
          },
        },
      }),
    );
    expect(result).toMatchObject({
      profile: { kind: "http", port: 8081, healthPath: null, consolePath: null },
      health: null,
      readiness: { http: { state: "not-configured" }, channel: { state: "unverified" } },
    });
    expect(calls.domainPorts).toEqual([8081]);
  });

  test.each(["domain", "variable", "health", "replicas", "unknown"])(
    "existing worker target rejects %s before any hosted mutation",
    async (variant) => {
      configureTelegram();
      const { cli, calls } = mockRailwayCli();
      const inspect = cli.inspectIngress;
      cli.inspectIngress = async (args) => {
        const value = await inspect(args);
        if (variant === "unknown") throw new Error("metadata unavailable");
        if (variant === "domain")
          value.domains = [{ domain: "existing.example", targetPort: 8080 }];
        if (variant === "variable") value.httpVariables = ["PORT"];
        if (variant === "health") value.healthPath = "/health";
        if (variant === "replicas") value.replicas = 2;
        return value;
      };
      await expect(
        runDeploy("zip", baseDeployOptions(cli, auggyDir, { service: "existing-worker" })),
      ).rejects.toThrow();
      expect(calls.createProject).toHaveLength(0);
      expect(calls.createService).toHaveLength(0);
      expect(calls.setVariable).toHaveLength(0);
      expect(calls.addVolume).toHaveLength(0);
      expect(calls.generateDomain).toBe(0);
      expect(calls.up).toBe(0);
      expect(existsSync(join(agentDir, ".auggy-cloud.json"))).toBe(false);
    },
  );

  test("legacy HTTP target cannot silently become a worker; record remains byte-identical", async () => {
    configureTelegram();
    setCloud(
      "zip",
      {
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        volumeId: "original-volume",
        url: "https://existing.example",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const before = readFileSync(join(agentDir, ".auggy-cloud.json"), "utf8");
    const { cli, calls } = mockRailwayCli();
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(/saved HTTP/);
    expect(readFileSync(join(agentDir, ".auggy-cloud.json"), "utf8")).toBe(before);
    expect(calls.setVariable).toHaveLength(0);
    expect(calls.up).toBe(0);
  });

  test("historical service-name records resolve to actual service and volume IDs on explicit deploy", async () => {
    setCloud(
      "zip",
      {
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "zip",
        volumeId: "original-volume",
        url: "https://existing.example",
        deployedAt: "2026-05-10T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli } = mockRailwayCli();
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    expect(getAgent("zip", { auggyDir })?.cloud).toMatchObject({
      version: 2,
      serviceId: "svc_def",
      volumeId: "volume-observed",
    });
  });

  test.each(["domain", "health"])(
    "HTTP profile cannot silently overwrite conflicting existing %s settings",
    async (variant) => {
      const { cli, calls } = mockRailwayCli();
      const inspect = cli.inspectIngress;
      cli.inspectIngress = async (args) => ({
        ...(await inspect(args)),
        ...(variant === "domain"
          ? { domains: [{ domain: "existing.example", targetPort: 9999 }] }
          : { healthPath: "/other" }),
      });
      await expect(
        runDeploy("zip", baseDeployOptions(cli, auggyDir, { service: "existing" })),
      ).rejects.toThrow(/Existing Railway/);
      expect(calls.addVolume).toHaveLength(0);
      expect(calls.setVariable).toHaveLength(0);
      expect(calls.generateDomain).toBe(0);
    },
  );

  test("disabled checks carry explicit reasons without calling status or health", async () => {
    const { cli, calls } = mockRailwayCli();
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, { deployWait: false, healthCheck: false }),
    );
    expect(result.readiness).toEqual({
      platform: "unverified",
      platformReason: "wait-disabled",
      http: { state: "not-checked", reason: "check-disabled" },
      channel: { state: "unverified" },
    });
    expect(result.health).toBeNull();
    expect(calls.status).toBe(0);
  });

  test("prior successful deployment cannot prove the newly queued deployment ready", async () => {
    const { cli, calls } = mockRailwayCli();
    const inspect = cli.inspectIngress;
    cli.inspectIngress = async (args) => ({
      ...(await inspect(args)),
      latestDeploymentId: "deployment-new",
    });
    let now = 0;
    const result = await runDeploy(
      "zip",
      baseDeployOptions(cli, auggyDir, {
        deployWait: {
          now: () => now,
          timeoutMs: 100,
          intervalMs: 50,
          sleep: async (ms) => {
            now += ms;
          },
        },
        healthCheck: {
          fetch: async () => {
            throw new Error("platform not ready");
          },
        },
      }),
    );
    expect(result.readiness).toMatchObject({
      platform: "timed-out",
      http: { state: "not-attempted", reason: "platform-not-ready" },
    });
    expect(calls.status).toBe(2);
    expect(result.health).toBeNull();
  });

  test("never-settling status is aborted and unknown cleanup blocks the deployment record", async () => {
    const { cli } = mockRailwayCli();
    let signal: AbortSignal | undefined;
    cli.status = async (args) => {
      signal = args.signal;
      return new Promise(() => {});
    };
    await expect(
      runDeploy(
        "zip",
        baseDeployOptions(cli, auggyDir, { deployWait: { timeoutMs: 25, intervalMs: 5 } }),
      ),
    ).rejects.toBeInstanceOf(RailwaySubprocessCleanupError);
    expect(signal?.aborted).toBe(true);
    expect(existsSync(join(agentDir, ".auggy-cloud.json"))).toBe(false);
  });

  test.each(["unknown", "wrong-service", "wrong-environment-query"])(
    "status cannot claim ready without the selected target: %s",
    async (variant) => {
      const { cli } = mockRailwayCli();
      cli.status = async ({ target }) => {
        expect(target?.environmentId).toBe("env-production");
        if (variant === "wrong-environment-query") throw new Error("target changed");
        return {
          project: { id: "proj_abc" },
          service: { id: variant === "wrong-service" ? "svc_other" : "svc_def" },
          deployment: {
            id: "deployment-new",
            status: variant === "unknown" ? "READY_SOMEDAY" : "SUCCESS",
          },
        };
      };
      const result = await runDeploy("zip", baseDeployOptions(cli, auggyDir));
      expect(result.readiness).toMatchObject({
        platform: "unverified",
        platformReason: "status-unavailable",
        channel: { state: "unverified" },
      });
    },
  );

  test.each([NaN, Infinity, 0, -1])(
    "invalid polling options cannot reach Railway: %s",
    async (timeoutMs) => {
      const { cli, calls } = mockRailwayCli();
      await expect(
        runDeploy("zip", baseDeployOptions(cli, auggyDir, { deployWait: { timeoutMs } })),
      ).rejects.toThrow(/durations/);
      expect(calls.checkPresence).toBe(0);
    },
  );

  test("explicit empty config and incompatible ingress cannot trigger fallback or deployment", async () => {
    const { cli, calls } = mockRailwayCli();
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { config: "" })),
    ).rejects.toThrow(/non-empty/);
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { ingress: "none" })),
    ).rejects.toThrow();
    expect(calls.checkPresence).toBe(0);
  });

  test("Railway adaptation changes only the generated entrypoint hash and preserves source/lock bytes", async () => {
    const { cli } = mockRailwayCli();
    const paths = ["package.json", "bun.lock", "agent.yaml"];
    const before = new Map(paths.map((path) => [path, readFileSync(join(agentDir, path), "utf8")]));
    const originalInspect = cli.inspectIngress;
    cli.inspectIngress = async (args) => {
      const manifest = JSON.parse(readFileSync(join(args.cwd, "auggy-deployment.json"), "utf8"));
      const entry = manifest.generatedFiles.find(
        (file: { path: string }) => file.path === "auggy-entrypoint.sh",
      );
      const hash = (text: string) => createHash("sha256").update(text).digest("hex");
      expect(entry.sha256).toBe(hash(generateRailwayEntrypoint()));
      expect(entry.sha256).not.toBe(hash(generatePortableEntrypoint()));
      for (const path of paths) {
        expect(readFileSync(join(args.cwd, path), "utf8")).toBe(before.get(path)!);
        expect(
          manifest.sourceFiles.find((file: { path: string }) => file.path === path).sha256,
        ).toBe(hash(before.get(path)!));
      }
      return originalInspect(args);
    };
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    for (const path of paths)
      expect(readFileSync(join(agentDir, path), "utf8")).toBe(before.get(path)!);
  });

  test("a missing created volume blocks variables, upload and v2 metadata", async () => {
    const { cli, calls } = mockRailwayCli();
    cli.inspectVolume = async () => null;
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /did not verify the new/,
    );
    expect(calls.addVolume).toHaveLength(1);
    expect(calls.setVariable).toHaveLength(0);
    expect(calls.up).toBe(0);
    expect(existsSync(join(agentDir, ".auggy-cloud.json"))).toBe(false);
  });

  test("v2 volume identity mismatch blocks redeploy before hosted changes", async () => {
    const { cli, calls } = mockRailwayCli();
    await runDeploy("zip", baseDeployOptions(cli, auggyDir));
    const before = readFileSync(join(agentDir, ".auggy-cloud.json"), "utf8");
    const previousMutations = calls.setVariable.length;
    cli.inspectVolume = async () => "replacement-volume";
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /volume identity differs/,
    );
    expect(calls.setVariable).toHaveLength(previousMutations);
    expect(calls.up).toBe(1);
    expect(readFileSync(join(agentDir, ".auggy-cloud.json"), "utf8")).toBe(before);
  });

  test("a changed volume after deployment cannot replace the saved cloud record", async () => {
    const { cli } = mockRailwayCli();
    let reads = 0;
    cli.inspectVolume = async () => (++reads === 1 ? "volume-first" : "volume-replaced");
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /volume binding changed/,
    );
    expect(existsSync(join(agentDir, ".auggy-cloud.json"))).toBe(false);
  });

  test("invalid injected clocks fail before Railway access", async () => {
    const { cli, calls } = mockRailwayCli();
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { deployWait: { now: () => NaN } })),
    ).rejects.toThrow(/clock/);
    await expect(
      runDeploy("zip", baseDeployOptions(cli, auggyDir, { healthCheck: { now: () => Infinity } })),
    ).rejects.toThrow(/clock/);
    expect(calls.checkPresence).toBe(0);
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
      serviceId: "svc_new",
    });
  });

  test("plain redeploy can clear saved metadata and restart first-deploy flow", async () => {
    setCloud(
      "zip",
      {
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
      await cli.linkProject({ projectId, cwd });
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
        version: 1,
        agentId: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
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
      await cli.linkProject({ projectId, cwd });
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
    expect(stagedDockerfile).toContain(
      'ENTRYPOINT ["/app/auggy-entrypoint.sh","zip","/app/agent.yaml"]',
    );
    expect(stagedEntrypoint).toMatch(/dev "\$1" --config "\$2" --internal-mode railway/);
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

  test("rejects linked and unpacked Auggy sources before Railway or staging", async () => {
    const path = join(agentDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const missingTarball = "file:../missing-runtime.tgz";
    const sourceDirectory = join(dirname(agentDir), "auggy-source");
    mkdirSync(sourceDirectory, { recursive: true });
    for (const spec of ["link:../auggy", "workspace:*", "file:../auggy-source", missingTarball]) {
      writeFileSync(
        path,
        JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, auggy: spec } }),
      );
      const { cli, calls, capturedCwds } = mockRailwayCli();
      const messages: string[] = [];
      await expect(
        runDeploy(
          "zip",
          baseDeployOptions(cli, auggyDir, {
            logger: { info: (message) => messages.push(message), warn: () => {}, error: () => {} },
          }),
        ),
      ).rejects.toThrow(/Pack the linked\/source runtime and materialize that tarball/);
      expect(calls.checkPresence).toBe(0);
      expect(calls.checkAuth).toBe(0);
      expect(capturedCwds).toEqual([]);
      expect(messages.some((message) => message.includes("Bundle staged"))).toBe(false);
    }
  });

  test("rejects an explicitly selected symlinked runtime archive before Railway", async () => {
    if (process.platform === "win32") return;
    const target = join(dirname(agentDir), "source-runtime.tgz");
    const selected = join(dirname(agentDir), "selected-runtime.tgz");
    writeFileSync(target, "must not be followed");
    symlinkSync(target, selected);
    const path = join(agentDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.dependencies.auggy = "file:../selected-runtime.tgz";
    writeFileSync(path, JSON.stringify(manifest));
    const { cli, calls } = mockRailwayCli();
    await expect(runDeploy("zip", baseDeployOptions(cli, auggyDir))).rejects.toThrow(
      /explicit regular file:/,
    );
    expect(calls.checkPresence).toBe(0);
    expect(calls.checkAuth).toBe(0);
  });

  test("does not replace the project dependency with a nearby same-version artifact", async () => {
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
    expect(stagedTarball).toBe(false);
    const original = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
    expect(stagedAuggyDependency).toBe(original.dependencies.auggy);
    expect(stagedDockerfile).not.toContain(`COPY ["${tarballName}","/app/${tarballName}"]`);
    expect(existsSync(stagingDir!)).toBe(false);
  });

  test("does not vendor a symlinked local runtime tarball", async () => {
    if (process.platform === "win32") return;
    const version = getAuggyVersion();
    const tarballName = `auggy-${version}.tgz`;
    const target = join(dirname(agentDir), "untrusted-runtime-target.tgz");
    writeFileSync(target, "must not enter deploy staging");
    symlinkSync(target, join(dirname(agentDir), tarballName));

    const { cli, calls } = mockRailwayCli();
    let stagedTarball = false;
    cli.linkProject = async (args) => {
      calls.linkProject.push(args);
      stagedTarball = existsSync(join(args.cwd, tarballName));
    };

    await runDeploy("zip", baseDeployOptions(cli, auggyDir));

    expect(stagedTarball).toBe(false);
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
    expect(
      stagedDockerfile!.indexOf(`COPY ["${tarballName}","/app/${tarballName}"]`),
    ).toBeGreaterThan(-1);
    expect(stagedDockerfile!.indexOf("RUN bun install")).toBeGreaterThan(
      stagedDockerfile!.indexOf(`COPY ["${tarballName}","/app/${tarballName}"]`),
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

function writeFixtureLock(dir: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  writeFileSync(
    join(dir, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      workspaces: { "": { name: manifest.name, dependencies: manifest.dependencies } },
      packages: {
        auggy: ["auggy@0.3.1", "", {}, "sha512-fixture"],
        "@auggy/anthropic": ["@auggy/anthropic@0.3.1", "", {}, "sha512-fixture"],
      },
    }),
  );
}
