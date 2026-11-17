import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "../deploy/portable-fixtures";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/cli/index.ts");
let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-export-command-"));
  project = join(root, "agent");
  fixture(project);
  const runtime = join(project, "node_modules", "auggy");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({
      name: "auggy",
      version: "0.0.0",
      bin: { auggy: "cli.ts" },
      exports: { "./cli": "cli.ts" },
    }),
  );
  writeFileSync(
    join(runtime, "cli.ts"),
    'throw new Error("INSTALLED_RUNTIME_MUST_NOT_EXECUTE_DURING_EXPORT");',
  );
  writeFileSync(join(project, ".env"), "M5_COMMAND_SECRET=SECRET_CANARY\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function command(args: string[]) {
  return Bun.spawnSync([cli, ...args], {
    cwd: project,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

describe("auggy export docker command", () => {
  test("the declared executable suppresses project Bun preload before parsing or refusal, including a bin symlink", () => {
    const declared = JSON.parse(readFileSync(resolve(dirname(cli), "../../package.json"), "utf8"))
      .bin.auggy;
    expect(declared).toBe("src/cli/index.ts");
    expect(readFileSync(cli, "utf8").split("\n")[0]).toContain(
      "--no-env-file --no-install --config=/dev/null",
    );
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    writeFileSync(
      join(project, "preload.ts"),
      'await Bun.write("PRELOAD_EXECUTED", process.env.M5_COMMAND_SECRET ?? "loaded"); throw new Error("PROJECT_PRELOAD_EXECUTED");',
    );
    const output = join(root, "refused-context");
    expect(command(["export", "docker", "--out", output]).exitCode).not.toBe(0);
    expect(command(["export", "docker", "--help"]).exitCode).toBe(0);
    const linkedBin = join(root, "auggy");
    symlinkSync(cli, linkedBin);
    const help = Bun.spawnSync([linkedBin, "export", "docker", "--help"], {
      cwd: project,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    });
    expect(help.exitCode).toBe(0);
    expect(existsSync(join(project, "PRELOAD_EXECUTED"))).toBe(false);
    expect(existsSync(output)).toBe(false);
  });
  test("executes the passive exporter without delegating to local runtime or loading project code", () => {
    const output = join(root, "build-context");
    const result = command(["export", "docker", "--out", output]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Ingress: none (worker)");
    expect(result.stdout.toString()).toContain("Build verification: pending");
    expect(result.stdout.toString() + result.stderr.toString()).not.toMatch(
      /SECRET_CANARY|MUST_NOT/,
    );
    expect(existsSync(join(output, "auggy-deployment.json"))).toBe(true);
    expect(existsSync(join(output, "node_modules"))).toBe(false);
    expect(existsSync(join(output, ".env"))).toBe(false);
  });
  test("malformed flags and unknown commands fail without acquiring output", () => {
    const output = join(root, "invalid-output");
    for (const args of [
      ["export", "docker", "--out", output, "--port", "2.5"],
      ["export", "docker", "--out", output, "--install"],
      ["export", "docker", "--out", output, "--ingress", "public"],
      ["export", "unknown", "--out", output],
    ]) {
      expect(command(args).exitCode).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    }
  });
  test("failure diagnostics do not print raw dependency credentials or change input", () => {
    const path = join(project, "package.json");
    const source = JSON.stringify({
      name: "fixture",
      dependencies: {
        auggy: "https://token:SECRET_DEPENDENCY_CREDENTIAL@example.invalid/auggy.tgz",
      },
    });
    writeFileSync(path, source);
    const result = command(["export", "docker", "--out", join(root, "rejected-context")]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(
      "SECRET_DEPENDENCY_CREDENTIAL",
    );
    expect(readFileSync(path, "utf8")).toBe(source);
  });
});
