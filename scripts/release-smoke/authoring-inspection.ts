import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InspectionReport } from "../../src/cli/authoring/contracts";
import { acceptedBuildEnvironment } from "./accepted-main-artifacts";
import {
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  startApplicationChild,
  type PackedArtifactEvidence,
} from "./application-consumer";
import type { GeneratedAuthoringConsumer } from "./authoring-contract";
import {
  assertAuthoringCommandSucceeded,
  readAuthoringSource,
  snapshotGeneratedAuthoringSources,
} from "./authoring-consumer";
import { readBoundedRegularFile } from "./bounded-file";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function assertInstalledAuthoringInspection(
  report: InspectionReport,
  expected: {
    packageRoot: string;
    manifestSHA256: string;
    entrypoint: string;
  },
): void {
  check(
    report.schemaVersion === 1 &&
      report.status === "complete" &&
      report.runtimeDiscovery === "not-evaluated",
    "Inspection must be complete, versioned and explicitly passive",
  );
  check(
    report.runtime.status === "available" &&
      report.runtime.packageRoot === expected.packageRoot &&
      report.runtime.manifestSHA256 === expected.manifestSHA256 &&
      report.runtime.applicationSupported === true,
    "Inspection selected the wrong installed runtime",
  );
  check(
    report.application.mode === "application" &&
      report.application.contractVersion === 1 &&
      report.application.source?.path === expected.entrypoint,
    "Inspection omitted owned application declaration",
  );
  check(
    report.execution.basis === "conventional-project-files",
    "Inspection overstated its source traversal",
  );
  for (const key of ["startup", "composition", "http", "turn"] as const)
    check(
      report.execution[key]?.ownership === "project" &&
        report.execution[key]?.status === "available",
      "Inspection cannot navigate owned execution files",
    );
  for (const key of ["application", "host", "turn"] as const)
    check(
      report.execution.runtime[key]?.ownership === "package" &&
        report.execution.runtime[key]?.status === "available",
      "Inspection cannot navigate installed runtime implementation",
    );
  check(
    report.augments.length > 0 &&
      report.augments.some(
        (augment) =>
          augment.type === "webTransport" &&
          augment.source.status === "available" &&
          augment.source.ownership === "package",
      ),
    "Inspection lacks installed built-in source navigation",
  );
}

/** Fixed throwing source proves passive dispatch never evaluates runtime, provider or user modules. */
export async function runGeneratedAuthoringInspection(options: {
  repoRoot: string;
  workspace: string;
  consumer: GeneratedAuthoringConsumer;
  global: { consumer: string; core: PackedArtifactEvidence };
  evidenceDirectory: string;
}): Promise<void> {
  const { consumer } = options.consumer;
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const local = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.consumer.core,
    "auggy/cli",
  );
  const runtime = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.consumer.core,
    "auggy/application",
  );
  const provider = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.consumer.provider,
    "@auggy/anthropic",
  );
  const global = assertInstalledApplicationArtifact(
    options.global.consumer,
    options.repoRoot,
    options.global.core,
    "auggy/cli",
  );
  check(
    options.global.core.version !== options.consumer.core.version,
    "Inspection needs a distinct synthetic global version to falsify global metadata selection",
  );
  const original = snapshotGeneratedAuthoringSources({
    repoRoot: options.repoRoot,
    consumer,
    sourceFiles: options.consumer.sourceFiles,
  });
  const lock = applicationHash(readFileSync(join(consumer, "bun.lock")));
  const trap = readFileSync(
    join(options.repoRoot, "tests/fixtures/authoring/passive-import.ts.txt"),
  );
  check(trap.byteLength < 1024, "Passive fixture exceeded bound");
  const targets = [
    join(consumer, "src/index.ts"),
    runtime.entry,
    provider.entry,
    join(local.packageRoot, "src/transports/web-transport.ts"),
    join(local.packageRoot, "src/cli/cli-program.ts"),
    join(global.packageRoot, "src/cli/cli-program.ts"),
  ];
  check(new Set(targets).size === targets.length, "Passive trap targets overlap");
  const originals = targets.map((file) => ({
    file,
    ...readBoundedRegularFile(file, 2 * 1024 * 1024),
  }));
  const reports: object[] = [];
  let status = "failed";
  const failures: unknown[] = [];
  try {
    for (const target of targets) writeFileSync(target, trap);
    for (const [name, entry] of [
      ["local", local.entry],
      ["global", global.entry],
    ] as const) {
      const result = await startApplicationChild({
        command: [process.execPath, "--no-env-file", entry, "inspect", "--json"],
        cwd: consumer,
        env: acceptedBuildEnvironment(options.workspace),
        secrets: [],
      }).finish();
      writeFileSync(
        join(options.evidenceDirectory, `${name}-command.json`),
        `${JSON.stringify(result, null, 2)}\n`,
        { mode: 0o600 },
      );
      assertAuthoringCommandSucceeded(result);
      const report = JSON.parse(result.stdout) as InspectionReport;
      check(
        report.inspector.version ===
          (name === "global" ? options.global.core.version : options.consumer.core.version),
        "Inspection launcher version was not independently observed",
      );
      assertInstalledAuthoringInspection(report, {
        packageRoot: local.packageRoot,
        manifestSHA256: applicationHash(readAuthoringSource(local.packageRoot, "package.json")),
        entrypoint: join(consumer, "src/index.ts"),
      });
      check(
        !JSON.stringify(report).includes("authoring-passive-import-forbidden"),
        "Inspection leaked imported module content",
      );
      reports.push({ launcher: name, report, stderrSHA256: result.stderrSHA256 });
    }
    status = "passed";
  } catch (error) {
    failures.push(error);
  } finally {
    const primaryFailures = failures.length;
    for (const original of originals) {
      try {
        writeFileSync(original.file, original.bytes);
        check(
          applicationHash(readBoundedRegularFile(original.file, 2 * 1024 * 1024).bytes) ===
            applicationHash(original.bytes),
          "Passive trap restoration changed source",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      assertInstalledApplicationArtifact(
        consumer,
        options.repoRoot,
        options.consumer.core,
        "auggy/cli",
      );
      assertInstalledApplicationArtifact(
        consumer,
        options.repoRoot,
        options.consumer.provider,
        "@auggy/anthropic",
      );
      assertInstalledApplicationArtifact(
        options.global.consumer,
        options.repoRoot,
        options.global.core,
        "auggy/cli",
      );
      assertOnlyApplicationEdits(
        original,
        snapshotGeneratedAuthoringSources({
          repoRoot: options.repoRoot,
          consumer,
          sourceFiles: options.consumer.sourceFiles,
        }),
        [],
      );
      check(
        applicationHash(readFileSync(join(consumer, "bun.lock"))) === lock,
        "Passive inspection changed lock",
      );
    } catch (error) {
      failures.push(error);
    }
    writeFileSync(
      join(options.evidenceDirectory, "inspection.json"),
      `${JSON.stringify({ status: failures.length ? "failed" : status, scope: "synthetic unequal-version global inspector; unpublished artifacts", traps: targets, fixtureSHA256: applicationHash(trap), reports, restored: failures.length === primaryFailures }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (failures.length)
    throw new AggregateError(failures, "Passive inspection or restoration failed");
}
