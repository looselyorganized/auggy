import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(ROOT, "src", "scaffold-starter-skills", "auggy", "scripts");

describe("auggy builder skill helper scripts", () => {
  test("detect-auggy-env reports project shape without requiring auggy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auggy-skill-detect-"));
    writeFileSync(join(dir, "agent.yaml"), "name: test-agent\naugments:\n  - webTransport\n");
    mkdirSync(join(dir, "augments", "webTransport"), { recursive: true });

    const result = await runScript(join(SCRIPTS, "detect-auggy-env.sh"), [], { cwd: dir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent: agent.yaml present");
    expect(result.stdout).toContain("augments: 1 folders");
    expect(result.stdout).toContain("auggy routes");
  });

  test("summarize-auggy-project prints non-secret project facts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auggy-skill-summary-"));
    writeFileSync(
      join(dir, "agent.yaml"),
      'name: "test-agent"\ndisplayName: "Test Agent"\naugments:\n  - webTransport\n  - services\n',
    );
    mkdirSync(join(dir, "augments", "services"), { recursive: true });
    writeFileSync(join(dir, "augments", "services", "augment.yaml"), "type: custom\n");
    writeFileSync(join(dir, ".env.example"), "ANTHROPIC_API_KEY=\nAUGGY_WEB_TOKEN=\n");

    const result = await runScript(join(SCRIPTS, "summarize-auggy-project.sh"), [dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent: test-agent");
    expect(result.stdout).toContain("- webTransport");
    expect(result.stdout).toContain("- augments/services");
    expect(result.stdout).toContain("- ANTHROPIC_API_KEY");
    expect(result.stdout).not.toContain("secret");
  });

  test("doctor and client scripts call auggy with expected arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auggy-skill-fake-cli-"));
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
