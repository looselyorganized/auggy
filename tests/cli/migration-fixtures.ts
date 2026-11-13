import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

export function treeSnapshot(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).sort().map((entry) => {
    const path = join(root, entry);
    const stat = lstatSync(path, { bigint: true });
    return `${entry}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.isFile() ? snapshotHash(readFileSync(path)) : ""}`;
  });
}

export function fileHashes(root: string): Map<string, string> {
  return new Map(
    (readdirSync(root, { recursive: true }) as string[])
      .filter((entry) => lstatSync(join(root, entry)).isFile())
      .map((entry) => [entry, snapshotHash(readFileSync(join(root, entry)))]),
  );
}
