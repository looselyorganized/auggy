import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstalledSourceIndex } from "../../src/cli/authoring/contracts";

export function writeFixture(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
export const fixtureIndex: InstalledSourceIndex = {
  schemaVersion: 1,
  runtime: {
    application: "src/application/runner.ts",
    host: "src/application/host.ts",
    turn: "src/kernel/turn-session.ts",
  },
  augments: [
    {
      type: "fileMemory",
      entrypoint: "src/augments/fileMemory/index.ts",
      directory: "src/augments/fileMemory",
    },
    { type: "webTransport", entrypoint: "src/transports/web-transport.ts" },
  ],
};
export function inspectionFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auggy-inspection-")));
  const project = join(root, "project");
  const runtime = join(project, "node_modules/auggy");
  const config = join(project, "agent.yaml");
  const indexPath = join(runtime, "src/metadata/source-index.json");
  writeFixture(join(project, "package.json"), '{"private":true,"type":"module"}');
  const manifest = {
    name: "auggy",
    version: "4.5.6",
    type: "module",
    engines: { bun: ">=1.3.14" },
    bin: { auggy: "src/cli/index.ts" },
    exports: { "./application": "./src/application/index.ts" },
    auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] },
  };
  writeFixture(join(runtime, "package.json"), JSON.stringify(manifest));
  writeFixture(indexPath, JSON.stringify(fixtureIndex));
  const sentinel = `throw new Error("INSPECTION_EXECUTED_CODE");`;
  for (const file of [
    "src/cli/index.ts",
    "src/application/index.ts",
    ...Object.values(fixtureIndex.runtime),
    ...fixtureIndex.augments.map((entry) => entry.entrypoint),
  ]) {
    writeFixture(join(runtime, file), sentinel);
  }
  for (const file of [
    "src/index.ts",
    "src/agent.ts",
    "src/http.ts",
    "src/turn.ts",
    "src/augments/orders/index.ts",
  ])
    writeFixture(join(project, file), sentinel);
  writeFixture(
    config,
    `id: aug1_00000000-0000-4000-8000-000000000001\nname: sample\napplication:\n  entrypoint: ./src/index.ts\n  contractVersion: 1\naugments:\n  - type: fileMemory\n    options:\n      source: ./notes.md\n      password: inline-secret-canary\n      token: \${UNSET_SECRET}\n  - name: orders\n    type: custom\n    source: ./src/augments/orders/index.ts\n    options: {}\n`,
  );
  return { root, project, runtime, config, indexPath, manifest };
}
