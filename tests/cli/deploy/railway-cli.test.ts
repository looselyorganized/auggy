import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRailwayCli,
  RailwayCliMissingError,
  RailwayNotLoggedInError,
  RailwayWorkspaceRequiredError,
  type RailwaySpawnFactory,
  type RailwayInteractiveSpawnFactory,
} from "../../../src/cli/deploy/railway-cli";

interface MockSpawnCall {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

function mockSpawn(
  responder: (args: string[]) => { stdout: string; stderr: string; exitCode: number },
) {
  const calls: MockSpawnCall[] = [];
  const factory: RailwaySpawnFactory = (cmd, opts = {}) => {
    calls.push({ cmd, cwd: opts.cwd, env: opts.env });
    const res = responder(cmd.slice(1));
    return {
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

  test("setVariable runs `railway variable set KEY=value --skip-deploys`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.setVariable({ key: "ANTHROPIC_API_KEY", value: "sk-secret", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual([
      "railway",
      "variable",
      "set",
      "ANTHROPIC_API_KEY=sk-secret",
      "--skip-deploys",
    ]);
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

  test("setVariable verifies key presence after a persistent transient timeout", async () => {
    const { factory, calls } = mockSpawn((args) => {
      if (args[0] === "variable" && args[1] === "list") {
        return {
          stdout: JSON.stringify([{ name: "AUGGY_WEB_TOKEN" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: "",
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
    await cli.setVariable({ key: "AUGGY_WEB_TOKEN", value: "tok-1", cwd: "/tmp/staging" });
    expect(calls.map((call) => call.cmd)).toEqual([
      ["railway", "variable", "set", "AUGGY_WEB_TOKEN=tok-1", "--skip-deploys"],
      ["railway", "variable", "set", "AUGGY_WEB_TOKEN=tok-1", "--skip-deploys"],
      ["railway", "variable", "set", "AUGGY_WEB_TOKEN=tok-1", "--skip-deploys"],
      ["railway", "variable", "list", "--json"],
    ]);
  });

  test("setVariable throws after transient timeout when verification cannot find the key", async () => {
    const { factory, calls } = mockSpawn((args) => {
      if (args[0] === "variable" && args[1] === "list") {
        return { stdout: JSON.stringify([{ name: "OTHER_KEY" }]), stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
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
    ).rejects.toThrow(/operation timed out/);
    expect(calls).toHaveLength(4);
  });

  test("up runs `railway up --detach`", async () => {
    const { factory, calls } = mockSpawn(() => ({
      stdout: "Build queued\n",
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.up({ cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "up", "--detach"]);
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
