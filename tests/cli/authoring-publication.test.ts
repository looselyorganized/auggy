import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  readdirSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSnapshot } from "../../src/cli/authoring/document-io";
import { createMutationPlan } from "../../src/cli/authoring/mutation";
import {
  acquireProjectMutationLease,
  publishMutationPlan,
} from "../../src/cli/authoring/publication";
import { applyRollback } from "../../src/cli/authoring/publication-recovery";
import { planRollback, readOperationReceipt } from "../../src/cli/authoring/publication-receipt";
import type {
  MutationPlan,
  PlannedFile,
  PublicationBoundary,
} from "../../src/cli/authoring/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "auggy-publication-")));
  roots.push(path);
  return path;
}
function plan(project: string, fresh = false, ignore = false): MutationPlan {
  const specs = [
    {
      path: "src/main.ts",
      text: "export const ready = true;\n",
      role: "support" as const,
      mode: 0o644,
    },
    ...(fresh
      ? [
          {
            path: ".env",
            text: "TOKEN=PRIVATE_ENV_CANARY\n",
            role: "new-env" as const,
            mode: 0o600,
          },
        ]
      : []),
    ...(ignore
      ? [
          {
            path: ".gitignore",
            text: ".env\nnode_modules/\n.auggy/\n",
            role: "ignore" as const,
            mode: 0o644,
          },
        ]
      : []),
    {
      path: "agent.yaml",
      text: "name: next\noptions: PRIVATE_OUTPUT_CANARY\n",
      role: "activation" as const,
      mode: 0o644,
    },
  ];
  const files: PlannedFile[] = specs.map((spec) => ({
    relativePath: spec.path,
    bytes: Buffer.from(spec.text),
    mode: spec.mode,
    role: spec.role,
    before: readFileSnapshot(join(project, spec.path), 4_194_304, { allowMissing: true }),
  }));
  return createMutationPlan({
    kind: fresh ? "init" : "migrate",
    projectDir: project,
    configRelativePath: "agent.yaml",
    inputs: files.map((file) => file.before),
    files,
    summary: [],
  });
}
function existing(): string {
  const project = root();
  writeFileSync(join(project, "agent.yaml"), "name: original\nsecret: PRIVATE_INLINE_CANARY\n");
  writeFileSync(join(project, ".gitignore"), "# Original ignore\n.env\n");
  return project;
}
function receiptDir(project: string, id: string): string {
  return join(project, ".auggy", "operations", id);
}

describe("authoring publication and guarded recovery", () => {
  test("publishes support before central activation and restores exact originals", () => {
    const project = existing();
    const original = readFileSync(join(project, "agent.yaml"));
    const ignore = readFileSync(join(project, ".gitignore"));
    const events: string[] = [];
    const result = publishMutationPlan(plan(project), {
      fault(event) {
        if (event.boundary === "before-file") events.push(event.path!);
      },
    });
    expect(result.status).toBe("complete");
    expect(result.activation).toBe("output");
    expect(events.at(-1)).toBe("agent.yaml");
    expect(lstatSync(receiptDir(project, result.operationId)).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(receiptDir(project, result.operationId)))
      expect(lstatSync(join(receiptDir(project, result.operationId), file)).mode & 0o777).toBe(
        0o600,
      );
    const receipt = readOperationReceipt(project, result.operationId);
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_");
    const rolled = applyRollback(planRollback(project, result.operationId));
    expect(rolled.status).toBe("rolled-back");
    expect(rolled.activation).toBe("original");
    expect(readFileSync(join(project, "agent.yaml"))).toEqual(original);
    expect(readFileSync(join(project, ".gitignore"))).toEqual(ignore);
    expect(readdirSync(receiptDir(project, result.operationId))).toEqual(["receipt.json"]);
    expect(readFileSnapshot(join(project, "src/main.ts"), 100, { allowMissing: true }).exists).toBe(
      false,
    );
  });

  test("new initialization removes only its unchanged env and allows a clean retry", () => {
    const project = root();
    const result = publishMutationPlan(plan(project, true, true));
    expect(result.status).toBe("complete");
    expect(lstatSync(join(project, ".env")).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(receiptDir(project, result.operationId)).some((name) => name === "backup-2.bin"),
    ).toBe(false);
    expect(applyRollback(planRollback(project, result.operationId)).status).toBe("rolled-back");
    for (const file of ["agent.yaml", ".env", ".gitignore", "src/main.ts"])
      expect(readFileSnapshot(join(project, file), 100, { allowMissing: true }).exists).toBe(false);
    expect(publishMutationPlan(plan(project, true, true)).status).toBe("complete");
  });

  for (const boundary of [
    "before-ignore",
    "after-ignore",
    "before-first-backup",
    "prepared",
    "before-file",
    "after-file",
    "after-activation",
    "before-complete",
  ] satisfies PublicationBoundary[]) {
    test(`ordinary ${boundary} failure safely rolls back`, () => {
      const project = existing();
      const original = readFileSync(join(project, "agent.yaml"));
      const ignore = readFileSync(join(project, ".gitignore"));
      const result = publishMutationPlan(plan(project), {
        fault(event) {
          if (event.boundary === boundary) throw new Error("SECRET_ERROR_MUST_NOT_LEAK");
        },
      });
      expect(result.status).toBe("rolled-back");
      expect(result.activation).toBe("original");
      expect(readFileSync(join(project, "agent.yaml"))).toEqual(original);
      expect(readFileSync(join(project, ".gitignore"))).toEqual(ignore);
      expect(JSON.stringify(result)).not.toContain("SECRET_ERROR");
    });
  }

  test("operator edits abort the entire rollback set before restoring activation", () => {
    const project = existing();
    const result = publishMutationPlan(plan(project));
    writeFileSync(join(project, "src/main.ts"), "operator change\n");
    const rollback = planRollback(project, result.operationId);
    expect(rollback.diagnostics.length).toBeGreaterThan(0);
    const applied = applyRollback(rollback);
    expect(applied.status).toBe("recovery-required");
    expect(applied.activation).toBe("output");
    expect(readFileSync(join(project, "agent.yaml"), "utf8")).toContain("name: next");
    expect(readFileSync(join(project, "src/main.ts"), "utf8")).toBe("operator change\n");
  });

  test("operator credential edits preserve env and prevent init rollback", () => {
    const project = root();
    const result = publishMutationPlan(plan(project, true));
    writeFileSync(join(project, ".env"), "TOKEN=OPERATOR_CHANGE\n");
    const applied = applyRollback(planRollback(project, result.operationId));
    expect(applied.status).toBe("recovery-required");
    expect(applied.activation).toBe("output");
    expect(readFileSync(join(project, ".env"), "utf8")).toContain("OPERATOR_CHANGE");
  });

  test("a stale input or symlink/case collision fails without publishing", () => {
    const project = existing();
    const stale = plan(project);
    writeFileSync(join(project, "agent.yaml"), "operator: yes\n");
    expect(() => publishMutationPlan(stale)).toThrow(/changed/);
    const current = plan(project);
    mkdirSync(join(project, "SRC"));
    expect(() => publishMutationPlan(current)).toThrow(/case/);
    rmSync(join(project, "SRC"), { recursive: true });
    symlinkSync(root(), join(project, "src"));
    expect(() => publishMutationPlan(current)).toThrow(/symlink|regular|destination/i);
  });

  test("leases are opaque, nonblocking, reusable by their owner and permanently preserve the lock inode", () => {
    const project = existing();
    const lease = acquireProjectMutationLease(project);
    const inode = lstatSync(join(project, ".auggy", "authoring.lock")).ino;
    expect(() => acquireProjectMutationLease(project)).toThrow(/lease/);
    expect(publishMutationPlan(plan(project), { lease }).status).toBe("complete");
    expect(() => acquireProjectMutationLease(project)).toThrow();
    lease.release();
    lease.release();
    const second = acquireProjectMutationLease(project);
    second.release();
    expect(lstatSync(join(project, ".auggy", "authoring.lock")).ino).toBe(inode);
    expect(() => publishMutationPlan(plan(project), { lease })).toThrow(/lease/);
  });

  test("malformed and nonprivate receipts fail closed; damaged backups prevent rollback", () => {
    const project = existing();
    const result = publishMutationPlan(plan(project));
    const receipt = readOperationReceipt(project, result.operationId);
    const backup = receipt.steps.find((step) => step.role === "activation")!.before!.backupPath;
    writeFileSync(join(receiptDir(project, result.operationId), backup), "corrupted");
    expect(planRollback(project, result.operationId).diagnostics.length).toBeGreaterThan(0);
    const location = join(receiptDir(project, result.operationId), "receipt.json");
    chmodSync(location, 0o644);
    expect(() => readOperationReceipt(project, result.operationId)).toThrow(/private/);
    chmodSync(location, 0o600);
    writeFileSync(location, '{"schemaVersion": 999}');
    expect(() => readOperationReceipt(project, result.operationId)).toThrow(/invalid/);
  });
});

test("publication rejects modified output bytes behind a stale plan fingerprint", () => {
  const project = existing();
  const candidate = plan(project);
  candidate.files[0]!.bytes[0] = 0;
  expect(() => publishMutationPlan(candidate)).toThrow(/plan changed/);
  expect(readFileSync(join(project, "agent.yaml"), "utf8")).toContain("original");
});

test("existing suspicious lock permissions are rejected without repair", () => {
  const project = existing();
  const lease = acquireProjectMutationLease(project);
  lease.release();
  const path = join(project, ".auggy", "authoring.lock");
  chmodSync(path, 0o644);
  expect(() => acquireProjectMutationLease(project)).toThrow(/unsafe/);
  expect(lstatSync(path).mode & 0o777).toBe(0o644);
});

test("passive receipt planning bundles without native FFI or mutation lease code", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/cli/authoring/publication-receipt.ts")],
    target: "bun",
  });
  expect(built.success).toBe(true);
  const code = await built.outputs[0]!.text();
  expect(code).not.toContain("bun:ffi");
  expect(code).not.toContain("tryLockFileExclusive");
  expect(code).not.toContain("acquireProjectMutationLease");
});

test("rollback restores an already protected ignore preimage while an earlier receipt keeps backups", () => {
  const project = existing();
  const first = publishMutationPlan(plan(project));
  writeFileSync(join(project, "other.yaml"), "name: another\n");
  const before = readFileSnapshot(join(project, "other.yaml"), 1024);
  const second = publishMutationPlan(
    createMutationPlan({
      kind: "migrate",
      projectDir: project,
      configRelativePath: "other.yaml",
      inputs: [before],
      files: [
        {
          relativePath: "other.yaml",
          before,
          role: "activation",
          bytes: Buffer.from("name: other-next\n"),
          mode: 0o644,
        },
      ],
      summary: [],
    }),
  );
  const rolled = applyRollback(planRollback(project, second.operationId));
  expect(rolled.status).toBe("rolled-back");
  expect(rolled.activation).toBe("original");
  expect(rolled.diagnostics.map((item) => item.code)).not.toContain("rollback-ignore-retained");
  expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".auggy/");
  expect(
    readdirSync(receiptDir(project, first.operationId)).some((name) => name.startsWith("backup-")),
  ).toBe(true);
});

test("receipt decoding rejects traversal, case aliases, reserved internals, mode and aggregate tampering", () => {
  const project = existing();
  const published = publishMutationPlan(plan(project));
  const path = join(receiptDir(project, published.operationId), "receipt.json");
  const original = readFileSync(path, "utf8");
  for (const dangerous of [
    "../agent.yaml",
    "nested/.auggy/private",
    "nested/.git/config",
    "C:drive",
    "e\u0301vil",
  ]) {
    const value = JSON.parse(original);
    value.steps[1].relativePath = dangerous;
    writeFileSync(path, JSON.stringify(value));
    expect(() => readOperationReceipt(project, published.operationId)).toThrow();
  }
  const value = JSON.parse(original);
  value.steps[1].after.mode = 0o7777;
  writeFileSync(path, JSON.stringify(value));
  expect(() => readOperationReceipt(project, published.operationId)).toThrow();
  writeFileSync(path, original);
});

test("legacy model snapshot directories are narrowed only on apply and snapshot bytes survive", () => {
  const project = existing();
  mkdirSync(join(project, ".auggy"), { mode: 0o755 });
  writeFileSync(join(project, ".auggy/models.lock.json"), '{"legacy":true}\n');
  const candidate = plan(project);
  expect(lstatSync(join(project, ".auggy")).mode & 0o777).toBe(0o755);
  const result = publishMutationPlan(candidate);
  expect(result.status).toBe("complete");
  expect(lstatSync(join(project, ".auggy")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(project, ".auggy/models.lock.json"), "utf8")).toBe('{"legacy":true}\n');
});

test("init exclusively creates its private model snapshot and rollback removes only its unchanged output", () => {
  const project = root();
  const candidate = plan(project, true);
  const before = readFileSnapshot(join(project, ".auggy/models.lock.json"), 1024, {
    allowMissing: true,
  });
  const model = {
    relativePath: ".auggy/models.lock.json",
    before,
    bytes: Buffer.from('{"models":[]}\n'),
    mode: 0o600,
    role: "support" as const,
  };
  const combined = createMutationPlan({
    ...candidate,
    inputs: [...candidate.inputs, before],
    files: [...candidate.files, model],
  });
  const result = publishMutationPlan(combined);
  expect(result.status).toBe("complete");
  expect(lstatSync(join(project, ".auggy/models.lock.json")).mode & 0o777).toBe(0o600);
  expect(applyRollback(planRollback(project, result.operationId)).status).toBe("rolled-back");
  expect(
    readFileSnapshot(join(project, ".auggy/models.lock.json"), 1024, { allowMissing: true }).exists,
  ).toBe(false);
});

test("two completed operations roll back in reverse order without an ignore-rule deadlock", () => {
  const project = existing();
  const original = readFileSync(join(project, "agent.yaml"));
  const first = publishMutationPlan(plan(project));
  const before = readFileSnapshot(join(project, "agent.yaml"), 1024);
  const second = publishMutationPlan(
    createMutationPlan({
      kind: "migrate",
      projectDir: project,
      configRelativePath: "agent.yaml",
      inputs: [before],
      files: [
        {
          relativePath: "agent.yaml",
          before,
          role: "activation",
          mode: 0o644,
          bytes: Buffer.from("name: second\n"),
        },
      ],
      summary: [],
    }),
  );
  expect(applyRollback(planRollback(project, second.operationId)).status).toBe("rolled-back");
  expect(applyRollback(planRollback(project, first.operationId)).status).toBe("rolled-back");
  expect(readFileSync(join(project, "agent.yaml"))).toEqual(original);
  expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe("# Original ignore\n.env\n");
});

test("other retained raw backups prevent removing the only effective ignore protection", () => {
  const project = existing();
  const first = publishMutationPlan(plan(project));
  const protectedIgnore = readFileSync(join(project, ".gitignore"));
  writeFileSync(join(project, "other.yaml"), "name: other\n");
  const before = readFileSnapshot(join(project, "other.yaml"), 1024);
  const second = publishMutationPlan(
    createMutationPlan({
      kind: "migrate",
      projectDir: project,
      configRelativePath: "other.yaml",
      inputs: [before],
      files: [
        {
          relativePath: "other.yaml",
          before,
          role: "activation",
          mode: 0o644,
          bytes: Buffer.from("name: second\n"),
        },
      ],
      summary: [],
    }),
  );
  writeFileSync(join(project, ".gitignore"), protectedIgnore);
  const result = applyRollback(planRollback(project, first.operationId));
  expect(result.status).toBe("rolled-back");
  expect(result.diagnostics.map((item) => item.code)).toContain("rollback-ignore-retained");
  expect(readFileSync(join(project, ".gitignore"))).toEqual(protectedIgnore);
  expect(
    readdirSync(receiptDir(project, second.operationId)).some((name) => name.startsWith("backup-")),
  ).toBe(true);
});

test("oversized operator outputs and recovery copies are bounded preservation conflicts", () => {
  const project = existing();
  const result = publishMutationPlan(plan(project));
  writeFileSync(join(project, "src/main.ts"), "operator change".repeat(1000));
  expect(planRollback(project, result.operationId).diagnostics.map((item) => item.code)).toContain(
    "rollback-conflict",
  );
  const receipt = readOperationReceipt(project, result.operationId);
  const backup = receipt.steps.find((step) => step.role === "activation")!.before!.backupPath;
  writeFileSync(
    join(receiptDir(project, result.operationId), backup),
    "corrupt backup".repeat(1000),
  );
  expect(planRollback(project, result.operationId).diagnostics.map((item) => item.code)).toContain(
    "rollback-conflict",
  );
});
