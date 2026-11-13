import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { snapshotHash } from "../../src/cli/authoring/document-io";

export function put(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function migrationFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auggy-migration-")));
  const project = join(root, "project");
  cpSync(resolve(import.meta.dir, "../fixtures/authoring-migration/legacy"), project, {
    recursive: true,
  });
  put(join(project, ".env"), "MIGRATION_FIXTURE_TOKEN=private-fixture-canary\n");
  put(join(project, ".gitignore"), "# owned ignore rules\n.env\ndata/\n");
  put(join(project, "data/orders.sqlite"), "opaque-database-preservation-fixture");
  put(join(project, "data/orders.sqlite-wal"), "opaque-wal-preservation-fixture");
  put(join(project, "history.jsonl"), '{"private":"history-preservation-fixture"}\n');
  put(join(project, "skills/owned/SKILL.md"), "Owned skill remains available after migration.");
  return { root, project, config: join(project, "agent.yaml") };
}

export function installRuntime(project: string) {
  const runtime = join(project, "node_modules/auggy");
  const manifest = {
    name: "auggy",
    version: "0.5.0",
    type: "module",
    engines: { bun: ">=1.3.14" },
    bin: { auggy: "src/cli/index.ts" },
    exports: { "./application": "./src/application/index.ts" },
    auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] },
  };
  put(
    join(project, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { auggy: "0.5.0" }, scripts: { unrelated: "echo owned" }, operator: { __proto__: null, keep: false } }, null, 2)}\n`,
  );
  put(join(runtime, "package.json"), JSON.stringify(manifest));
  put(join(runtime, "src/cli/index.ts"), 'throw new Error("SELECTED_CLI_EXECUTED");');
  put(
    join(runtime, "src/application/index.ts"),
    'throw new Error("SELECTED_APPLICATION_EXECUTED");',
  );
  return { runtime, manifest };
}

export const MIGRATION_FIXTURE_FILE_BYTES = 8 * 1024 * 1024;

/** Test-owned trees: inspect and hash each regular file through the same descriptor. */
function fixtureEntry(path: string) {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    // A link is metadata only. Never read its target, even if it changes during inspection.
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isSymbolicLink()) throw new Error("Migration fixture entry changed during snapshot");
    return { stat, hash: null };
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) return { stat, hash: null };
    if (stat.size > BigInt(MIGRATION_FIXTURE_FILE_BYTES))
      throw new Error("Migration fixture file exceeds the snapshot byte bound");
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    const grew = readSync(descriptor, extra, 0, 1, offset) !== 0;
    const after = fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.length ||
      grew ||
      stat.size !== after.size ||
      stat.mode !== after.mode ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.ctimeNs !== after.ctimeNs
    )
      throw new Error("Migration fixture entry changed during snapshot");
    return { stat, hash: snapshotHash(bytes) };
  } finally {
    closeSync(descriptor);
  }
}

export function treeSnapshot(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).sort().map((entry) => {
    const { stat, hash } = fixtureEntry(join(root, entry));
    return `${entry}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${hash ?? ""}`;
  });
}

export function fileHashes(root: string): Map<string, string> {
  return new Map(
    (readdirSync(root, { recursive: true }) as string[]).flatMap((entry) => {
      const { hash } = fixtureEntry(join(root, entry));
      return hash === null ? [] : [[entry, hash] as const];
    }),
  );
}
