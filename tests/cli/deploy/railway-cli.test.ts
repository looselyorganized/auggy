import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRailwayCli,
  RailwayCliMissingError,
  RailwaySubprocessCleanupError,
  RailwayDeploymentPolicyError,
  RailwayNotLoggedInError,
  RailwayWorkspaceRequiredError,
  type RailwaySpawnFactory,
  type RailwayInteractiveSpawnFactory,
} from "../../../src/cli/deploy/railway-cli";

interface MockSpawnCall {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

function mockSpawn(
  responder: (args: string[]) => { stdout: string; stderr: string; exitCode: number },
) {
  const calls: MockSpawnCall[] = [];
  const factory: RailwaySpawnFactory = (cmd, opts = {}) => {
    calls.push({ cmd, cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
    const res = responder(cmd.slice(1));
    return {
      kill: () => {},
      isRunning: () => false,
      exited: Promise.resolve(res.exitCode),
      stdout: new Response(res.stdout).body!,
      stderr: new Response(res.stderr).body!,
    };
  };
  return { factory, calls };
}

describe("railway-cli", () => {
  test("checkPresence returns true on `railway --version` exit 0", async () => {
    const { factory } = mockSpawn(() => ({ stdout: "railway 4.0.0\n", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkPresence()).resolves.toBe(true);
  });

  test("checkPresence throws RailwayCliMissingError on ENOENT", async () => {
    const factory: RailwaySpawnFactory = () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkPresence()).rejects.toBeInstanceOf(RailwayCliMissingError);
  });

  test("checkAuth throws RailwayNotLoggedInError on non-zero exit", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "",
      stderr: "Unauthorized. Run `railway login` first.\n",
      exitCode: 1,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkAuth()).rejects.toBeInstanceOf(RailwayNotLoggedInError);
  });

  test("checkAuth returns the username from `railway whoami` stdout", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "Logged in as alice@example.com\n",
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkAuth()).resolves.toBe("alice@example.com");
  });

  test("linkProject runs `railway link --project` from the given cwd", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.linkProject({ projectId: "proj_abc", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "link", "--project", "proj_abc"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("createProject runs `railway init --name --json` and returns the project id", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: JSON.stringify({ project: { id: "proj_created" } }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const id = await cli.createProject({ projectName: "zip", cwd: "/tmp/staging" });
    expect(id).toBe("proj_created");
    expect(calls[0]!.cmd).toEqual(["railway", "init", "--name", "zip", "--json"]);
  });

  test("listWorkspaces reads workspaces directly from Railway GraphQL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "railway-cli-test-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ user: { accessToken: "railway-token" } }));
      const { factory, calls } = mockSpawn(() => ({
        stdout: "[]",
        stderr: "",
        exitCode: 0,
      }));
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            data: {
              me: {
                workspaces: [
                  { id: "workspace_b", name: "Team B" },
                  { id: "workspace_a", name: "Team A" },
                ],
              },
            },
          }),
        );
      };
      const cli = createRailwayCli({
        spawn: factory,
        fetch: fetchImpl,
        railwayConfigPath: configPath,
      });

      await expect(cli.listWorkspaces()).resolves.toEqual([
        { id: "workspace_a", name: "Team A" },
        { id: "workspace_b", name: "Team B" },
      ]);
      expect(calls).toHaveLength(0);
      expect(fetchCalls[0]?.url).toBe("https://backboard.railway.com/graphql/v2");
      const firstFetch = fetchCalls[0]!;
      const headers = firstFetch.init!.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer railway-token");
      expect(firstFetch.init?.redirect).toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listWorkspaces falls back to `railway list --json` when GraphQL is unavailable", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: JSON.stringify([
        {
          workspace: { id: "workspace_b", name: "Team B" },
          id: "project_1",
          name: "one",
        },
        {
          workspace: { id: "workspace_a", name: "Team A" },
          id: "project_2",
          name: "two",
        },
        {
          workspace: { id: "workspace_b", name: "Team B" },
          id: "project_3",
          name: "three",
        },
      ]),
      stderr: "",
      exitCode: 0,
    }));
    const fetchImpl = async () => {
      throw new Error("network unavailable");
    };
    const cli = createRailwayCli({
      spawn: factory,
      fetch: fetchImpl,
      railwayConfigPath: "/does/not/exist",
    });

    await expect(cli.listWorkspaces()).resolves.toEqual([
      { id: "workspace_a", name: "Team A" },
      { id: "workspace_b", name: "Team B" },
    ]);
    expect(calls[0]!.cmd).toEqual(["railway", "list", "--json"]);
  });

  test("listProjects reads active projects and filters by workspace", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: JSON.stringify([
        {
          workspace: { id: "workspace_b", name: "Team B" },
          id: "project_2",
          name: "two",
          deletedAt: null,
        },
        {
          workspace: { id: "workspace_a", name: "Team A" },
          id: "project_1",
          name: "one",
          deletedAt: null,
        },
        {
          workspace: { id: "workspace_a", name: "Team A" },
          id: "project_deleted",
          name: "deleted",
          deletedAt: "2026-06-18T00:00:00.000Z",
        },
      ]),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });

    await expect(cli.listProjects({ workspace: "workspace_a" })).resolves.toEqual([
      {
        id: "project_1",
        name: "one",
        workspaceId: "workspace_a",
        workspaceName: "Team A",
      },
    ]);
    await expect(cli.listProjects({ workspace: "Team B" })).resolves.toEqual([
      {
        id: "project_2",
        name: "two",
        workspaceId: "workspace_b",
        workspaceName: "Team B",
      },
    ]);
    expect(calls.map((call) => call.cmd)).toEqual([
      ["railway", "list", "--json"],
      ["railway", "list", "--json"],
    ]);
  });

  test("listProjects handles wrapped project lists without treating services as projects", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: JSON.stringify({
        projects: [
          {
            workspace: { id: "workspace_a", name: "Team A" },
            id: "project_1",
            name: "one",
            services: [{ id: "service_1", name: "api" }],
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });

    await expect(cli.listProjects({ workspace: "workspace_a" })).resolves.toEqual([
      {
        id: "project_1",
        name: "one",
        workspaceId: "workspace_a",
        workspaceName: "Team A",
      },
    ]);
  });

  test("createProject includes --workspace when provided", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: JSON.stringify({ project: { id: "proj_created" } }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const id = await cli.createProject({
      projectName: "zip",
      workspace: "looselyorganized",
      cwd: "/tmp/staging",
    });

    expect(id).toBe("proj_created");
    expect(calls[0]!.cmd).toEqual([
      "railway",
      "init",
      "--name",
      "zip",
      "--workspace",
      "looselyorganized",
      "--json",
    ]);
  });

  test("createProject throws a typed workspace error when Railway requires --workspace", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "",
      stderr: "--workspace required in non-interactive mode (multiple workspaces available)",
      exitCode: 1,
    }));
    const cli = createRailwayCli({ spawn: factory });

    await expect(
      cli.createProject({ projectName: "zip", cwd: "/tmp/staging" }),
    ).rejects.toBeInstanceOf(RailwayWorkspaceRequiredError);
  });

  test("createProject falls back to status when init output has no id", async () => {
    let call = 0;
    const { factory } = mockSpawn((args) => {
      call++;
      if (args[0] === "init") return { stdout: "{}", stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({
          project: { id: "proj_status", name: "zip" },
          service: { id: "svc_def", name: "zip" },
          deployment: { status: "SUCCESS" },
        }),
        stderr: "",
        exitCode: 0,
      };
    });
    const cli = createRailwayCli({ spawn: factory });
    const id = await cli.createProject({ projectName: "zip", cwd: "/tmp/staging" });
    expect(id).toBe("proj_status");
    expect(call).toBe(2);
  });

  test("linkService runs `railway service link` from the given cwd", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.linkService({ serviceName: "zip", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "service", "link", "zip"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("link runs project link then service link", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.link({ projectId: "proj_abc", serviceName: "zip", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "link", "--project", "proj_abc"]);
    expect(calls[1]!.cmd).toEqual(["railway", "service", "link", "zip"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
    expect(calls[1]!.cwd).toBe("/tmp/staging");
  });

  test("createService runs `railway add --service` then links it", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.createService({ serviceName: "zip", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "add", "--service", "zip"]);
    expect(calls[1]!.cmd).toEqual(["railway", "service", "link", "zip"]);
  });

  test("setVariable sends the value over stdin and never argv or env", async () => {
    const sentinel = "GROUP9_RAILWAY_SECRET_DO_NOT_LOG=\n雪";
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.setVariable({ key: "ANTHROPIC_API_KEY", value: sentinel, cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual([
      "railway",
      "variable",
      "set",
      "ANTHROPIC_API_KEY",
      "--stdin",
      "--skip-deploys",
    ]);
    expect(calls[0]!.stdin).toBe(sentinel);
    expect(calls[0]!.cmd.join(" ")).not.toContain(sentinel);
    expect(JSON.stringify(calls[0]!.env ?? {})).not.toContain(sentinel);
  });

  test("setVariable returns stable diagnostics for transformed secret echoes", async () => {
    const sentinel = "GROUP9_FIRST_LINE\nSECOND_LINE";
    const { factory } = mockSpawn(() => ({
      stdout: `echoed ${JSON.stringify(sentinel)}`,
      stderr: "failed GROUP9_FIRST_LINE and truncated SECOND_",
      exitCode: 1,
    }));
    const cli = createRailwayCli({ spawn: factory });

    const error = await cli
      .setVariable({ key: "ANTHROPIC_API_KEY", value: sentinel, cwd: "/tmp/staging" })
      .catch((cause) => cause);

    expect(String(error)).not.toContain("GROUP9_FIRST_LINE");
    expect(String(error)).not.toContain("SECOND_LINE");
    expect(String(error)).not.toContain("SECOND_");
    expect(String(error)).toBe(
      "Error: Railway variable update for ANTHROPIC_API_KEY failed with exit code 1.",
    );
  });

  test("setVariable suppresses raw synchronous spawn diagnostics", async () => {
    const sentinel = "GROUP9_RAILWAY_SPAWN_SECRET_DO_NOT_LOG\nSECOND_LINE";
    const factory: RailwaySpawnFactory = () => {
      throw new Error(`spawn rejected ${sentinel}`);
    };
    const cli = createRailwayCli({ spawn: factory });

    const error = await cli
      .setVariable({ key: "ANTHROPIC_API_KEY", value: sentinel, cwd: "/tmp/staging" })
      .catch((cause) => cause);

    expect(String(error)).not.toContain("GROUP9_RAILWAY");
    expect(String(error)).not.toContain("SECOND_LINE");
    expect(String(error)).toBe(
      "Error: Railway variable update for ANTHROPIC_API_KEY failed before completion.",
    );
  });

  test("setVariable rejects malformed keys before spawn", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });

    for (const key of ["", "--service", "A=B", "A\nB"]) {
      await expect(cli.setVariable({ key, value: "secret", cwd: "/tmp/staging" })).rejects.toThrow(
        /variable key/,
      );
    }
    expect(calls).toHaveLength(0);
  });

  test("setVariable retries transient Railway API timeouts", async () => {
    let attempts = 0;
    const { factory, calls } = mockSpawn(() => {
      attempts++;
      if (attempts < 3) {
        return {
          stdout: "",
          stderr:
            "Failed to fetch: error sending request for url (https://backboard.railway.com/graphql/v2)\n\nCaused by:\n    operation timed out\n",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const cli = createRailwayCli({
      spawn: factory,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    await cli.setVariable({ key: "AUGGY_WEB_TOKEN", value: "tok-1", cwd: "/tmp/staging" });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.cmd[1] === "variable" && call.cmd[2] === "set")).toBe(true);
  });

  test("setVariable fails closed after persistent timeouts even when a key preexisted", async () => {
    const { factory, calls } = mockSpawn(() => {
      return {
        stdout: JSON.stringify([{ name: "AUGGY_WEB_TOKEN", value: "old-value" }]),
        stderr:
          "Failed to fetch: error sending request for url (https://backboard.railway.com/graphql/v2)\n\nCaused by:\n    operation timed out\n",
        exitCode: 1,
      };
    });
    const cli = createRailwayCli({
      spawn: factory,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    await expect(
      cli.setVariable({ key: "AUGGY_WEB_TOKEN", value: "tok-1", cwd: "/tmp/staging" }),
    ).rejects.toThrow(/unknown outcome after 3 attempts/);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.cmd[2] === "set")).toBe(true);
  });

  test("up runs `railway up --detach`", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: "Build queued\n",
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.up({ cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "up", "--detach", "--no-gitignore"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("generateDomain runs `railway domain --json` and extracts the URL", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: JSON.stringify({ domain: "zip-production-abcd.up.railway.app" }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
    expect(calls[0]!.cmd).toEqual(["railway", "domain", "--json"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("generateDomain extracts nested URLs from JSON stdout", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: JSON.stringify({
        serviceDomains: [{ domain: "zip-production-abcd.up.railway.app" }],
      }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
  });

  test("generateDomain falls back to extracting the URL from text stdout", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "Domain created: https://zip-production-abcd.up.railway.app\n",
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
  });

  test("generateDomain second call returns the existing URL (idempotent)", async () => {
    let callCount = 0;
    const { factory } = mockSpawn(() => {
      callCount++;
      return {
        stdout: JSON.stringify({ url: "https://zip-production-abcd.up.railway.app" }),
        stderr: callCount > 1 ? "Domain already exists\n" : "",
        exitCode: 0,
      };
    });
    const cli = createRailwayCli({ spawn: factory });
    await cli.generateDomain({ cwd: "/tmp/staging" });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
  });

  test("addVolume runs `railway volume add --mount-path <path>`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.addVolume({ name: "zip-data", mountPath: "/app/data", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "volume", "add", "--mount-path", "/app/data"]);
  });

  test("addVolume retries transient Railway API timeouts", async () => {
    let attempts = 0;
    const { factory, calls } = mockSpawn(() => {
      attempts++;
      if (attempts < 3) {
        return {
          stdout: "",
          stderr:
            "Failed to fetch: error sending request for url (https://backboard.railway.com/graphql/v2)\n\nCaused by:\n    operation timed out\n",
          exitCode: 1,
        };
      }
      return { stdout: 'Volume "zip-data" mounted at /app/data.\n', stderr: "", exitCode: 0 };
    });
    const cli = createRailwayCli({
      spawn: factory,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    await cli.addVolume({ name: "zip-data", mountPath: "/app/data", cwd: "/tmp/staging" });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.cmd)).toEqual([
      ["railway", "volume", "add", "--mount-path", "/app/data"],
      ["railway", "volume", "add", "--mount-path", "/app/data"],
      ["railway", "volume", "add", "--mount-path", "/app/data"],
    ]);
  });

  test("addVolume treats post-mount timeout output as success", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: 'Volume "zip-data" mounted at /app/data.\n',
      stderr:
        "Failed to fetch: error sending request for url (https://backboard.railway.com/graphql/v2)\n\nCaused by:\n    operation timed out\n",
      exitCode: 1,
    }));
    const cli = createRailwayCli({
      spawn: factory,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    await cli.addVolume({ name: "zip-data", mountPath: "/app/data", cwd: "/tmp/staging" });
    expect(calls).toHaveLength(1);
  });

  test("createService tolerates an already-existing service and links it", async () => {
    const { factory, calls } = mockSpawn((args) => {
      if (args[0] === "add") {
        return { stdout: "", stderr: 'Service "zip" already exists\n', exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const cli = createRailwayCli({ spawn: factory });
    await cli.createService({ serviceName: "zip", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "add", "--service", "zip"]);
    expect(calls[1]!.cmd).toEqual(["railway", "service", "link", "zip"]);
  });

  test("non-transient Railway command errors are not retried", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: "",
      stderr: "error: unexpected argument '--bad' found\n",
      exitCode: 2,
    }));
    const cli = createRailwayCli({
      spawn: factory,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    await expect(
      cli.addVolume({ name: "zip-data", mountPath: "/app/data", cwd: "/tmp/staging" }),
    ).rejects.toThrow(/unexpected argument/);
    expect(calls).toHaveLength(1);
  });

  test("status returns parsed JSON from `railway status --json`", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: JSON.stringify({
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status: "SUCCESS" },
      }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const status = await cli.status({ cwd: "/tmp/staging" });
    expect(status.project?.id).toBe("proj_abc");
    expect(status.service?.id).toBe("svc_def");
    expect(status.deployment?.status).toBe("SUCCESS");
  });

  test("destroyService runs `railway service delete --yes`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.destroyService({ cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "service", "delete", "--yes"]);
  });

  test("logs streams `railway logs` from the given cwd", async () => {
    const calls: MockSpawnCall[] = [];
    const interactiveSpawn: RailwayInteractiveSpawnFactory = (cmd, opts = {}) => {
      calls.push({ cmd, cwd: opts.cwd, env: opts.env });
      return { exited: Promise.resolve(0) };
    };
    const { factory } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory, interactiveSpawn });
    await cli.logs({ cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "logs"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("logs surfaces a non-zero exit", async () => {
    const interactiveSpawn: RailwayInteractiveSpawnFactory = () => ({
      exited: Promise.resolve(1),
    });
    const { factory } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory, interactiveSpawn });
    await expect(cli.logs({ cwd: "/tmp/staging" })).rejects.toThrow(/railway logs exited 1/);
  });

  test("non-zero exit surfaces stderr in the error message", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "",
      stderr: "Project not found\n",
      exitCode: 1,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.up({ cwd: "/tmp/staging" })).rejects.toThrow(/Project not found/);
  });
});

// Projection fixtures match railwayapp/cli v5.30.1 variable.rs/domain.rs/config.rs
// and the documented serviceInstance query. No fixture performs Railway I/O.
const linkedTarget = {
  projectId: "project-1",
  serviceId: "service-1",
  environmentId: "environment-1",
};
const linkedVariables = {
  RAILWAY_PROJECT_ID: "project-1",
  RAILWAY_SERVICE_ID: "service-1",
  RAILWAY_ENVIRONMENT_ID: "environment-1",
  PRIVATE_TOKEN: "NEVER_PRINT_PRIVATE_TOKEN",
  PORT: "8080",
};
const serviceMetadata = {
  data: {
    serviceInstance: {
      serviceName: "agent",
      buildCommand: null,
      builder: "RAILPACK",
      dockerfilePath: null,
      preDeployCommand: null,
      railwayConfigFile: null,
      rootDirectory: null,
      startCommand: null,
      cronSchedule: null,
      healthcheckPath: "/health",
      numReplicas: 1,
      latestDeployment: { id: "deployment-1", status: "SUCCESS" },
    },
  },
};

async function withLinkedFixture(
  run: (args: { cwd: string; configPath: string }) => Promise<void>,
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "railway-linked-fixture-")));
  const configPath = join(cwd, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      projects: {
        [cwd]: {
          projectPath: cwd,
          project: linkedTarget.projectId,
          service: linkedTarget.serviceId,
          environment: linkedTarget.environmentId,
        },
      },
      user: { accessToken: "PRIVATE_AUTH_TOKEN" },
    }),
  );
  try {
    await run({ cwd, configPath });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function ingressResponder(args: string[]) {
  const value =
    args[0] === "variable"
      ? linkedVariables
      : args[0] === "domain"
        ? {
            domains: [
              {
                id: "domain-1",
                domain: "agent.up.railway.app",
                type: "service",
                targetPort: 8080,
                syncStatus: "ACTIVE",
              },
            ],
          }
        : serviceMetadata;
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}

describe("bounded Railway metadata", () => {
  test("inspects only the exact linked service/environment and projects no secrets", async () => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory, calls } = mockSpawn(ingressResponder);
      const cli = createRailwayCli({ spawn: factory, railwayConfigPath: configPath });
      const result = await cli.inspectIngress({ cwd });
      expect(result).toEqual({
        ...linkedTarget,
        serviceName: "agent",
        domains: [{ domain: "agent.up.railway.app", targetPort: 8080 }],
        httpVariables: ["PORT"],
        healthPath: "/health",
        replicas: 1,
        latestDeploymentId: "deployment-1",
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(calls[0]?.cmd).toEqual([
        "railway",
        "variable",
        "list",
        "--project",
        "project-1",
        "--service",
        "service-1",
        "--environment",
        "environment-1",
        "--json",
      ]);
      expect(calls[1]?.cmd).toEqual([
        "railway",
        "domain",
        "list",
        "--project",
        "project-1",
        "--service",
        "service-1",
        "--environment",
        "environment-1",
        "--json",
      ]);
      expect(calls[2]?.cmd).toContain(
        JSON.stringify({ serviceId: "service-1", environmentId: "environment-1" }),
      );
    });
  });

  test("targeted readiness queries the selected environment rather than the project's first deployment", async () => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory, calls } = mockSpawn(ingressResponder);
      const cli = createRailwayCli({ spawn: factory, railwayConfigPath: configPath });
      expect(await cli.status({ cwd, target: linkedTarget })).toEqual({
        project: { id: "project-1" },
        service: { id: "service-1" },
        deployment: { id: "deployment-1", status: "SUCCESS" },
      });
      expect(calls[0]?.cmd[1]).toBe("api");
      await expect(
        cli.status({ cwd, target: { ...linkedTarget, environmentId: "other-env" } }),
      ).rejects.toThrow(/target changed/);
      expect(calls).toHaveLength(1);
    });
  });

  test.each([
    "variable-target",
    "variable-shape",
    "domain-port",
    "domain-shape",
    "api-errors",
    "api-replicas",
    "api-health",
  ])("rejects unavailable or malformed ingress metadata: %s", async (variant) => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory } = mockSpawn((args) => {
        const result = ingressResponder(args);
        const value = JSON.parse(result.stdout);
        if (args[0] === "variable" && variant === "variable-target")
          value.RAILWAY_ENVIRONMENT_ID = "other-env";
        if (args[0] === "variable" && variant === "variable-shape") value.PRIVATE_TOKEN = 42;
        if (args[0] === "domain" && variant === "domain-port") value.domains[0].targetPort = "8080";
        if (args[0] === "domain" && variant === "domain-shape") delete value.domains;
        if (args[0] === "api" && variant === "api-errors")
          value.errors = [{ message: "PRIVATE_GRAPHQL_ERROR" }];
        if (args[0] === "api" && variant === "api-replicas")
          value.data.serviceInstance.numReplicas = "1";
        if (args[0] === "api" && variant === "api-health")
          value.data.serviceInstance.healthcheckPath = "//attacker.example";
        return { ...result, stdout: JSON.stringify(value) };
      });
      try {
        await createRailwayCli({ spawn: factory, railwayConfigPath: configPath }).inspectIngress({
          cwd,
        });
        throw new Error("unexpected acceptance");
      } catch (error) {
        expect((error as Error).message).not.toContain("PRIVATE");
        expect((error as Error).message).not.toBe("unexpected acceptance");
      }
    });
  });

  test("rejects unlinked and ambient targets without starting a metadata subprocess", async () => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory, calls } = mockSpawn(ingressResponder);
      const cli = createRailwayCli({ spawn: factory, railwayConfigPath: configPath });
      const previous = process.env.RAILWAY_ENVIRONMENT_ID;
      process.env.RAILWAY_ENVIRONMENT_ID = "other-env";
      try {
        await expect(cli.inspectIngress({ cwd })).rejects.toThrow(/Unset RAILWAY_ENVIRONMENT_ID/);
      } finally {
        if (previous === undefined) delete process.env.RAILWAY_ENVIRONMENT_ID;
        else process.env.RAILWAY_ENVIRONMENT_ID = previous;
      }
      writeFileSync(configPath, JSON.stringify({ projects: {} }));
      await expect(cli.inspectIngress({ cwd })).rejects.toThrow(/linked project/);
      expect(calls).toHaveLength(0);
    });
  });

  test.each(["null", "[]", "42", "bad-json"])(
    "rejects malformed status JSON without echoing raw output: %s",
    async (stdout) => {
      const { factory } = mockSpawn(() => ({ stdout, stderr: "PRIVATE_STDERR", exitCode: 0 }));
      await expect(createRailwayCli({ spawn: factory }).status({ cwd: "/tmp" })).rejects.toThrow(
        /metadata read failed/,
      );
    },
  );

  test.each([0, -1, NaN, Infinity, 15001])(
    "rejects invalid request duration before spawn: %s",
    async (timeoutMs) => {
      const { factory, calls } = mockSpawn(ingressResponder);
      await expect(
        createRailwayCli({ spawn: factory }).status({ cwd: "/tmp", timeoutMs }),
      ).rejects.toThrow(/timeout/);
      expect(calls).toHaveLength(0);
    },
  );

  test("cancels without spawning when the caller is already aborted", async () => {
    const { factory, calls } = mockSpawn(ingressResponder);
    await expect(
      createRailwayCli({ spawn: factory }).status({ cwd: "/tmp", signal: AbortSignal.abort() }),
    ).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(0);
  });

  test.each(["hang", "output-flood", "stderr-flood", "abort"])(
    "kills and reaps a real bounded subprocess: %s",
    async (variant) => {
      let reaped = false;
      let killed = false;
      const script =
        variant === "output-flood"
          ? 'while (true) process.stdout.write("x".repeat(65536));'
          : variant === "stderr-flood"
            ? 'process.stdout.write("x".repeat(600000)); while (true) process.stderr.write("x".repeat(65536));'
            : "setInterval(() => {}, 1000);";
      const factory: RailwaySpawnFactory = () => {
        const child = Bun.spawn([process.execPath, "-e", script], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          exited: child.exited.then((code) => {
            reaped = true;
            return code;
          }),
          isRunning: () => !reaped,
          kill(signal) {
            killed = true;
            child.kill(signal);
          },
        };
      };
      const controller = new AbortController();
      const timer = variant === "abort" ? setTimeout(() => controller.abort(), 25) : undefined;
      const start = performance.now();
      try {
        await expect(
          createRailwayCli({ spawn: factory }).status({
            cwd: "/tmp",
            timeoutMs: variant.includes("flood") ? 1000 : 150,
            signal: controller.signal,
          }),
        ).rejects.toThrow(/metadata read failed/);
        expect(killed).toBe(true);
        expect(reaped).toBe(true);
        expect(performance.now() - start).toBeLessThan(variant.includes("flood") ? 1500 : 500);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  );

  test("generates an HTTP domain for the actual selected listener port", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: JSON.stringify({ domain: "agent.up.railway.app" }),
      stderr: "",
      exitCode: 0,
    }));
    await createRailwayCli({ spawn: factory }).generateDomain({ cwd: "/tmp", port: 8081 });
    expect(calls[0]?.cmd).toEqual(["railway", "domain", "--port", "8081", "--json"]);
  });
});

describe("Railway durable volume provenance", () => {
  const volumeNode = {
    serviceId: "service-1",
    environmentId: "environment-1",
    mountPath: "/app/data",
    state: "READY",
    isPendingDeletion: false,
    deletedAt: null,
    volume: { id: "volume-observed" },
  };
  function volumeResponse(
    nodes: unknown[] = [volumeNode],
    hasNextPage = false,
    id = "environment-1",
  ) {
    return {
      data: {
        environment: {
          id,
          volumeInstances: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage } },
        },
      },
    };
  }
  test("returns only an actual volume bound to the exact service/environment and /app/data", async () => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory, calls } = mockSpawn(() => ({
        stdout: JSON.stringify(
          volumeResponse([
            { ...volumeNode, serviceId: "other-service", volume: { id: "other-volume" } },
            volumeNode,
          ]),
        ),
        stderr: "",
        exitCode: 0,
      }));
      expect(
        await createRailwayCli({ spawn: factory, railwayConfigPath: configPath }).inspectVolume({
          cwd,
          target: linkedTarget,
        }),
      ).toBe("volume-observed");
      expect(calls[0]?.cmd).toContain(
        JSON.stringify({ projectId: "project-1", environmentId: "environment-1" }),
      );
      expect(calls[0]?.cmd[2]).toContain("volumeInstances(first: 500)");
    });
  });
  test("reports verified absence without inventing a volume name", async () => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory } = mockSpawn(() => ({
        stdout: JSON.stringify(volumeResponse([])),
        stderr: "",
        exitCode: 0,
      }));
      expect(
        await createRailwayCli({ spawn: factory, railwayConfigPath: configPath }).inspectVolume({
          cwd,
          target: linkedTarget,
        }),
      ).toBeNull();
    });
  });
  test.each([
    "duplicate",
    "ambiguous",
    "wrong-environment",
    "wrong-mount",
    "not-ready",
    "deleting",
    "deleted",
    "more-pages",
    "missing-connection",
    "wrong-response-environment",
  ])("refuses unsafe volume metadata: %s", async (variant) => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const nodes = [structuredClone(volumeNode)];
      if (variant === "duplicate") nodes.push(structuredClone(volumeNode));
      if (variant === "ambiguous") nodes.push({ ...volumeNode, volume: { id: "second-volume" } });
      if (variant === "wrong-environment") nodes[0]!.environmentId = "other-environment";
      if (variant === "wrong-mount") nodes[0]!.mountPath = "/tmp";
      if (variant === "not-ready") nodes[0]!.state = "RESTORING";
      if (variant === "deleting") nodes[0]!.isPendingDeletion = true;
      const value = volumeResponse(
        nodes,
        variant === "more-pages",
        variant === "wrong-response-environment" ? "other-env" : "environment-1",
      );
      if (variant === "deleted") Object.assign(nodes[0]!, { deletedAt: "2026-11-01T00:00:00Z" });
      if (variant === "missing-connection")
        Object.assign(value.data.environment, { volumeInstances: null });
      const { factory } = mockSpawn(() => ({
        stdout: JSON.stringify(value),
        stderr: "",
        exitCode: 0,
      }));
      await expect(
        createRailwayCli({ spawn: factory, railwayConfigPath: configPath }).inspectVolume({
          cwd,
          target: linkedTarget,
        }),
      ).rejects.toThrow(/volume/);
    });
  });
});

describe("managed Railway build selection", () => {
  test.each([
    "buildCommand",
    "startCommand",
    "preDeployCommand",
    "railwayConfigFile",
    "rootDirectory",
    "dockerfilePath",
    "builder",
    "cronSchedule",
    "numReplicas",
  ])("rejects an effective service %s override without exposing its value", async (field) => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory } = mockSpawn((args) => {
        const result = ingressResponder(args);
        if (args[0] !== "api") return result;
        const value = JSON.parse(result.stdout);
        value.data.serviceInstance[field] =
          field === "numReplicas"
            ? 2
            : field === "preDeployCommand"
              ? ["PRIVATE_OVERRIDE"]
              : "PRIVATE_OVERRIDE";
        return { ...result, stdout: JSON.stringify(value) };
      });
      const cli = createRailwayCli({ spawn: factory, railwayConfigPath: configPath });
      for (const operation of [
        () => cli.inspectIngress({ cwd }),
        () => cli.status({ cwd, target: linkedTarget }),
      ]) {
        try {
          await operation();
          throw new Error("unexpected acceptance");
        } catch (error) {
          expect(error).toBeInstanceOf(RailwayDeploymentPolicyError);
          expect((error as Error).message).not.toContain("PRIVATE_OVERRIDE");
        }
      }
    });
  });

  test.each([
    "RAILWAY_DOCKERFILE_PATH",
    "RAILPACK_START_CMD",
    "NIXPACKS_BUILD_CMD",
    "RAILWAY_RUN_UID",
  ])("rejects remote %s control variables before build selection", async (key) => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory, calls } = mockSpawn((args) => {
        const result = ingressResponder(args);
        if (args[0] === "variable")
          result.stdout = JSON.stringify({ ...linkedVariables, [key]: "PRIVATE_OVERRIDE" });
        return result;
      });
      await expect(
        createRailwayCli({ spawn: factory, railwayConfigPath: configPath }).inspectIngress({ cwd }),
      ).rejects.toBeInstanceOf(RailwayDeploymentPolicyError);
      expect(calls).toHaveLength(1);
    });
  });

  test("missing control fields are unknown, never default-safe", async () => {
    await withLinkedFixture(async ({ cwd, configPath }) => {
      const { factory } = mockSpawn((args) => {
        const result = ingressResponder(args);
        if (args[0] === "api") {
          const value = JSON.parse(result.stdout);
          delete value.data.serviceInstance.railwayConfigFile;
          result.stdout = JSON.stringify(value);
        }
        return result;
      });
      await expect(
        createRailwayCli({ spawn: factory, railwayConfigPath: configPath }).inspectIngress({ cwd }),
      ).rejects.toBeInstanceOf(RailwayDeploymentPolicyError);
    });
  });
});

describe("owned Railway npm wrapper groups", () => {
  test("only bounded metadata reads request a separately owned process group", async () => {
    const requests: Array<boolean | undefined> = [];
    const factory: RailwaySpawnFactory = (_cmd, opts) => {
      requests.push(opts?.ownedProcessGroup);
      return {
        exited: Promise.resolve(0),
        stdout: new Response("{}").body!,
        stderr: new Response("").body!,
        kill() {},
        isRunning: () => false,
      };
    };
    const cli = createRailwayCli({ spawn: factory });
    await cli.checkPresence();
    await cli.status({ cwd: "/tmp" });
    expect(requests).toEqual([undefined, true]);
  });
  test.each(["timeout", "abort", "stdout-overflow", "stderr-overflow"])(
    "default spawn kills and drains every started wrapper-group member on %s",
    async (variant) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "railway-wrapper-group-")));
      const wrapperPidPath = join(dir, "wrapper.pid");
      const nativePidPath = join(dir, "native.pid");
      const previousPath = process.env.PATH;
      const nativeScript =
        `require("node:fs").writeFileSync(${JSON.stringify(nativePidPath)}, String(process.pid));` +
        (variant === "stdout-overflow"
          ? 'while(true) require("node:fs").writeSync(1, Buffer.alloc(65536, 120));'
          : variant === "stderr-overflow"
            ? 'while(true) require("node:fs").writeSync(2, Buffer.alloc(65536, 120));'
            : "setInterval(() => {}, 1000);");
      writeFileSync(
        join(dir, "railway"),
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(wrapperPidPath)},String(process.pid));require("node:child_process").execFileSync(process.execPath,["-e",${JSON.stringify(nativeScript)}],{stdio:"inherit"});\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${dir}:${previousPath}`;
      const controller = new AbortController();
      let abortTimer: ReturnType<typeof setInterval> | undefined;
      if (variant === "abort")
        abortTimer = setInterval(() => {
          if (existsSync(nativePidPath)) controller.abort();
        }, 10);
      const start = performance.now();
      const overflow = variant.endsWith("overflow");
      try {
        await expect(
          createRailwayCli().status({
            cwd: dir,
            timeoutMs: overflow ? 4000 : 2000,
            signal: controller.signal,
          }),
        ).rejects.toThrow(/metadata read failed/);
        expect(performance.now() - start).toBeLessThan(overflow ? 3000 : 2600);
        for (const path of [wrapperPidPath, nativePidPath]) {
          // The timeout includes process startup: on a busy runner it can fire
          // before Node writes a PID. Abort/overflow still require both PIDs,
          // proving cleanup of a running wrapper AND its native child.
          if (variant === "timeout" && !existsSync(path)) continue;
          const pid = Number(readFileSync(path, "utf8"));
          expect(Number.isInteger(pid)).toBe(true);
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally {
        if (abortTimer !== undefined) clearInterval(abortTimer);
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        for (const path of [nativePidPath, wrapperPidPath]) {
          if (existsSync(path)) {
            try {
              process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
            } catch {}
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("unknown group cleanup is a fatal typed error rather than an unavailable status", async () => {
    const factory: RailwaySpawnFactory = () => ({
      exited: Promise.resolve(0),
      stdout: new Response("{}").body!,
      stderr: new Response("").body!,
      kill() {},
      isRunning: () => true,
    });
    await expect(
      createRailwayCli({ spawn: factory }).status({ cwd: "/tmp", timeoutMs: 25 }),
    ).rejects.toBeInstanceOf(RailwaySubprocessCleanupError);
  });
});
