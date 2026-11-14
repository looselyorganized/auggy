import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DeploymentManifestV1 } from "../../../src/cli/deploy/contracts";
import { DEPLOYMENT_LIMITS, DEPLOYMENT_TOOLCHAIN } from "../../../src/cli/deploy/contracts";
import { exportDocker } from "../../../src/cli/commands/export";
import { fixture, packageArchive, TEST_AGENT_ID } from "./portable-fixtures";

let root: string;
let project: string;
let out: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "auggy-export-")));
  project = join(root, "project");
  out = join(root, "context");
  fixture(project);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const run = (overrides = {}) => exportDocker({ cwd: project, ingress: "auto", out, ...overrides });
const bytes = (path: string) => fs.readFileSync(path);
const hash = (path: string) => createHash("sha256").update(bytes(path)).digest("hex");
const config = (augments: unknown[]) => {
  const path = join(project, "agent.yaml");
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  value.augments = augments;
  fs.writeFileSync(path, JSON.stringify(value));
};
const manifest = () =>
  JSON.parse(fs.readFileSync(join(out, "auggy-deployment.json"), "utf8")) as DeploymentManifestV1;

function noTemporaryOutput() {
  expect(fs.existsSync(out)).toBe(false);
  expect(fs.readdirSync(root).filter((name) => name.startsWith("auggy-deploy-"))).toEqual([]);
}

describe("pure portable Docker export", () => {
  test.each(["", "  "])(
    "rejects an explicitly empty config without default fallback: %j",
    async (config) => {
      await expect(run({ config })).rejects.toThrow(/non-empty explicit file path/);
      noTemporaryOutput();
    },
  );
  test("accepts an ordinary registry-only manifest and supported text lock without network access", async () => {
    const dependencies = { auggy: "^0.5.0" };
    fs.writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "fixture", dependencies }),
    );
    fs.writeFileSync(
      join(project, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { "": { name: "fixture", dependencies } },
        packages: { auggy: ["auggy@0.5.0", "", {}, "sha512-fixture"] },
      }),
    );
    fs.rmSync(join(project, "vendor"), { recursive: true });
    await run();
    expect(manifest().dependencyTarballs).toEqual([]);
    expect(hash(join(project, "package.json"))).toBe(manifest().packageJsonSHA256);
    expect(hash(join(project, "bun.lock"))).toBe(manifest().lockfileSHA256);
  });
  test("exports an unchanged worker source/lock closure with truthful hashes and a generic foreground image", async () => {
    const before = new Map(
      ["agent.yaml", "package.json", "bun.lock", "vendor/auggy.tgz", "src/index.ts"].map((path) => [
        path,
        hash(join(project, path)),
      ]),
    );
    const result = await run();
    expect(result).toMatchObject({
      outputDir: out,
      profile: { kind: "none" },
      buildVerified: false,
    });
    const metadata = manifest();
    expect(metadata).toMatchObject({
      version: 1,
      agentId: TEST_AGENT_ID,
      agentName: "fixture",
      configPath: "agent.yaml",
      profile: { kind: "none" },
      toolchain: DEPLOYMENT_TOOLCHAIN,
    });
    expect(metadata.dependencyTarballs.map((file) => file.path)).toEqual(["vendor/auggy.tgz"]);
    for (const entry of [
      ...metadata.sourceFiles,
      ...metadata.dependencyTarballs,
      ...metadata.generatedFiles,
    ]) {
      expect(hash(join(out, entry.path))).toBe(entry.sha256);
      expect(fs.statSync(join(out, entry.path)).mode & 0o777).toBe(entry.mode);
    }
    for (const [path, digest] of before) {
      expect(hash(join(project, path))).toBe(digest);
      expect(hash(join(out, path))).toBe(digest);
    }
    expect(metadata.sourceFiles.some((entry) => entry.path === "auggy-deployment.json")).toBe(
      false,
    );
    const dockerfile = fs.readFileSync(join(out, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      `FROM ${DEPLOYMENT_TOOLCHAIN.image}@${DEPLOYMENT_TOOLCHAIN.imageDigest}`,
    );
    expect(dockerfile).toContain("RUN bun install --frozen-lockfile");
    expect(dockerfile).toContain('COPY ["vendor/auggy.tgz","/app/vendor/auggy.tgz"]');
    expect(dockerfile.indexOf("vendor/auggy.tgz")).toBeLessThan(
      dockerfile.indexOf("RUN bun install"),
    );
    expect(dockerfile).not.toMatch(/EXPOSE|ENV PORT=|HEALTHCHECK|VOLUME|USER /);
    const entrypoint = fs.readFileSync(join(out, "auggy-entrypoint.sh"), "utf8");
    expect(entrypoint).toContain(
      'exec bun --no-env-file --no-install --config=/dev/null "$runtime_cli" dev "$1" --config "$2"',
    );
    expect(entrypoint).not.toMatch(/RAILWAY|mkdir|chmod|bunx/);
    expect(result.sourceBytes).toBe(
      [...metadata.sourceFiles, ...metadata.dependencyTarballs].reduce(
        (sum, file) => sum + file.bytes,
        0,
      ),
    );
  });
  test("HTTP profile exposes only declared port and preserves a nondefault selected configuration", async () => {
    config([{ name: "web", type: "webTransport", options: { port: 4321, adminRoute: false } }]);
    fs.renameSync(join(project, "agent.yaml"), join(project, "agent.production.yaml"));
    await run({ name: "unrelated-positional-name", config: "agent.production.yaml" });
    expect(manifest()).toMatchObject({
      configPath: "agent.production.yaml",
      profile: { kind: "http", port: 4321, healthPath: "/health", consolePath: null },
    });
    const dockerfile = fs.readFileSync(join(out, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ENV PORT=4321\nEXPOSE 4321");
    expect(dockerfile).toContain('"/app/agent.production.yaml"');
  });
  test("does not execute project code, package scripts, dotenv, children or fetch", async () => {
    const source = join(project, "src", "index.ts");
    fs.writeFileSync(source, 'throw new Error("PROJECT_IMPORT_MUST_NOT_RUN");');
    fs.writeFileSync(join(project, ".env"), "M5_EXPORT_SECRET=DO_NOT_LOAD\n");
    const pkg = JSON.parse(fs.readFileSync(join(project, "package.json"), "utf8"));
    pkg.scripts = { postinstall: "touch MUST_NOT_EXIST" };
    fs.writeFileSync(join(project, "package.json"), JSON.stringify(pkg));
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        () => {
          throw new Error("network forbidden");
        },
        { preconnect: () => {} },
      ),
    );
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("children forbidden");
    });
    const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("children forbidden");
    });
    try {
      await run();
      expect(fetch).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
    expect(process.env.M5_EXPORT_SECRET).toBeUndefined();
    expect(fs.existsSync(join(project, "MUST_NOT_EXIST"))).toBe(false);
  });
  test("excludes secrets, cloud metadata, state and symlinks without traversing excluded roots", async () => {
    for (const name of [
      ".env",
      ".env.local",
      ".npmrc",
      ".auggy-cloud.json",
      "private.db",
      "private.db-wal",
      "agent-mail-reviews.json",
      "buffer.tmp",
    ])
      fs.writeFileSync(join(project, name), "PRIVATE_STATE_CANARY");
    for (const directory of [".git", ".auggy", "data", "workspace", "node_modules"]) {
      fs.mkdirSync(join(project, directory));
      fs.writeFileSync(join(project, directory, "secret"), "PRIVATE_STATE_CANARY");
    }
    fs.writeFileSync(join(project, ".env.example"), "TOKEN=\n");
    fs.symlinkSync(join(project, "identity.md"), join(project, "checkout-link"));
    fs.symlinkSync(root, join(project, "escape"));
    await run();
    expect(fs.existsSync(join(out, ".env.example"))).toBe(true);
    for (const entry of manifest().sourceFiles)
      expect(fs.readFileSync(join(out, entry.path), "utf8")).not.toContain("PRIVATE_STATE_CANARY");
    expect(fs.existsSync(join(out, "checkout-link"))).toBe(false);
    expect(fs.existsSync(join(out, "escape"))).toBe(false);
  });
  test("case-folds known secret/state names while retaining the env example exception", async () => {
    for (const name of [
      ".ENV",
      ".Env.Local",
      ".NPMRC",
      ".AUGGY-CLOUD.JSON",
      "ADMIN-OVERRIDES.JSON",
      "SESSION.TMP",
    ])
      fs.writeFileSync(join(project, name), "PRIVATE_CASE_CANARY");
    fs.mkdirSync(join(project, "DATA"));
    fs.writeFileSync(join(project, "DATA", "learned.md"), "PRIVATE_CASE_CANARY");
    fs.writeFileSync(join(project, ".ENV.EXAMPLE"), "TOKEN=\n");
    await run();
    expect(fs.existsSync(join(out, ".ENV.EXAMPLE"))).toBe(true);
    for (const entry of manifest().sourceFiles)
      expect(fs.readFileSync(join(out, entry.path), "utf8")).not.toContain("PRIVATE_CASE_CANARY");
    expect(fs.existsSync(join(out, "DATA"))).toBe(false);
  });
  test.each([
    ".dockerignore",
    ".DOCKERIGNORE",
    ".DockerIgnore",
    "Dockerfile.dockerignore",
    "DOCKERFILE.DOCKERIGNORE",
  ])(
    "refuses existing %s instead of producing a context with hidden required files",
    async (name) => {
      const path = join(project, name);
      fs.writeFileSync(path, "auggy-entrypoint.sh\n");
      await expect(run()).rejects.toThrow(".dockerignore rules are not supported");
      expect(fs.readFileSync(path, "utf8")).toBe("auggy-entrypoint.sh\n");
      noTemporaryOutput();
    },
  );
  test("excludes configured durable paths including replay, notifications, jobs and writable mounts", async () => {
    const paths = [
      "durable-mail",
      "durable-memory",
      "durable-visitor",
      "durable-console",
      "durable-idempotency",
      "durable-auth-replay",
      "durable-telegram",
      "durable-notify",
      "durable-log",
      "durable-jobs",
    ];
    for (const path of paths)
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        fs.writeFileSync(join(project, path + suffix), "PRIVATE_STATE_CANARY");
    fs.mkdirSync(join(project, "mutable-files"));
    fs.writeFileSync(join(project, "mutable-files", "content"), "PRIVATE_STATE_CANARY");
    config([
      { name: "mail", type: "agentMail", options: { dbPath: "durable-mail" } },
      { name: "memory", type: "layeredMemory", options: { dbPath: "durable-memory" } },
      {
        name: "visitor",
        type: "visitorAuth",
        options: { dbPath: "durable-visitor", layeredMemoryDbPath: "durable-memory" },
      },
      {
        name: "web",
        type: "webTransport",
        options: {
          port: 8080,
          consoleChat: { dbPath: "durable-console" },
          idempotency: { dbPath: "durable-idempotency" },
          externalAuth: { replayProtection: { dbPath: "durable-auth-replay" } },
        },
      },
      {
        name: "tg",
        type: "telegramTransport",
        options: { inbound: { mode: "polling" }, replay: { dbPath: "durable-telegram" } },
      },
      {
        name: "notify",
        type: "notify",
        options: {
          dbPath: "durable-notify",
          destinations: [{ transport: "log-to-file", path: "durable-log" }],
        },
      },
      {
        name: "fs",
        type: "filesystem",
        options: { mounts: [{ name: "mutable", path: "mutable-files", writable: true }] },
      },
    ]);
    const value = JSON.parse(fs.readFileSync(join(project, "agent.yaml"), "utf8"));
    value.settings = { jobs: { enabled: true, dbPath: "durable-jobs" } };
    fs.writeFileSync(join(project, "agent.yaml"), JSON.stringify(value));
    await run();
    for (const path of paths) expect(fs.existsSync(join(out, path))).toBe(false);
    expect(fs.existsSync(join(out, "mutable-files"))).toBe(false);
    expect(bytes(join(project, "durable-mail")).toString()).toBe("PRIVATE_STATE_CANARY");
  });
  test.each([false, true])(
    "prunes a nondefault runtime root without reading its ordinary or symlink control marker (symlink=%s)",
    async (symlink) => {
      const durable = join(project, "nondefault-durable");
      fs.mkdirSync(durable);
      const marker = join(durable, ".auggy-state-identity.json");
      if (symlink) fs.symlinkSync(join(root, "missing-private-target"), marker);
      else fs.writeFileSync(marker, "MALFORMED_PRIVATE_CONTROL_DO_NOT_PARSE");
      fs.writeFileSync(join(durable, "learned-behaviors.md"), "PRIVATE_RELOCATED_MEMORY");
      fs.writeFileSync(join(project, ".auggy-auth-replay-guard.pending"), "PRIVATE_CONTROL");
      // A marker at the selected source root is refused even when malformed.
      await expect(run()).rejects.toThrow("marked as a runtime state root");
      fs.unlinkSync(join(project, ".auggy-auth-replay-guard.pending"));
      fs.writeFileSync(join(project, ".auggy-volume-probe-partial.pending"), "PRIVATE_CONTROL");
      await run();
      expect(fs.existsSync(join(out, "nondefault-durable"))).toBe(false);
      expect(fs.existsSync(join(out, ".auggy-volume-probe-partial.pending"))).toBe(false);
      expect(fs.readFileSync(join(durable, "learned-behaviors.md"), "utf8")).toBe(
        "PRIVATE_RELOCATED_MEMORY",
      );
    },
  );
  test("keeps a fresh empty learned seed; refuses nonempty mutable memory without modifying it", async () => {
    config([
      {
        name: "learned",
        type: "fileMemory",
        options: { source: "./learned-behaviors.md", mutable: true },
      },
    ]);
    fs.writeFileSync(join(project, "learned-behaviors.md"), "");
    await run();
    expect(fs.statSync(join(out, "learned-behaviors.md")).size).toBe(0);
    fs.rmSync(out, { recursive: true });
    fs.writeFileSync(join(project, "learned-behaviors.md"), "PRIVATE_LEARNED_STATE");
    await expect(run()).rejects.toThrow("Nonempty mutable");
    expect(bytes(join(project, "learned-behaviors.md")).toString()).toBe("PRIVATE_LEARNED_STATE");
    noTemporaryOutput();
  });
  test("rejects unresolved durable paths, interpolated identity and required source links", async () => {
    config([{ name: "memory", type: "layeredMemory", options: { dbPath: "${SECRET_DATABASE}" } }]);
    await expect(run()).rejects.toThrow("literal filesystem");
    noTemporaryOutput();
    config([]);
    fs.unlinkSync(join(project, "identity.md"));
    fs.symlinkSync(join(project, "src", "index.ts"), join(project, "identity.md"));
    await expect(run()).rejects.toThrow("ordinary contained");
    noTemporaryOutput();
    fs.unlinkSync(join(project, "identity.md"));
    fs.writeFileSync(join(project, "identity.md"), "identity");
    const value = JSON.parse(fs.readFileSync(join(project, "agent.yaml"), "utf8"));
    value.id = "${AGENT_ID}";
    fs.writeFileSync(join(project, "agent.yaml"), JSON.stringify(value));
    await expect(run()).rejects.toThrow("literal immutable");
    noTemporaryOutput();
  });
  test("refuses destination aliases, existing directories/links and reserved source collisions", async () => {
    for (const destination of [project, join(project, "nested"), root])
      await expect(run({ out: destination })).rejects.toThrow();
    fs.mkdirSync(out);
    fs.writeFileSync(join(out, "winner"), "PRESERVE");
    await expect(run()).rejects.toThrow("already exists");
    expect(bytes(join(out, "winner")).toString()).toBe("PRESERVE");
    fs.rmSync(out, { recursive: true });
    fs.symlinkSync(project, out);
    await expect(run()).rejects.toThrow("already exists");
    fs.unlinkSync(out);
    fs.writeFileSync(join(project, "Dockerfile"), "OWNED_SOURCE");
    await expect(run()).rejects.toThrow("reserved");
    expect(bytes(join(project, "Dockerfile")).toString()).toBe("OWNED_SOURCE");
    noTemporaryOutput();
  });
  test("preserves a competing output writer during exclusive publication", async () => {
    const originalLink = fs.linkSync;
    const link = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (basename(String(destination)) === "identity.md")
        fs.writeFileSync(destination, "COMPETING_WRITER", { flag: "wx" });
      return originalLink(source, destination);
    });
    try {
      await expect(run()).rejects.toThrow("publish exclusively");
    } finally {
      link.mockRestore();
    }
    expect(fs.readFileSync(join(out, "identity.md"), "utf8")).toBe("COMPETING_WRITER");
    expect(fs.existsSync(join(out, "agent.yaml"))).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("auggy-deploy-"))).toEqual([]);
  });
  test("detects source changes after staging before publishing any output", async () => {
    const originalWrite = fs.writeFileSync;
    let changed = false;
    const write = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
      if (!changed && basename(String(path)) === "Dockerfile") {
        changed = true;
        originalWrite(join(project, "identity.md"), "CONCURRENT_SOURCE_EDIT");
      }
      return originalWrite(path, data, options);
    });
    try {
      await expect(run()).rejects.toThrow("source changed");
    } finally {
      write.mockRestore();
    }
    expect(changed).toBe(true);
    expect(fs.readFileSync(join(project, "identity.md"), "utf8")).toBe("CONCURRENT_SOURCE_EDIT");
    noTemporaryOutput();
  });
  test("rejects an empty mutable seed that becomes private state before copying", async () => {
    config([
      {
        name: "learned",
        type: "fileMemory",
        options: { source: "./learned-behaviors.md", mutable: true },
      },
    ]);
    fs.writeFileSync(join(project, "learned-behaviors.md"), "");
    const originalTemporary = fs.mkdtempSync;
    const temporary = spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
      fs.writeFileSync(join(project, "learned-behaviors.md"), "CONCURRENT_PRIVATE_STATE");
      return originalTemporary(prefix, options as { encoding: "buffer" }) as never;
    });
    try {
      await expect(run()).rejects.toThrow("Mutable seed changed");
    } finally {
      temporary.mockRestore();
    }
    noTemporaryOutput();
  });
  test("bounds directory depth and visited entries, including excluded names", async () => {
    let nested = project;
    for (let i = 0; i <= DEPLOYMENT_LIMITS.directoryDepth; i++) {
      nested = join(nested, "d");
      fs.mkdirSync(nested);
    }
    await expect(run()).rejects.toThrow("path/depth bounds");
    noTemporaryOutput();
    fs.rmSync(join(project, "d"), { recursive: true });
    const directory = join(project, "many");
    fs.mkdirSync(directory);
    for (let i = 0; i < DEPLOYMENT_LIMITS.visitedEntries; i++)
      fs.writeFileSync(join(directory, `${i}.tmp`), "");
    await expect(run()).rejects.toThrow("visited-entry limit");
    noTemporaryOutput();
  });
  test("rejects oversized regular files before copying and retains source", async () => {
    const file = join(project, "oversized.bin");
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, DEPLOYMENT_LIMITS.regularFileBytes + 1);
    fs.closeSync(fd);
    await expect(run()).rejects.toThrow();
    noTemporaryOutput();
    expect(fs.statSync(file).size).toBe(DEPLOYMENT_LIMITS.regularFileBytes + 1);
  });
  test("requires a text lock and never substitutes another archive for a missing local dependency", async () => {
    fs.unlinkSync(join(project, "bun.lock"));
    fs.writeFileSync(join(project, "bun.lockb"), "binary");
    await expect(run()).rejects.toThrow();
    noTemporaryOutput();
    fixture(project);
    fs.unlinkSync(join(project, "vendor", "auggy.tgz"));
    fs.writeFileSync(join(project, "auggy-unrelated.tgz"), packageArchive("auggy"));
    await expect(run()).rejects.toThrow("required local dependency");
    noTemporaryOutput();
  });
  test("refuses Docker environment expansion in archive/config paths without publishing or modifying source", async () => {
    const archive = join(project, "vendor", "$PACKAGE.tgz");
    fs.renameSync(join(project, "vendor", "auggy.tgz"), archive);
    const pkg = JSON.stringify({
      name: "fixture",
      dependencies: { auggy: "file:./vendor/$PACKAGE.tgz" },
    });
    fs.writeFileSync(join(project, "package.json"), pkg);
    const originalArchive = hash(archive);
    await expect(run()).rejects.toThrow("Docker COPY expands environment variables");
    noTemporaryOutput();
    expect(fs.readFileSync(join(project, "package.json"), "utf8")).toBe(pkg);
    expect(hash(archive)).toBe(originalArchive);
    fixture(project);
    fs.renameSync(join(project, "agent.yaml"), join(project, "agent$CONFIG.yaml"));
    await expect(run({ config: "agent$CONFIG.yaml" })).rejects.toThrow("config paths containing $");
    noTemporaryOutput();
  });
});
