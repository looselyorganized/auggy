import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(ROOT, "src", "scaffold-starter-skills", "auggy", "scripts");

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryProject(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  temporaryDirectories.push(dir);
  return dir;
}

describe("auggy builder skill helper scripts", () => {
  test("detect-auggy-env distinguishes owned source and legacy folders without auggy", async () => {
    const dir = temporaryProject("auggy-skill-detect-");
    writeFileSync(join(dir, "agent.yaml"), "name: test-agent\naugments: []\n");
    mkdirSync(join(dir, "src", "augments"), { recursive: true });
    mkdirSync(join(dir, "augments", "webTransport"), { recursive: true });

    const result = await runScript(join(SCRIPTS, "detect-auggy-env.sh"), [], {
      cwd: dir,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("auggy: missing");
    expect(result.stdout).toContain("agent: agent.yaml present");
    expect(result.stdout).toContain("custom source: src/augments present");
    expect(result.stdout).toContain("legacy source: augments present");
    expect(result.stdout).toContain(
      "passive: bash skills/auggy/scripts/summarize-auggy-project.sh",
    );
    expect(result.stdout).toContain("executable route inventory: auggy routes");
  });

  test("summary invokes the real local CLI without executing application or custom source", async () => {
    const dir = temporaryProject("auggy-skill-real summary-");
    const marker = join(dir, "executed-project-code");
    const config = [
      "name: test-agent",
      "application: { entrypoint: ./src/index.ts, contractVersion: 1 }",
      "augments:",
      "  - name: services",
      "    type: custom",
      "    source: ./src/augments/services/index.ts",
      "    options:",
      "      token: inline-private-canary",
      "      apiKey: ${UNSET_HELPER_API_KEY}",
      "",
    ].join("\n");
    writeFileSync(join(dir, "agent.yaml"), config);
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"auggy":"0.5.0"}}');
    writeFileSync(join(dir, ".env"), "UNSET_HELPER_API_KEY=env-private-canary\n");
    mkdirSync(join(dir, "node_modules"));
    // A linked installation runs this checkout's actual CLI, not a report stub.
    symlinkSync(ROOT, join(dir, "node_modules", "auggy"));
    mkdirSync(join(dir, "src", "augments", "services"), { recursive: true });
    const trap = `await Bun.write(${JSON.stringify(marker)}, "executed"); throw new Error("PROJECT_CODE_EXECUTED");`;
    writeFileSync(join(dir, "src", "index.ts"), trap);
    writeFileSync(join(dir, "src", "augments", "services", "index.ts"), trap);
    // Bun must not run project-level preloads before entering passive inspection.
    writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(join(dir, "preload.ts"), trap);

    const result = await runScript(join(SCRIPTS, "summarize-auggy-project.sh"), [dir], {
      cwd: dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Inspection: (complete|partial)/);
    expect(result.stdout).toContain("Application: application");
    expect(result.stdout).toContain("Augment 1: services (custom)");
    expect(result.stdout).toContain(join(dir, "src", "augments", "services", "index.ts"));
    expect(result.stdout).toContain("environment references: UNSET_HELPER_API_KEY");
    expect(result.stdout).toContain("Runtime discovery: not-evaluated");
    expect(result.stdout).not.toContain("inline-private-canary");
    expect(result.stdout).not.toContain("env-private-canary");
    expect(result.stderr).toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, ".auggy"))).toBe(false);
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(config);
  });

  test("summary disables Bun environment and configuration loading and forwards the exact local arguments", async () => {
    const dir = temporaryProject("auggy-skill-env probe-");
    const cli = join(dir, "node_modules", "auggy", "src", "cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "name: test-agent\n");
    writeFileSync(join(dir, ".env"), "AUGGY_HELPER_ENV_CANARY=must-not-be-loaded\n");
    // This probe measures wrapper arguments and Bun loading, not runtime inspection.
    writeFileSync(
      join(cli, "index.ts"),
      "console.log(JSON.stringify({ args: process.argv.slice(2), runtimeArguments: process.execArgv, loaded: process.env.AUGGY_HELPER_ENV_CANARY ?? null }));",
    );

    const result = await runScript(join(SCRIPTS, "summarize-auggy-project.sh"), [dir], {
      cwd: dir,
      env: { ...process.env, AUGGY_HELPER_ENV_CANARY: undefined },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["inspect", "--config", join(dir, "agent.yaml")],
      runtimeArguments: ["--no-env-file", "--no-install", "--config=/dev/null"],
      loaded: null,
    });
  });

  test("summary fails without a local dependency instead of reading configuration values itself", async () => {
    const dir = temporaryProject("auggy-skill-uninstalled-");
    writeFileSync(join(dir, "agent.yaml"), "name: test-agent\npassword: config-private-canary\n");
    writeFileSync(join(dir, ".env"), "API_KEY=env-private-canary\n");

    const result = await runScript(join(SCRIPTS, "summarize-auggy-project.sh"), [dir], {
      cwd: dir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("project-local Auggy dependency");
    expect(result.stderr).not.toContain("private-canary");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  test("doctor and client scripts call auggy with expected arguments", async () => {
    const dir = temporaryProject("auggy-skill-fake-cli-");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "auggy"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$AUGGY_CALL_LOG"',
        'if [ "$1" = "--version" ]; then printf "0.5.0\\n"; fi',
      ].join("\n"),
    );
    chmodSync(join(bin, "auggy"), 0o755);

    const callLog = join(dir, "calls.log");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AUGGY_CALL_LOG: callLog,
    };

    const doctor = await runScript(join(SCRIPTS, "doctor-and-routes.sh"), ["demo"], {
      cwd: dir,
      env,
    });
    expect(doctor.exitCode).toBe(0);

    const clients = await runScript(
      join(SCRIPTS, "generate-route-clients.sh"),
      ["src/auggy-client.ts", "src/auggy-client.server.ts", "demo"],
      { cwd: dir, env },
    );
    expect(clients.exitCode).toBe(0);

    const calls = await Bun.file(callLog).text();
    expect(calls).toContain("doctor demo");
    expect(calls).toContain("routes demo");
    expect(calls).toContain("routes demo --client ts --target browser --out src/auggy-client.ts");
    expect(calls).toContain(
      "routes demo --client ts --target server --out src/auggy-client.server.ts",
    );
  });
});

async function runScript(
  script: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", script, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
