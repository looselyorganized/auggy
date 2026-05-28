import { describe, test, expect } from "bun:test";
import {
  createRailwayCli,
  RailwayCliMissingError,
  RailwayNotLoggedInError,
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

  test("setVariable runs `railway variables --set KEY=value`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.setVariable({ key: "ANTHROPIC_API_KEY", value: "sk-secret", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "variables", "--set", "ANTHROPIC_API_KEY=sk-secret"]);
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

  test("generateDomain extracts the URL from stdout", async () => {
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
        stdout: "https://zip-production-abcd.up.railway.app\n",
        stderr: callCount > 1 ? "Domain already exists\n" : "",
        exitCode: 0,
      };
    });
    const cli = createRailwayCli({ spawn: factory });
    await cli.generateDomain({ cwd: "/tmp/staging" });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
  });

  test("addVolume runs `railway volume add <name> --mount-path <path>`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.addVolume({ name: "zip-data", mountPath: "/app/data", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual([
      "railway",
      "volume",
      "add",
      "zip-data",
      "--mount-path",
      "/app/data",
    ]);
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
    expect(status.project.id).toBe("proj_abc");
    expect(status.service.id).toBe("svc_def");
    expect(status.deployment.status).toBe("SUCCESS");
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
