import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  renameSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireProjectMutationLease,
  publishMutationPlan,
} from "../../src/cli/authoring/publication";
import { applyRollback } from "../../src/cli/authoring/publication-recovery";
import { planRollback, readOperationReceipt } from "../../src/cli/authoring/publication-receipt";
import { readFileSnapshot } from "../../src/cli/authoring/document-io";
import { createMutationPlan } from "../../src/cli/authoring/mutation";
import type { MutationPlan, PublicationBoundary } from "../../src/cli/authoring/contracts";

function makePlan(project: string, fresh = false, config = "agent.yaml"): MutationPlan {
  const specs = [
    {
      path: "src/main.ts",
      role: "support" as const,
      text: "export const next = true;\n",
      mode: 0o644,
    },
    ...(fresh
      ? [{ path: ".env", role: "new-env" as const, text: "TOKEN=ENV_SECRET_CANARY\n", mode: 0o600 }]
      : []),
    { path: config, role: "activation" as const, text: "name: next\n", mode: 0o644 },
  ];
  const files = specs.map((spec) => ({
    relativePath: spec.path,
    role: spec.role,
    mode: spec.mode,
    bytes: Buffer.from(spec.text),
    before: readFileSnapshot(join(project, spec.path), 4_194_304, { allowMissing: true }),
  }));
  return createMutationPlan({
    projectDir: project,
    kind: fresh ? "init" : "migrate",
    configRelativePath: config,
    inputs: files.map((file) => file.before),
    files,
    summary: [],
  });
}

if (process.argv[2] === "--publication-driver") {
  const [project, mode, boundary, path, id] = process.argv.slice(3) as [
    string,
    string,
    PublicationBoundary,
    string,
    string,
  ];
  const fault = (event: { boundary: PublicationBoundary; path?: string }) => {
    if (event.boundary === boundary && (!path || event.path === path))
      process.kill(process.pid, "SIGKILL");
  };
  if (mode === "rollback") applyRollback(planRollback(project, id), { fault });
  else if (mode === "lease") {
    const lease = acquireProjectMutationLease(project);
    lease.release();
  } else publishMutationPlan(makePlan(project, mode === "init"), { fault });
  process.exit(0);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project(fresh = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auggy-publication-crash-")));
  roots.push(root);
  if (!fresh) {
    writeFileSync(join(root, "agent.yaml"), "name: original\nsecret: INLINE_SECRET_CANARY\n");
    writeFileSync(join(root, ".gitignore"), ".env\n");
  }
  return root;
}
function driver(root: string, mode: string, boundary = "", path = "", id = "") {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      import.meta.path,
      "--publication-driver",
      root,
      mode,
      boundary,
      path,
      id,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}
function operation(root: string): string {
  return readdirSync(join(root, ".auggy", "operations"))[0]!;
}
function git(root: string, ...args: string[]) {
  return Bun.spawnSync({ cmd: ["git", "-C", root, ...args], stdout: "pipe", stderr: "pipe" });
}

for (const [boundary, path] of [
  ["before-ignore", ""],
  ["after-ignore", ""],
  ["before-first-backup", ""],
  ["prepared", ""],
  ["before-file", "src/main.ts"],
  ["after-file", "src/main.ts"],
  ["after-activation", "agent.yaml"],
  ["before-complete", ""],
] as const) {
  test(`process death at ${boundary}/${path} leaves a passively recoverable receipt`, () => {
    const root = project();
    const original = readFileSync(join(root, "agent.yaml"));
    const killed = driver(root, "existing", boundary, path);
    expect(killed.signalCode).toBe("SIGKILL");
    const id = operation(root);
    expect(() => publishMutationPlan(makePlan(root))).toThrow(/unresolved/);
    const rollback = planRollback(root, id);
    expect(rollback.diagnostics).toEqual([]);
    const result = applyRollback(rollback);
    expect(result.status).toBe("rolled-back");
    expect(result.activation).toBe("original");
    expect(readFileSync(join(root, "agent.yaml"))).toEqual(original);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env\n");
    expect(driver(root, "lease").exitCode).toBe(0);
  });
}

for (const boundary of [
  "before-rollback-file",
  "after-rollback-file",
  "before-sensitive-cleanup",
  "after-sensitive-cleanup",
] as const) {
  test(`rollback process death at ${boundary} can be retried`, () => {
    const root = project();
    const original = readFileSync(join(root, "agent.yaml"));
    const published = publishMutationPlan(makePlan(root));
    expect(driver(root, "rollback", boundary, "", published.operationId).signalCode).toBe(
      "SIGKILL",
    );
    const result = applyRollback(planRollback(root, published.operationId));
    expect(result.status).toBe("rolled-back");
    expect(result.activation).toBe("original");
    expect(readFileSync(join(root, "agent.yaml"))).toEqual(original);
  });
}

test("interrupted init recovers without agent.yaml, removes unchanged env, then retries", () => {
  const root = project(true);
  expect(driver(root, "init", "after-file", ".env").signalCode).toBe("SIGKILL");
  expect(readFileSnapshot(join(root, "agent.yaml"), 100, { allowMissing: true }).exists).toBe(
    false,
  );
  const id = operation(root);
  expect(() => publishMutationPlan(makePlan(root, true))).toThrow();
  expect(applyRollback(planRollback(root, id)).status).toBe("rolled-back");
  expect(readFileSnapshot(join(root, ".env"), 100, { allowMissing: true }).exists).toBe(false);
  expect(publishMutationPlan(makePlan(root, true)).status).toBe("complete");
});

test("cross-process lease contention is immediate and OS release needs no stale PID logic", () => {
  const root = project();
  const lease = acquireProjectMutationLease(root);
  const inode = lstatSync(join(root, ".auggy", "authoring.lock")).ino;
  expect(driver(root, "lease").exitCode).not.toBe(0);
  lease.release();
  expect(driver(root, "lease").exitCode).toBe(0);
  expect(lstatSync(join(root, ".auggy", "authoring.lock")).ino).toBe(inode);
});

test("private inline secret copies remain ignored through failed cleanup", () => {
  const root = project();
  expect(git(root, "init", "-q").exitCode).toBe(0);
  const published = publishMutationPlan(makePlan(root));
  expect(
    git(root, "check-ignore", `.auggy/operations/${published.operationId}/backup-2.bin`).exitCode,
  ).toBe(0);
  const result = applyRollback(planRollback(root, published.operationId), {
    fault(event) {
      if (event.boundary === "before-sensitive-cleanup") throw new Error("disk failure");
    },
  });
  expect(result.status).toBe("recovery-required");
  expect(result.activation).toBe("original");
  expect(git(root, "ls-files", "--others", "--exclude-standard", ".auggy").stdout.toString()).toBe(
    "",
  );
  expect(applyRollback(planRollback(root, published.operationId)).status).toBe("rolled-back");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env\n");
});

test("a damaged appended ignore postimage preserves files and protection for manual review", () => {
  const root = project();
  expect(driver(root, "existing", "after-ignore").signalCode).toBe("SIGKILL");
  writeFileSync(join(root, ".gitignore"), ".env\n.auggy/\n# operator edit\n");
  const result = applyRollback(planRollback(root, operation(root)));
  expect(result.status).toBe("recovery-required");
  expect(result.activation).toBe("original");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("operator edit");
});

test("parent replacement after preflight refuses writes through the new directory", () => {
  const root = project();
  mkdirSync(join(root, "src"));
  const result = publishMutationPlan(makePlan(root), {
    fault(event) {
      if (event.boundary === "prepared") {
        renameSync(join(root, "src"), join(root, "original-src"));
        mkdirSync(join(root, "src"));
      }
    },
  });
  expect(result.status).not.toBe("complete");
  expect(result.activation).toBe("original");
  expect(readdirSync(join(root, "src"))).toEqual([]);
});

test("a destination symlink introduced after preparation is preserved and never followed", () => {
  const root = project();
  const outside = project();
  const result = publishMutationPlan(makePlan(root), {
    fault(event) {
      if (event.boundary === "prepared") {
        mkdirSync(join(root, "src"));
        symlinkSync(join(outside, "agent.yaml"), join(root, "src/main.ts"));
      }
    },
  });
  expect(result.status).toBe("recovery-required");
  expect(result.activation).toBe("original");
  expect(readFileSync(join(outside, "agent.yaml"), "utf8")).toContain("original");
});

test("activation observation never guesses from a stale publication phase", () => {
  const root = project();
  const result = publishMutationPlan(makePlan(root), {
    fault(event) {
      if (event.boundary === "after-activation") {
        writeFileSync(join(root, "agent.yaml"), "operator: uncertain\n");
        throw new Error("failed");
      }
    },
  });
  expect(result.status).toBe("recovery-required");
  expect(result.activation).toBe("unknown");
  expect(readOperationReceipt(root, result.operationId).phase).toBe("publishing");
});

test("an edited support output is noticed before central activation", () => {
  const root = project();
  const result = publishMutationPlan(makePlan(root), {
    fault(event) {
      if (event.boundary === "after-file" && event.path === "src/main.ts")
        writeFileSync(join(root, "src/main.ts"), "operator: changed\n");
    },
  });
  expect(result.status).toBe("recovery-required");
  expect(result.activation).toBe("original");
  expect(readFileSync(join(root, "agent.yaml"), "utf8")).toContain("original");
});

test("preparation never copies secrets into a replaced private operation directory", () => {
  const root = project();
  let moved = "";
  const result = publishMutationPlan(makePlan(root), {
    fault(event) {
      if (event.boundary === "before-first-backup") {
        const path = join(root, ".auggy", "operations", event.operationId);
        moved = `${path}-moved`;
        renameSync(path, moved);
        mkdirSync(path, { mode: 0o700 });
      }
    },
  });
  expect(result.status).toBe("recovery-required");
  expect(result.activation).toBe("original");
  expect(readdirSync(moved)).toEqual(["receipt.json"]);
});

for (const boundary of [
  "after-rollback-file",
  "before-sensitive-cleanup",
  "after-sensitive-cleanup",
] as const) {
  test(`operator edits to restored support at ${boundary} prevent a false successful rollback`, () => {
    const root = project();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), "original support\n");
    const result = publishMutationPlan(makePlan(root));
    const rollback = applyRollback(planRollback(root, result.operationId), {
      fault(event) {
        if (
          event.boundary === boundary &&
          (boundary !== "after-rollback-file" || event.path === "src/main.ts")
        )
          writeFileSync(join(root, "src/main.ts"), "operator changed restored support\n");
      },
    });
    expect(rollback.status).toBe("recovery-required");
    expect(rollback.activation).toBe("original");
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toContain("operator changed");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".auggy/");
    if (boundary !== "after-sensitive-cleanup")
      expect(
        readdirSync(join(root, ".auggy", "operations", result.operationId)).some((name) =>
          name.startsWith("backup-"),
        ),
      ).toBe(true);
  });
}
