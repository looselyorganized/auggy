import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationHash,
  type PackedArtifactInput,
} from "../../scripts/release-smoke/application-consumer";
import {
  AUTHORING_EXECUTION_FILES,
  type AuthoringArtifactSet,
} from "../../scripts/release-smoke/authoring-contract";
import {
  assertAuthoringArtifactManifest,
  assertAuthoringCommandSucceeded,
  authoringCreateArguments,
  inspectGeneratedAuthoringTree,
  readAuthoringSource,
  runBoundedAuthoringCli,
  selectAuthoringArtifacts,
  snapshotGeneratedAuthoringSources,
} from "../../scripts/release-smoke/authoring-consumer";

let root: string;
let sequence = 0;
const entry = fileURLToPath(new URL("./authoring-command-fixture.ts", import.meta.url));
const sourceFiles = ["agent.yaml", "package.json", ...AUTHORING_EXECUTION_FILES];

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-authoring-helper-"));
  for (const directory of ["checkout", "consumer", "home", "tmp", "npm-cache"])
    mkdirSync(join(root, directory));
  for (const file of sourceFiles) write(join(root, "consumer", file), `owned ${file}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Packaging helper fixtures only; these are never actual Auggy runtime evidence.
function artifact(packageName: string): PackedArtifactInput {
  const staging = join(root, `pack-${sequence++}`);
  write(
    join(staging, "package/package.json"),
    JSON.stringify({
      name: packageName,
      version: "0.5.0",
      ...(packageName === "auggy"
        ? {
            auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] },
          }
        : {}),
    }),
  );
  write(join(staging, "package/index.ts"), 'throw new Error("Packaging fixture must not run");\n');
  const path = join(root, `artifact-${sequence}.tgz`);
  const packed = spawnSync("tar", ["-czf", path, "-C", staging, "package"], { timeout: 10_000 });
  expect(packed.status).toBe(0);
  return {
    path,
    packageName,
    sha256: applicationHash(readFileSync(path)),
    sourceFiles: ["index.ts"],
  };
}

function artifactSet(): AuthoringArtifactSet {
  return {
    core: artifact("auggy"),
    providers: {
      anthropic: artifact("@auggy/anthropic"),
      openai: artifact("@auggy/openai"),
      openrouter: artifact("@auggy/openrouter"),
      ollama: artifact("@auggy/ollama"),
    },
  };
}

function snapshot(files: readonly string[] = sourceFiles, consumer = join(root, "consumer")) {
  return snapshotGeneratedAuthoringSources({
    repoRoot: join(root, "checkout"),
    consumer,
    sourceFiles: files,
  });
}

describe("authoring helper preparation, not installed CLI acceptance", () => {
  test("fresh-tree inventory rejects parallel legacy registries and hashes no private bytes", () => {
    const consumer = join(root, "consumer");
    const config = {
      application: { entrypoint: "./src/index.ts", contractVersion: 1 },
      augments: [{ name: "web", type: "webTransport", options: {} }],
    };
    write(join(consumer, "agent.yaml"), JSON.stringify(config));
    write(join(consumer, ".env"), "SECRET=private-canary-value");
    write(join(consumer, ".auggy/operations/receipt.json"), "private-canary-value");
    const inventory = inspectGeneratedAuthoringTree(consumer);
    expect(inventory.find((item) => item.path === "src/index.ts")?.sha256).toBe(
      applicationHash(readFileSync(join(consumer, "src/index.ts"))),
    );
    expect(inventory.find((item) => item.path === ".env")).toEqual({
      path: ".env",
      kind: "file",
      private: true,
    });
    expect(
      inventory.find((item) => item.path === ".auggy/operations/receipt.json")?.sha256,
    ).toBeUndefined();
    expect(JSON.stringify(inventory)).not.toContain("private-canary-value");
    write(join(consumer, "augments/layeredMemory/augment.yaml"), "type: layeredMemory\n");
    expect(() => inspectGeneratedAuthoringTree(consumer)).toThrow("legacy");
    rmSync(join(consumer, "augments"), { recursive: true });
    write(
      join(consumer, "src/augments/layeredMemory/definition.ts"),
      "export const duplicateRegistry = [];\n",
    );
    expect(() => inspectGeneratedAuthoringTree(consumer)).toThrow("legacy definition");
    rmSync(join(consumer, "src/augments/layeredMemory"), { recursive: true });
    write(join(consumer, "agent.yaml"), JSON.stringify({ ...config, augments: ["layeredMemory"] }));
    expect(() => inspectGeneratedAuthoringTree(consumer)).toThrow("inline built-ins");
  });

  test("fresh-tree inventory rejects linked private paths and excessive entries", () => {
    const consumer = join(root, "consumer");
    write(
      join(consumer, "agent.yaml"),
      JSON.stringify({
        application: { entrypoint: "./src/index.ts", contractVersion: 1 },
        augments: [{ name: "web", type: "webTransport" }],
      }),
    );
    symlinkSync(join(root, "checkout"), join(consumer, "data"));
    expect(() => inspectGeneratedAuthoringTree(consumer)).toThrow("symlink");
    rmSync(join(consumer, "data"));
    for (let index = 0; index < 129; index++)
      write(join(consumer, "skills", `file-${index}.md`), "bounded fixture");
    expect(() => inspectGeneratedAuthoringTree(consumer)).toThrow("bound");
  });

  test("selects exact OpenRouter prerequisite and rejects wrong package/hash evidence", () => {
    const artifacts = artifactSet();
    const selected = selectAuthoringArtifacts(artifacts, "openrouter");
    expect(Object.keys(selected.specifiers).sort()).toEqual([
      "@auggy/openai",
      "@auggy/openrouter",
      "auggy",
    ]);
    expect(selected.prerequisites.map((artifact) => artifact.packageName)).toEqual([
      "@auggy/openai",
    ]);
    expect(JSON.parse(selected.specifiersJSON)).toEqual(selected.specifiers);
    expect(() =>
      selectAuthoringArtifacts({ ...artifacts, core: artifacts.providers.anthropic }, "anthropic"),
    ).toThrow("package");
    expect(() =>
      selectAuthoringArtifacts(
        { ...artifacts, core: { ...artifacts.core, sha256: "0".repeat(64) } },
        "anthropic",
      ),
    ).toThrow("SHA256");
    expect(Object.keys(selectAuthoringArtifacts(artifacts, "anthropic").specifiers).sort()).toEqual(
      ["@auggy/anthropic", "auggy"],
    );
  });

  test("requires generator-written exact mappings and prerequisite override without repairing bytes", () => {
    const selected = selectAuthoringArtifacts(artifactSet(), "openrouter");
    const manifest = {
      dependencies: { ...selected.specifiers, zod: "^4.6.6" },
      overrides: { "@auggy/openai": selected.specifiers["@auggy/openai"], qs: "6.16.1" },
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const before = applicationHash(bytes);
    assertAuthoringArtifactManifest(bytes, selected);
    expect(applicationHash(bytes)).toBe(before);
    const invalid = [
      { ...manifest, overrides: { qs: "6.16.1" } },
      { ...manifest, dependencies: { ...manifest.dependencies, auggy: "^0.5.0" } },
      { ...manifest, dependencies: { ...manifest.dependencies, "@auggy/ollama": "^0.5.0" } },
      { ...manifest, devDependencies: { auggy: selected.specifiers.auggy } },
      {
        ...manifest,
        dependencies: { ...manifest.dependencies, accidental: "file:../../checkout" },
      },
    ];
    for (const value of invalid)
      expect(() =>
        assertAuthoringArtifactManifest(Buffer.from(JSON.stringify(value)), selected),
      ).toThrow();
    expect(() => assertAuthoringArtifactManifest(Buffer.from("{secret invalid"), selected)).toThrow(
      "not valid JSON",
    );
    expect(() => assertAuthoringArtifactManifest(Buffer.alloc(65_537), selected)).toThrow("bound");
  });

  test("snapshots every required owned execution file without changing the source", () => {
    const result = snapshot();
    expect(Object.keys(result)).toEqual(sourceFiles);
    expect(result["src/turn.ts"]).toBe(applicationHash("owned src/turn.ts\n"));
    expect(snapshot()).toEqual(result);
    expect(() => snapshot(sourceFiles.filter((file) => file !== "src/turn.ts"))).toThrow(
      "owned execution",
    );
    expect(() => snapshot([...sourceFiles, "agent.yaml"])).toThrow("unique");
    expect(() => snapshot(sourceFiles, join(root, "checkout"))).toThrow("outside the checkout");
  });

  test("refuses secret/state allowlists and linked or oversized source", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".auggy/operations/receipt.json",
      "data/state.sqlite",
      "../outside.ts",
      "node_modules/auggy/index.ts",
    ])
      expect(() => readAuthoringSource(join(root, "consumer"), path)).toThrow();
    const file = join(root, "consumer/src/turn.ts");
    rmSync(file);
    symlinkSync(join(root, "consumer/agent.yaml"), file);
    expect(() => snapshot()).toThrow("symlink");
    rmSync(file);
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => snapshot()).toThrow("bound");
    rmSync(join(root, "consumer/src"), { recursive: true });
    symlinkSync(join(root, "checkout"), join(root, "consumer/src"));
    expect(() => snapshot()).toThrow("owned directory");
  });

  test.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking snapshot reads",
    () => {
      const file = join(root, "consumer/src/turn.ts");
      rmSync(file);
      expect(spawnSync("mkfifo", [file]).status).toBe(0);
      const started = Date.now();
      expect(() => snapshot()).toThrow("regular file");
      expect(Date.now() - started).toBeLessThan(500);
    },
  );

  test("keeps literal model/command data in argv and excludes ambient secrets", async () => {
    const model = 'model-"${notExecutable}`';
    const args = authoringCreateArguments({ name: "support-agent", provider: "anthropic", model });
    expect(args).toContain(model);
    expect(args).toEqual([
      "create",
      "support-agent",
      "--provider",
      "anthropic",
      "--model",
      model,
      "--yes",
      "--skip-install",
    ]);
    for (const bad of ["", "--skip-install", "bad\nmodel"])
      expect(() =>
        authoringCreateArguments({ name: "support-agent", provider: "anthropic", model: bad }),
      ).toThrow("bounded explicit");
    const prior = process.env.AUGGY_AUTHORING_AMBIENT_SECRET;
    process.env.AUGGY_AUTHORING_AMBIENT_SECRET = "private-fixture-canary";
    try {
      const result = await runBoundedAuthoringCli({
        entry,
        args: ["echo", ...args],
        cwd: root,
        workspace: root,
      });
      assertAuthoringCommandSucceeded(result);
      expect(JSON.parse(result.stdout)).toEqual({ args, artifactSelection: null, ambient: null });
    } finally {
      if (prior === undefined) delete process.env.AUGGY_AUTHORING_AMBIENT_SECRET;
      else process.env.AUGGY_AUTHORING_AMBIENT_SECRET = prior;
    }
  });

  test("retains ordinary failures, rejects timeout success and redacts explicit secrets", async () => {
    const run = (args: string[], extra: { timeoutMs?: number; secrets?: readonly string[] } = {}) =>
      runBoundedAuthoringCli({ entry, args, cwd: root, workspace: root, ...extra });
    const rejected = await run(["reject"]);
    expect(rejected.exitCode).toBe(7);
    expect(rejected.stderr).toContain("fixture rejection");
    expect(() => assertAuthoringCommandSucceeded(rejected)).toThrow("confirmed cleanup");
    const timeout = await run(["wait"], { timeoutMs: 100 });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.cleanupConfirmed).toBe(true);
    expect(() => assertAuthoringCommandSucceeded(timeout)).toThrow();
    const redacted = await run(["secret", "private-fixture-canary"], {
      secrets: ["private-fixture-canary"],
    });
    expect(redacted.stdout).toContain("[REDACTED]");
    expect(redacted.stdout).not.toContain("private-fixture-canary");
  });
});
