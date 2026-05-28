import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  doctorCommand,
  formatDoctorChecks,
  hasDoctorFailures,
  runDoctor,
  type DoctorCheck,
} from "../../../src/cli/commands/doctor";

let auggyDir: string;
let originalWebToken: string | undefined;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "doctor-test-auggy-"));
  originalWebToken = process.env.AUGGY_WEB_TOKEN;
  delete process.env.AUGGY_WEB_TOKEN;
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  if (originalWebToken === undefined) delete process.env.AUGGY_WEB_TOKEN;
  else process.env.AUGGY_WEB_TOKEN = originalWebToken;
});

function agentDirFor(name: string): string {
  return join(auggyDir, "agents", name);
}

function writeAgent(
  name: string,
  opts: {
    provider?: "anthropic" | "openai";
    port?: number;
    token?: string;
    includePackageJson?: boolean;
    installDeps?: boolean;
    installSkill?: boolean;
  } = {},
): string {
  const provider = opts.provider ?? "anthropic";
  const dir = agentDirFor(name);
  mkdirSync(dir, { recursive: true });

  const envToken = opts.token ?? "tok-test";
  writeFileSync(join(dir, ".env"), `AUGGY_WEB_TOKEN=${envToken}\n`);

  const config = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name,
    engine: {
      provider,
      model: provider === "openai" ? "gpt-5" : "claude-sonnet-4-6",
    },
    augments: [
      {
        name: "web",
        type: "webTransport",
        options: {
          port: opts.port ?? 18080,
          auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        },
      },
      {
        name: "fetch",
        type: "webFetch",
        options: { timeoutMs: 15000 },
      },
    ],
  };
  writeFileSync(join(dir, "agent.yaml"), stringify(config));

  if (opts.includePackageJson !== false) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `auggy-agent-${name}`,
          private: true,
          type: "module",
          dependencies: {
            auggy: "^0.0.0",
            [provider === "openai" ? "@auggy/openai" : "@auggy/anthropic"]: "^0.0.0",
          },
        },
        null,
        2,
      ),
    );
  }

  if (opts.installDeps) {
    mkdirSync(join(dir, "node_modules", "auggy"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@auggy", provider), { recursive: true });
  }

  if (opts.installSkill) {
    mkdirSync(join(dir, "skills", "web-fetch"), { recursive: true });
    writeFileSync(join(dir, "skills", "web-fetch", "SKILL.md"), "---\nname: web-fetch\n---\n");
  }

  return dir;
}

describe("runDoctor", () => {
  test("passes a ready local scaffold", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    expect(hasDoctorFailures(checks)).toBe(false);
    expect(checks.some((c) => c.name === "agent.yaml" && c.status === "pass")).toBe(true);
    expect(checks.some((c) => c.name === "dependency auggy" && c.status === "pass")).toBe(true);
    expect(checks.some((c) => c.name === "port 18080" && c.status === "pass")).toBe(true);
  });

  test("fails when the agent cannot be resolved", async () => {
    const checks = await runDoctor("ghost", { auggyDir });

    expect(hasDoctorFailures(checks)).toBe(true);
    expect(checks[0]?.name).toBe("config path");
    expect(checks[0]?.status).toBe("fail");
    expect(checks[0]?.fix).toContain("auggy create ghost");
  });

  test("surfaces missing env placeholders as an agent.yaml failure", async () => {
    const dir = writeAgent("zip", { installDeps: true });
    writeFileSync(join(dir, ".env"), "AUGGY_WEB_TOKEN=\n");

    const checks = await runDoctor("zip", { auggyDir });

    expect(hasDoctorFailures(checks)).toBe(true);
    const config = checks.find((c) => c.name === "agent.yaml");
    expect(config?.status).toBe("fail");
    expect(config?.message).toContain("AUGGY_WEB_TOKEN");
    expect(config?.message).toContain(".env");
  });

  test("fails when package.json is missing", async () => {
    writeAgent("zip", { includePackageJson: false });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const pkg = checks.find((c) => c.name === "package.json");
    expect(pkg?.status).toBe("fail");
    expect(pkg?.fix).toContain("package.json");
  });

  test("fails when agent-local dependencies are missing", async () => {
    writeAgent("zip", { installDeps: false });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const dep = checks.find((c) => c.name === "dependency @auggy/anthropic");
    expect(dep?.status).toBe("fail");
    expect(dep?.fix).toContain("bun install");
  });

  test("fails when the webTransport port is unavailable", async () => {
    writeAgent("zip", { installDeps: true, installSkill: true, port: 19090 });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async (port) => port !== 19090,
    });

    const port = checks.find((c) => c.name === "port 19090");
    expect(port?.status).toBe("fail");
    expect(port?.fix).toContain("19090");
  });

  test("warns when a bundled skill is missing", async () => {
    writeAgent("zip", { installDeps: true, installSkill: false });

    const checks = await runDoctor("zip", {
      auggyDir,
      isPortAvailable: async () => true,
    });

    const skill = checks.find((c) => c.name === "skill web-fetch");
    expect(skill?.status).toBe("warn");
    expect(skill?.fix).toContain("add-skill web-fetch");
    expect(hasDoctorFailures(checks)).toBe(false);
  });
});

describe("doctor formatting and command", () => {
  test("formatDoctorChecks prints status, message, and fix", () => {
    const text = formatDoctorChecks([
      { name: "config", status: "pass", message: "ok" },
      { name: "dep", status: "fail", message: "missing", fix: "run bun install" },
    ]);

    expect(text).toContain("PASS config: ok");
    expect(text).toContain("FAIL dep: missing");
    expect(text).toContain("fix: run bun install");
  });

  test("doctor command exits 1 when checks fail", async () => {
    const run = mock(async (): Promise<DoctorCheck[]> => [
      { name: "dep", status: "fail", message: "missing" },
    ]);
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = doctorCommand({ runDoctor: run, exit });
      await cmd.parseAsync(["zip"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    expect(run).toHaveBeenCalledWith("zip", { config: undefined });
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).toContain("FAIL dep");
  });
});
