import { afterEach, expect, mock, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (process.argv[2] === "--atomic-driver") {
  const [project, boundary] = process.argv.slice(3) as [string, string];
  const fs = { ...(await import("node:fs")) };
  const native = { ...(await import("../../src/lib/posix-at")) };
  const isActivationStage = (fd: number) => {
    try {
      const id = fs.readdirSync(join(project, ".auggy", "operations"))[0]!;
      const stage = fs.lstatSync(join(project, ".auggy", "operations", id, "stage-1.bin"));
      const opened = fs.fstatSync(fd);
      return stage.dev === opened.dev && stage.ino === opened.ino;
    } catch {
      return false;
    }
  };
  mock.module("node:fs", () => ({
    ...fs,
    fchmodSync(fd: number, mode: number) {
      fs.fchmodSync(fd, mode);
      if (boundary === "final-stage-mode" && mode === 0o644 && isActivationStage(fd))
        process.kill(process.pid, "SIGKILL");
    },
    writeSync(...args: Parameters<typeof fs.writeSync>) {
      if (boundary === "short-stage-write" && isActivationStage(args[0])) {
        const bytes = args[1] as unknown as Uint8Array;
        fs.writeSync(args[0], bytes, Number(args[2] ?? 0), 1);
        process.kill(process.pid, "SIGKILL");
      }
      return (fs.writeSync as (...args: unknown[]) => number)(...args);
    },
  }));
  mock.module("../../src/lib/posix-at", () => ({
    ...native,
    renameAtNoReplace(...args: Parameters<typeof native.renameAtNoReplace>) {
      if (boundary === "collision" && args[3] === "agent.yaml")
        fs.writeFileSync(join(project, "agent.yaml"), "operator: raced\n");
      const result = native.renameAtNoReplace(...args);
      if (boundary === "after-rename" && args[3] === "agent.yaml" && result)
        process.kill(process.pid, "SIGKILL");
      return result;
    },
    renameAt(...args: Parameters<typeof native.renameAt>) {
      const result = native.renameAt(...args);
      if (boundary === "after-rename" && args[3] === "agent.yaml" && result)
        process.kill(process.pid, "SIGKILL");
      return result;
    },
  }));
  const { readFileSnapshot } = await import("../../src/cli/authoring/document-io");
  const { createMutationPlan } = await import("../../src/cli/authoring/mutation");
  const { publishMutationPlan } = await import("../../src/cli/authoring/publication");
  const before = readFileSnapshot(join(project, "agent.yaml"), 1024, { allowMissing: true });
  const plan = createMutationPlan({
    kind: "init",
    projectDir: project,
    configRelativePath: "agent.yaml",
    inputs: [before],
    files: [
      {
        relativePath: "agent.yaml",
        role: "activation",
        before,
        mode: 0o644,
        bytes: Buffer.from("name: complete\n"),
      },
    ],
    summary: [],
  });
  const result = publishMutationPlan(plan);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(existing: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auggy-publication-atomic-")));
  roots.push(root);
  if (existing) writeFileSync(join(root, "agent.yaml"), "name: original\n");
  return root;
}
function child(project: string, boundary: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, "--atomic-driver", project, boundary],
    stdout: "pipe",
    stderr: "pipe",
  });
}

for (const existing of [false, true]) {
  for (const boundary of ["short-stage-write", "final-stage-mode", "after-rename"]) {
    test(`${existing ? "existing" : "new"} activation stays absent/original or complete when killed at ${boundary}`, async () => {
      const root = project(existing);
      const result = child(root, boundary);
      expect(result.signalCode).toBe("SIGKILL");
      const { readFileSnapshot } = await import("../../src/cli/authoring/document-io");
      const active = readFileSnapshot(join(root, "agent.yaml"), 1024, { allowMissing: true });
      if (boundary === "after-rename") {
        expect(active.exists).toBe(true);
        if (active.exists) {
          expect(Buffer.from(active.bytes).toString()).toBe("name: complete\n");
          expect(active.identity.mode & 0o777).toBe(0o644);
        }
      } else if (existing) {
        expect(active.exists).toBe(true);
        if (active.exists) expect(Buffer.from(active.bytes).toString()).toBe("name: original\n");
      } else expect(active.exists).toBe(false);
      const id = readdirSync(join(root, ".auggy", "operations"))[0]!;
      const { planRollback } = await import("../../src/cli/authoring/publication-receipt");
      const rollback = planRollback(root, id);
      if (boundary === "short-stage-write") expect(rollback.diagnostics.length).toBeGreaterThan(0);
      else {
        expect(rollback.diagnostics).toEqual([]);
        const { applyRollback } = await import("../../src/cli/authoring/publication-recovery");
        expect(applyRollback(rollback).status).toBe("rolled-back");
      }
    });
  }
}

test("a destination created after final preflight is never replaced", () => {
  const root = project(false);
  const result = child(root, "collision");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).status).toBe("recovery-required");
  expect(readFileSync(join(root, "agent.yaml"), "utf8")).toBe("operator: raced\n");
  expect(lstatSync(join(root, "agent.yaml")).isFile()).toBe(true);
});
