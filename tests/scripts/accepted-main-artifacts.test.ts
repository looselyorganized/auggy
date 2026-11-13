import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTED_MAIN,
  acceptedBuildEnvironment,
  buildAcceptedMainArtifacts,
  runAcceptedBuildCommand,
  validateAcceptedPackInventory,
  verifyAcceptedArchive,
  verifyAcceptedSourceFiles,
} from "../../scripts/release-smoke/accepted-main-artifacts";

const directories: string[] = [];
const processFixture = fileURLToPath(
  new URL("../fixtures/m3-main-codeql/process-child.ts", import.meta.url),
);
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "auggy-accepted-builder-test-"));
  directories.push(directory);
  for (const name of ["home", "tmp", "npm-cache"]) mkdirSync(join(directory, name));
  return directory;
}

function run(code: string, extra: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const cwd = temporary();
  return runAcceptedBuildCommand({
    command: [process.execPath, "-e", code],
    cwd,
    env: acceptedBuildEnvironment(cwd),
    ...extra,
  });
}

describe("accepted main artifact builder boundaries", () => {
  test("pins the accepted source and excludes inherited auth, settings and preloads", () => {
    expect(ACCEPTED_MAIN.commit).toBe("209185d0e7481b4ff5d3b4c87e3447e7583b2fef");
    expect(ACCEPTED_MAIN.tree).toBe("30bd2b764c6e136708a82fc186ce733e3741a4ff");
    const env = acceptedBuildEnvironment("/private/tmp/isolated");
    expect(env.HOME).toBe("/private/tmp/isolated/home");
    expect(env.npm_config_userconfig).toBe("/dev/null");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.BUN_OPTIONS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("accepts regular package files and rejects paths or links before extraction", () => {
    expect(
      validateAcceptedPackInventory(
        "package/package.json\npackage/src/index.ts\n",
        "- regular\n- regular\n",
      ),
    ).toEqual(["package.json", "src/index.ts"]);
    for (const path of [
      "../package.json",
      "/package/package.json",
      "package/../escape",
      "package//file",
      "package/./file",
      "package/a\\b",
      "package/space name",
    ]) {
      expect(() =>
        validateAcceptedPackInventory(`package/package.json\n${path}`, "- regular\n- regular"),
      ).toThrow();
    }
    expect(() =>
      validateAcceptedPackInventory(
        "package/package.json\npackage/package.json",
        "- regular\n- regular",
      ),
    ).toThrow();
    expect(() => validateAcceptedPackInventory("package/package.json", "l symlink")).toThrow();
    expect(() => validateAcceptedPackInventory("package/package.json", "h hardlink")).toThrow();
    expect(() => validateAcceptedPackInventory("package/src/index.ts", "- regular")).toThrow();
    expect(() => validateAcceptedPackInventory("package/package.json", "")).toThrow();
  });

  test("detects changed lock or source bytes, deleted files and symlink substitutions", () => {
    const directory = temporary();
    const path = join(directory, "bun.lock");
    writeFileSync(path, "accepted lock");
    const expected = { "bun.lock": createHash("sha256").update("accepted lock").digest("hex") };
    verifyAcceptedSourceFiles(directory, expected);
    writeFileSync(path, "new lock");
    expect(() => verifyAcceptedSourceFiles(directory, expected)).toThrow("Accepted source changed");
    rmSync(path);
    expect(() => verifyAcceptedSourceFiles(directory, expected)).toThrow();
    const target = join(directory, "elsewhere");
    writeFileSync(target, "accepted lock");
    symlinkSync(target, path);
    expect(() => verifyAcceptedSourceFiles(directory, expected)).toThrow("symbolic link");
    expect(() => verifyAcceptedSourceFiles(directory, { "../escape": "hash" })).toThrow(
      "Invalid source path",
    );
  });

  test("compares complete archive contents with accepted Git blobs before installing", () => {
    const root = temporary();
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "one.ts"), "accepted source");
    const blob = createHash("sha1").update("blob 15\0accepted source").digest("hex");
    const listing = `100644 blob ${blob}\tone.ts`;
    expect(Object.keys(verifyAcceptedArchive(source, listing))).toEqual(["one.ts"]);
    writeFileSync(join(source, "one.ts"), "changed source!");
    expect(() => verifyAcceptedArchive(source, listing)).toThrow("blob mismatch");
    writeFileSync(join(source, "unexpected.ts"), "extra");
    expect(() => verifyAcceptedArchive(source, listing)).toThrow("file count mismatch");
  });

  test("refuses to overwrite prior evidence or artifacts", async () => {
    const output = temporary();
    writeFileSync(join(output, "accepted-main-artifacts.json"), "retained evidence");
    await expect(
      buildAcceptedMainArtifacts({ repositoryRoot: process.cwd(), outputDirectory: output }),
    ).rejects.toThrow("empty directory");
    expect(readFileSync(join(output, "accepted-main-artifacts.json"), "utf8")).toBe(
      "retained evidence",
    );
  });

  test("records a successful real command and restores process signal listeners", async () => {
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const result = await run(
      'process.stdout.write("finished"); process.stderr.write("diagnostic")',
    );
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("finished");
    expect(result.stderr).toBe("diagnostic");
    expect(result.cleanupUnknown).toBe(false);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
  });

  test("fails on command exit and startup failures without treating empty output as success", async () => {
    const failed = await run("process.exit(7)");
    expect(failed.status).toBe("failed");
    expect(failed.exitCode).toBe(7);
    const cwd = temporary();
    const missing = await runAcceptedBuildCommand({
      command: ["/nonexistent/accepted-build-test"],
      cwd,
      env: acceptedBuildEnvironment(cwd),
    });
    expect(missing.status).toBe("failed");
    expect(missing.failure).toBe("spawn-failed");
  });

  test("redacts credential-shaped build diagnostics", async () => {
    const result = await run(
      'process.stdout.write("Authorization: Bearer fixture-private-token\\n"); process.stderr.write("sk-ant-privatefixture123")',
    );
    expect(result.stdout).not.toContain("fixture-private-token");
    expect(result.stderr).not.toContain("privatefixture123");
    expect(result.stdout).toContain("[REDACTED]");
  });

  test("bounds both command lifetime and captured output", async () => {
    const timeout = await run("setInterval(() => {}, 1000)", { timeoutMs: 100 });
    expect(timeout.status).toBe("failed");
    expect(timeout.failure).toBe("timeout");
    expect(timeout.durationMs).toBeLessThan(6_000);
    const output = await run(
      'process.stdout.write("x".repeat(65536)); setInterval(() => {}, 1000)',
      { maxOutputBytes: 256 },
    );
    expect(output.status).toBe("failed");
    expect(output.failure).toBe("output-limit");
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(
      256,
    );
  });

  test("kills delegated build descendants on timeout", async () => {
    const cwd = temporary();
    const marker = join(cwd, "descendant-ran");
    const result = await runAcceptedBuildCommand({
      command: [process.execPath, processFixture, "delayed-descendant", marker],
      cwd,
      env: acceptedBuildEnvironment(cwd),
      timeoutMs: 150,
    });
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("timeout");
    await Bun.sleep(900);
    expect(existsSync(marker)).toBe(false);
  });

  test("rejects unbounded command settings before spawning", async () => {
    await expect(run("process.exit(0)", { timeoutMs: 0 })).rejects.toThrow("deadline");
    await expect(
      run("process.exit(0)", { maxOutputBytes: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("output bound");
  });
});
