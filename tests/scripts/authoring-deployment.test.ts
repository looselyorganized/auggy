import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertGeneratedDeploymentBundle,
  createGeneratedDeploymentStagingWorkspace,
  verifyGeneratedDeployment,
} from "../../scripts/release-smoke/authoring-deployment";
import { stageBundle, stageBundleWithManifest } from "../../src/cli/deploy/bundle";

// Compile the installed-artifact runner; unit fixtures below are never executed as applications.
void verifyGeneratedDeployment;
let root: string;
let consumer: string;
let staged: string;
const sourceFiles = [
  "agent.yaml",
  "package.json",
  "src/index.ts",
  "src/agent.ts",
  "src/http.ts",
  "src/turn.ts",
  "skills/owned/SKILL.md",
];
function write(file: string, text = "private fixture") {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "generated-deployment-controls-"));
  consumer = join(root, "consumer");
  mkdirSync(consumer);
  for (const file of sourceFiles) write(join(consumer, file), `bounded unit fixture: ${file}\n`);
  for (const file of [
    ".env",
    ".env.production",
    ".auggy/receipt",
    "data/state",
    "node_modules/owned",
    "deployment-proof.sqlite",
    "deployment-proof.sqlite-wal",
    "deployment-proof.sqlite-shm",
  ])
    write(join(consumer, file));
  staged = stageBundle({ agentDir: consumer, agentName: "unit-generated-deployment" });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(staged, { recursive: true, force: true });
});

describe("generated deployment verifier controls", () => {
  test("owned execution and skills survive while private canaries are excluded", () => {
    expect(Object.keys(assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles }))).toEqual(
      sourceFiles,
    );
  });
  test("missing or altered staged source fails the real byte comparison", () => {
    write(join(staged, "src/http.ts"), "wrong handler");
    expect(() => assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles })).toThrow(
      "changed owned source",
    );
    rmSync(join(staged, "src/index.ts"));
    expect(() => assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles })).toThrow();
  });
  test("private files and even dangling private symlinks cannot appear in staging", () => {
    write(join(staged, ".env.production"));
    expect(() => assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles })).toThrow(
      "private state",
    );
    rmSync(join(staged, ".env.production"));
    symlinkSync(join(root, "absent"), join(staged, ".env"));
    expect(() => assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles })).toThrow(
      "private state",
    );
  });
  test("source symlinks, unsafe allowlists and omitted execution contracts are rejected", () => {
    rmSync(join(staged, "src/turn.ts"));
    symlinkSync(join(consumer, "src/turn.ts"), join(staged, "src/turn.ts"));
    expect(() => assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles })).toThrow(
      "symlink",
    );
    expect(() =>
      assertGeneratedDeploymentBundle({
        consumer,
        staged,
        sourceFiles: sourceFiles.filter((file) => file !== "src/turn.ts"),
      }),
    ).toThrow("execution source contract");
    expect(() =>
      assertGeneratedDeploymentBundle({
        consumer,
        staged,
        sourceFiles: ["../outside", ...sourceFiles],
      }),
    ).toThrow("unsafe path");
    expect(() =>
      assertGeneratedDeploymentBundle({
        consumer,
        staged,
        sourceFiles: [...sourceFiles, "src/turn.ts"],
      }),
    ).toThrow("bounded and unique");
  });
});

describe("generated deployment staging ownership", () => {
  test("actual manifest bundler stages in the owned private parent and cleanup removes it", () => {
    const owner = createGeneratedDeploymentStagingWorkspace(root);
    const bundle = stageBundleWithManifest(
      { agentDir: consumer, agentName: "generated-deployment" },
      owner.directory,
    );
    expect(owner.accept(bundle.directory)).toBe(bundle.directory);
    expect(dirname(bundle.directory)).toBe(owner.directory);
    expect(lstatSync(owner.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(bundle.directory).mode & 0o777).toBe(0o700);
    expect(
      Object.keys(
        assertGeneratedDeploymentBundle({ consumer, staged: bundle.directory, sourceFiles }),
      ),
    ).toEqual(sourceFiles);
    bundle.verifySource();
    owner.cleanup();
    expect(existsSync(owner.directory)).toBe(false);
    expect(readFileSync(join(consumer, ".env"), "utf8")).toBe("private fixture");
  });

  test("outside same-prefix directories and the owned parent are never accepted or deleted", () => {
    const owner = createGeneratedDeploymentStagingWorkspace(root);
    const outside = mkdtempSync(join(root, "auggy-deploy-"));
    write(join(outside, "preserve"));
    for (const unexpected of [outside, owner.directory, consumer, null, "auggy-deploy-relative"])
      expect(() => owner.accept(unexpected)).toThrow("unexpected cleanup destination");
    owner.cleanup();
    expect(readFileSync(join(outside, "preserve"), "utf8")).toBe("private fixture");
    expect(existsSync(consumer)).toBe(true);
  });

  test("linked and nonprivate returned children fail without touching the outside target", () => {
    const owner = createGeneratedDeploymentStagingWorkspace(root);
    const outside = mkdtempSync(join(root, "outside-"));
    write(join(outside, "preserve"));
    const linked = join(owner.directory, "auggy-deploy-linked");
    symlinkSync(outside, linked);
    expect(() => owner.accept(linked)).toThrow("ownership changed");
    const shared = mkdtempSync(join(owner.directory, "auggy-deploy-"));
    chmodSync(shared, 0o770);
    expect(() => owner.accept(shared)).toThrow("ownership changed");
    owner.cleanup();
    expect(readFileSync(join(outside, "preserve"), "utf8")).toBe("private fixture");
  });

  test.each(["parent", "child"])("replaced %s identity prevents destructive cleanup", (target) => {
    const owner = createGeneratedDeploymentStagingWorkspace(root);
    const bundle = stageBundleWithManifest(
      { agentDir: consumer, agentName: "generated-deployment" },
      owner.directory,
    );
    owner.accept(bundle.directory);
    const replaced = target === "parent" ? owner.directory : bundle.directory;
    renameSync(replaced, `${replaced}.original`);
    mkdirSync(replaced, { mode: 0o700 });
    write(join(replaced, "preserve"));
    expect(() => owner.cleanup()).toThrow("ownership changed");
    expect(readFileSync(join(replaced, "preserve"), "utf8")).toBe("private fixture");
    expect(existsSync(`${replaced}.original`)).toBe(true);
  });

  test("a nonprivate workspace is rejected before creating a staging owner", () => {
    chmodSync(root, 0o770);
    expect(() => createGeneratedDeploymentStagingWorkspace(root)).toThrow("ownership changed");
  });
});
