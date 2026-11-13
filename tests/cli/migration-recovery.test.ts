import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PublicationBoundary } from "../../src/cli/authoring/contracts";
import { readAuthoringDocument } from "../../src/cli/authoring/document";
import { readFileSnapshot } from "../../src/cli/authoring/document-io";
import {
  applyMigration,
  planMigration,
  planMigrationRollback,
  type MigrationReport,
} from "../../src/cli/authoring/migration";
import { createMutationPlan } from "../../src/cli/authoring/mutation";
import {
  acquireProjectMutationLease,
  publishMutationPlan,
} from "../../src/cli/authoring/publication";
import {
  fileHashes,
  installRuntime,
  migrationFixture,
  put,
  treeSnapshot,
} from "./migration-fixtures";

if (process.argv[2] === "--migration-driver") {
  const [config, boundary, path, kind] = process.argv.slice(3) as [
    string,
    PublicationBoundary,
    string,
    string,
  ];
  const fault = (event: { boundary: PublicationBoundary; path?: string }) => {
    if (event.boundary === boundary && (!path || path === event.path))
      process.kill(process.pid, "SIGKILL");
  };
  if (kind === "init") {
    const project = dirname(config);
    const files = [
      {
        relativePath: ".env",
        role: "new-env" as const,
        mode: 0o600,
        bytes: Buffer.from("TOKEN=INIT_PRIVATE_CANARY\n"),
      },
      {
        relativePath: "agent.yaml",
        role: "activation" as const,
        mode: 0o644,
        bytes: Buffer.from("name: initial\naugments: []\n"),
      },
    ].map((file) => ({
      ...file,
      before: readFileSnapshot(join(project, file.relativePath), 1024, { allowMissing: true }),
    }));
    publishMutationPlan(
      createMutationPlan({
        kind: "init",
        projectDir: project,
        configRelativePath: "agent.yaml",
        files,
        inputs: files.map((file) => file.before),
        summary: [],
      }),
      { fault },
    );
  } else
    await applyMigration(
      planMigration(readAuthoringDocument(config), { application: kind === "application" }),
      { fault },
    );
  process.exit(0);
}

const roots: string[] = [];
function fixture() {
  const result = migrationFixture();
  roots.push(result.root);
  return result;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function driver(config: string, boundary: string, path = "", kind = "application") {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      import.meta.path,
      "--migration-driver",
      config,
      boundary,
      path,
      kind,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}
async function binary(project: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../../src/cli/index.ts"),
      "migrate",
      ...args,
      "--json",
    ],
    { cwd: project, stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    return { code, report: JSON.parse(stdout) as MigrationReport, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

describe("migration publication and recovery integration", () => {
  test("stale metadata, package metadata and ignore preimages reject before receipt creation", async () => {
    for (const changed of [
      "augments/orders/augment.yaml",
      "node_modules/auggy/package.json",
      "node_modules/auggy/src/application/index.ts",
      ".gitignore",
    ]) {
      const { project, config } = fixture();
      installRuntime(project);
      const plan = planMigration(readAuthoringDocument(config), { application: true });
      put(join(project, changed), `${readFileSync(join(project, changed), "utf8")}\n`);
      const before = treeSnapshot(project);
      await expect(applyMigration(plan)).rejects.toThrow();
      expect(treeSnapshot(project)).toEqual(before);
      expect(existsSync(join(project, ".auggy"))).toBe(false);
    }
  });

  test("replacing a linked installation with identical manifest bytes invalidates the local runtime precondition", async () => {
    const { root, project, config } = fixture();
    const { runtime } = installRuntime(project);
    const first = join(root, "first-runtime");
    const second = join(root, "second-runtime");
    renameSync(runtime, first);
    cpSync(first, second, { recursive: true });
    symlinkSync(first, runtime);
    const plan = planMigration(readAuthoringDocument(config), { application: true });
    rmSync(runtime);
    symlinkSync(second, runtime);
    const before = treeSnapshot(project);
    await expect(applyMigration(plan)).rejects.toThrow();
    expect(treeSnapshot(project)).toEqual(before);
    expect(existsSync(join(project, ".auggy"))).toBe(false);
  });

  test("competing authoring lease preserves all owned files and does not install", async () => {
    const { project, config } = fixture();
    installRuntime(project);
    const plan = planMigration(readAuthoringDocument(config), { application: true });
    const lease = acquireProjectMutationLease(project);
    const before = treeSnapshot(project);
    try {
      await expect(applyMigration(plan)).rejects.toThrow();
      expect(treeSnapshot(project)).toEqual(before);
    } finally {
      lease.release();
    }
    expect((await applyMigration(plan)).status).toBe("complete");
  });

  for (const [boundary, path] of [
    ["before-ignore", ""],
    ["after-ignore", ""],
    ["before-first-backup", ""],
    ["prepared", ""],
    ["before-file", "src/index.ts"],
    ["after-file", "src/index.ts"],
    ["after-activation", "agent.yaml"],
    ["before-complete", ""],
  ] as const) {
    test(`application migration killed at ${boundary} retains guarded rollback and exact original owned files`, async () => {
      const { project, config } = fixture();
      installRuntime(project);
      const hashes = fileHashes(project);
      const killed = driver(config, boundary, path);
      expect(killed.signalCode).toBe("SIGKILL");
      const id = readdirSync(join(project, ".auggy/operations"))[0]!;
      const inode = lstatSync(join(project, ".auggy/authoring.lock")).ino;
      const prepared = planMigrationRollback(project, id);
      expect(prepared.report.status).toBe("planned");
      expect(prepared.report.diagnostics).toEqual([]);
      const beforePreview = treeSnapshot(project);
      const preview = await binary(project, "--project-dir", project, "--rollback", id);
      expect(preview.code).toBe(0);
      expect(preview.report.fingerprint).toBe(prepared.report.fingerprint);
      expect(treeSnapshot(project)).toEqual(beforePreview);
      const result = await binary(project, "--project-dir", project, "--rollback", id, "--apply");
      expect(result.code).toBe(0);
      expect(result.report.status).toBe("rolled-back");
      expect(result.report.activation).toBe("original");
      for (const [path, hash] of hashes) expect(fileHashes(project).get(path)).toBe(hash);
      expect(existsSync(join(project, "src/index.ts"))).toBe(false);
      expect(lstatSync(join(project, ".auggy/authoring.lock")).ino).toBe(inode);
      const privateFiles = readdirSync(join(project, ".auggy/operations", id));
      expect(privateFiles.every((file) => file === "receipt.json")).toBe(true);
      expect(
        (await applyMigration(planMigration(readAuthoringDocument(config), { application: true })))
          .status,
      ).toBe("complete");
    });
  }

  test("returned preactivation failure is non-ready and confirms original activation", async () => {
    const { project, config } = fixture();
    installRuntime(project);
    const original = readFileSync(config);
    const result = await applyMigration(
      planMigration(readAuthoringDocument(config), { application: true }),
      {
        fault(event) {
          if (event.boundary === "after-file" && event.path === "src/index.ts")
            throw new Error("synthetic disk failure");
        },
      },
    );
    expect(result.status).toBe("rolled-back");
    expect(result.activation).toBe("original");
    expect(readFileSync(config)).toEqual(original);
    expect(existsSync(join(project, "src/index.ts"))).toBe(false);
  });

  test("operator-modified or deleted config and owned source block rollback without any changes", async () => {
    for (const mode of ["changed-config", "deleted-config", "changed-source"]) {
      const { project, config } = fixture();
      installRuntime(project);
      const applied = await applyMigration(
        planMigration(readAuthoringDocument(config), { application: true }),
      );
      if (mode === "changed-config") put(config, "malformed: [private-config-canary\n");
      if (mode === "deleted-config") rmSync(config);
      if (mode === "changed-source") put(join(project, "src/turn.ts"), "owned source edit\n");
      const before = treeSnapshot(project);
      const result = await binary(
        project,
        "--config",
        config,
        "--rollback",
        applied.operationId!,
        "--apply",
      );
      expect(result.code).toBe(1);
      expect(result.report.status).toBe("invalid");
      expect(result.report.diagnostics.some((item) => item.code.startsWith("rollback-"))).toBe(
        true,
      );
      expect(result.stdout).not.toContain("private-config-canary");
      expect(treeSnapshot(project)).toEqual(before);
    }
  });

  test("receipt-selected interrupted init recovers without central YAML and protects operator credential edits", async () => {
    for (const editEnv of [false, true]) {
      const { project, config } = fixture();
      rmSync(config);
      rmSync(join(project, ".env"));
      rmSync(join(project, ".gitignore"));
      expect(driver(config, "after-file", ".env", "init").signalCode).toBe("SIGKILL");
      expect(existsSync(config)).toBe(false);
      const id = readdirSync(join(project, ".auggy/operations"))[0]!;
      if (editEnv) put(join(project, ".env"), "TOKEN=operator-changed-private-canary\n");
      const before = treeSnapshot(project);
      const result = await binary(project, "--project-dir", project, "--rollback", id, "--apply");
      expect(result.code).toBe(editEnv ? 1 : 0);
      expect(result.report.status).toBe(editEnv ? "invalid" : "rolled-back");
      expect(result.stdout).not.toContain("INIT_PRIVATE_CANARY");
      expect(result.stdout).not.toContain("operator-changed-private-canary");
      if (editEnv) expect(treeSnapshot(project)).toEqual(before);
      else {
        expect(existsSync(join(project, ".env"))).toBe(false);
        expect(existsSync(join(project, ".gitignore"))).toBe(false);
      }
    }
  });

  test("activation failure retaining new config returns recovery guidance, never success", async () => {
    const { project, config } = fixture();
    installRuntime(project);
    const result = await applyMigration(
      planMigration(readAuthoringDocument(config), { application: true }),
      {
        fault(event) {
          if (event.boundary === "after-activation") throw new Error("completion failure");
          if (event.boundary === "before-rollback-file") throw new Error("recovery failure");
        },
      },
    );
    expect(result.status).toBe("recovery-required");
    expect(result.activation).toBe("output");
    expect(result.manualActions.join("\n")).toContain(`--rollback ${result.operationId}`);
    expect((await applyMigration(planMigrationRollback(project, result.operationId!))).status).toBe(
      "rolled-back",
    );
  });

  test("missing receipt and invalid IDs report controlled failures without creating state", async () => {
    const { project } = fixture();
    for (const id of ["../escape", "00000000-0000-4000-8000-000000000004"]) {
      const before = treeSnapshot(project);
      const result = await binary(project, "--project-dir", project, "--rollback", id);
      expect(result.code).toBe(1);
      expect(result.report.status).toBe("invalid");
      expect(treeSnapshot(project)).toEqual(before);
    }
  });
});
