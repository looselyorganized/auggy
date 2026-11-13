import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertGeneratedDeploymentBundle,
  verifyGeneratedDeployment,
} from "../../scripts/release-smoke/authoring-deployment";
import { stageBundle } from "../../src/cli/deploy/bundle";

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
