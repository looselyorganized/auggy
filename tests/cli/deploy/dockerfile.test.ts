import { describe, expect, test } from "bun:test";
import {
  generateDockerfile,
  generateEntrypoint,
  generateRailwayEntrypoint,
  generateRailwayCompatibilityDockerfile,
} from "../../../src/cli/deploy/dockerfile";

test("Railway foreground bootstrap leaves durable admission to the host", () => {
  const entry = generateRailwayEntrypoint();
  expect(entry).toContain('--config "$2" --internal-mode railway');
  expect(entry).toContain("--no-env-file --no-install --config=/dev/null");
  expect(entry).not.toMatch(/\b(?:chmod|mkdir|ln)\b/);
  expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(entry) }).exitCode).toBe(0);
});

test("legacy Railway archives retain explicit compatibility without manufacturing worker ingress", () => {
  const worker = generateRailwayCompatibilityDockerfile({
    agentName: "worker",
    configPath: "agent.yaml",
    profile: { kind: "none" },
    runtimeTarballName: "vendor/runtime.tgz",
  });
  expect(worker).toContain("@sha256:");
  expect(worker).toContain('COPY ["vendor/runtime.tgz","/app/vendor/runtime.tgz"]');
  expect(worker).not.toMatch(/EXPOSE|ENV PORT|ENV AUGGY_DEPLOYMENT_MANIFEST|frozen-lockfile/);
  expect(worker).toContain("not a portable frozen-build certification");
  const http = generateRailwayCompatibilityDockerfile({
    agentName: "http",
    configPath: "custom.yaml",
    profile: { kind: "http", port: 8081, healthPath: null, consolePath: null },
  });
  expect(http).toContain("ENV PORT=8081\nEXPOSE 8081");
  expect(http).toContain('"/app/custom.yaml"');
});

describe("generateDockerfile", () => {
  test("uses a pinned Bun base image", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/FROM oven\/bun:1\.3\.14-alpine/);
  });

  test("copies package.json + bun.lock before COPY . for per-agent install layer caching", () => {
    const df = generateDockerfile({ agentName: "zip" });
    const copyManifest = df.indexOf("COPY package.json");
    const runInstall = df.indexOf("RUN bun install");
    const copyAll = df.indexOf("COPY . /app");
    expect(copyManifest).toBeGreaterThan(-1);
    expect(runInstall).toBeGreaterThan(copyManifest);
    expect(copyAll).toBeGreaterThan(runInstall);
  });

  test("copies bun.lock via bracket-glob so absent lockfile doesn't fail the build", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/COPY bun\.loc\[k\] \/app\//);
  });

  test("copies a vendored runtime tarball before bun install when provided", () => {
    const df = generateDockerfile({
      agentName: "zip",
      runtimeTarballName: "auggy-0.4.4.tgz",
    });
    const copyLock = df.indexOf("COPY bun.loc[k] /app/");
    const copyTarball = df.indexOf("COPY auggy-0.4.4.tgz /app/");
    const runInstall = df.indexOf("RUN bun install");

    expect(copyTarball).toBeGreaterThan(copyLock);
    expect(runInstall).toBeGreaterThan(copyTarball);
  });

  test("runs the per-agent `bun install` (v0.3.2 package split), NOT the legacy global install", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/RUN bun install\b/);
    expect(df).not.toMatch(/bun install -g auggy/);
  });

  test("copies the staging context into /app after the install layer", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/COPY \. \/app/);
  });

  test("does not declare Docker VOLUME because Railway rejects it", () => {
    expect(generateDockerfile({ agentName: "zip" })).not.toMatch(/\bVOLUME\b/);
  });

  test("exposes the webTransport port", () => {
    expect(generateDockerfile({ agentName: "zip" })).toMatch(/EXPOSE 8080/);
  });

  test("ENTRYPOINT passes the agent name for older auggy dev command compatibility", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh", "zip"\]/);
  });
});

describe("generateEntrypoint", () => {
  test("requires Railway to advertise the exact /app/data mount", () => {
    const script = generateEntrypoint();
    expect(script).toMatch(/RAILWAY_VOLUME_MOUNT_PATH:-.*!= "\/app\/data"/);
    expect(script).toContain("RAILWAY_VOLUME_MOUNT_PATH must equal /app/data");
  });

  test("requires an existing real mount instead of creating an ephemeral fallback", () => {
    const script = generateEntrypoint();
    expect(script).toMatch(/\[ ! -d \/app\/data \] \|\| \[ -L \/app\/data \]/);
    expect(script).not.toMatch(/mkdir[^\n]* \/app\/data\s*$/m);
  });

  test("creates a private direct AgentMail state root and rejects a symlink leaf", () => {
    const script = generateEntrypoint();
    expect(script).toMatch(/\[ -L \/app\/data\/agent-mail \]/);
    expect(script).toMatch(/mkdir -p -m 0700 \/app\/data\/agent-mail/);
    expect(script).toMatch(/chmod 0700 \/app\/data\/agent-mail/);
    expect(script).toMatch(/umask 077/);
  });

  test("validates the mount before mutating state or legacy symlinks", () => {
    const script = generateEntrypoint();
    const mountCheck = script.indexOf("RAILWAY_VOLUME_MOUNT_PATH:-");
    const mountDirectoryCheck = script.indexOf("[ ! -d /app/data ]");
    const stateSymlinkCheck = script.indexOf("[ -L /app/data/agent-mail ]");
    const stateMkdir = script.indexOf("mkdir -p -m 0700 /app/data/agent-mail");
    const legacyAdmission = script.indexOf("for db_name in link.db");
    expect(mountCheck).toBeGreaterThan(-1);
    expect(mountDirectoryCheck).toBeGreaterThan(mountCheck);
    expect(stateSymlinkCheck).toBeGreaterThan(mountDirectoryCheck);
    expect(stateMkdir).toBeGreaterThan(stateSymlinkCheck);
    expect(legacyAdmission).toBeGreaterThan(stateMkdir);
  });

  test("keeps only the external link SQLite compatibility symlink", () => {
    const script = generateEntrypoint();
    expect(script).toContain("for db_name in link.db");
    expect(script).not.toContain("for db_name in memory.db");
    expect(script).toContain('ln -sfn "$volume_db" "$app_db"');
  });

  test("uses -f flag so redeploys don't trip on existing symlinks", () => {
    expect(generateEntrypoint()).toMatch(/ln -sfn/);
  });

  test("admits only regular private legacy SQLite artifacts", () => {
    const script = generateEntrypoint();
    expect(script).toContain(
      'for artifact in "$volume_db" "$volume_db-wal" "$volume_db-shm" "$volume_db-journal"',
    );
    expect(script).toContain('[ -L "$artifact" ]');
    expect(script).toContain('[ -e "$artifact" ] && [ ! -f "$artifact" ]');
    expect(script).toContain('chmod 0600 "$artifact"');
    expect(script).toContain('[ -e "$app_db" ] && [ ! -L "$app_db" ]');
  });

  test("does not create an AgentMail database symlink", () => {
    expect(generateEntrypoint()).not.toMatch(/db_name in[^\n]*agent-mail\.db/);
  });

  test("executes the verified explicit local CLI without an installing runner", () => {
    const script = generateEntrypoint();
    expect(script).toContain('fs.realpathSync("/app/node_modules/auggy")');
    expect(script).toContain("pkg.bin?.auggy");
    expect(script).toContain('rel.startsWith("../")');
    expect(script).toContain(
      'exec bun "$runtime_cli" dev "$1" --config /app/agent.yaml --internal-mode railway',
    );
    expect(script).not.toContain("bunx");
    expect(script).not.toContain("exec auggy");
  });

  test("uses `set -e` so failed steps abort the boot", () => {
    expect(generateEntrypoint()).toMatch(/set -e/);
  });
});
