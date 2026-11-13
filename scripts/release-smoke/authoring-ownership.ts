/** Retained dependency replacement on actual generated output, never a copied reference. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { runDependencyAudit } from "../audit-dependencies";
import {
  applicationHash,
  assertApplicationCapability,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  inspectApplicationArtifact,
  type PackedArtifactEvidence,
  type PackedArtifactInput,
} from "./application-consumer";
import {
  assertAuthoringCommandSucceeded,
  prepareAuthoringWorkspace,
  readAuthoringSource,
  runAuthoringBuild,
  runBoundedAuthoringCli,
  snapshotGeneratedAuthoringSources,
} from "./authoring-consumer";
import type { FileHashes, GeneratedAuthoringConsumer } from "./authoring-contract";
import { readBoundedRegularFile } from "./bounded-file";
import { assertFreshGeneratedServiceState } from "./authoring-launchd";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export interface GeneratedOwnershipOptions {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  consumer: GeneratedAuthoringConsumer;
  candidateCore: PackedArtifactInput;
  baselineCore: PackedArtifactInput;
  provider: PackedArtifactInput;
}

/** Private credential digests are comparison inputs only, never evidence output. */
export interface RetainedAuthoringSnapshot {
  source: FileHashes;
  state: FileHashes;
  credentialSHA256: string;
}

export function assertRetainedAuthoringOwnership(
  before: RetainedAuthoringSnapshot,
  after: RetainedAuthoringSnapshot,
): void {
  check(
    Object.keys(before.source).length > 0 && Object.keys(before.state).length > 0,
    "Ownership proof requires actual source and durable state",
  );
  assertOnlyApplicationEdits(before.source, after.source, []);
  assertOnlyApplicationEdits(before.state, after.state, []);
  check(
    /^[a-f0-9]{64}$/.test(before.credentialSHA256) &&
      before.credentialSHA256 === after.credentialSHA256,
    "Dependency replacement changed private credential bytes",
  );
}

export function ownershipChangedMembers(
  baseline: PackedArtifactEvidence,
  candidate: PackedArtifactEvidence,
): string[] {
  assertApplicationCapability(baseline.manifest);
  assertApplicationCapability(candidate.manifest);
  check(baseline.sha256 !== candidate.sha256, "Ownership update needs distinct actual artifacts");
  const members = Object.keys(candidate.fileHashes).filter(
    (file) =>
      baseline.fileHashes[file] !== undefined &&
      baseline.fileHashes[file] !== candidate.fileHashes[file],
  );
  check(members.length > 0, "Ownership update needs an observed changed installed member");
  return members;
}

const CUSTOM_FILES = [
  "src/augments/retained-capability/index.ts",
  "src/augments/retained-capability/schemas.ts",
  "src/augments/retained-capability/service.ts",
  "src/augments/retained-capability/README.md",
  "tests/augments/retained-capability.test.ts",
  "skills/retained-capability/SKILL.md",
] as const;
const STATE_FILES = [
  "data/workspace/README.md",
  "data/ownership.sqlite",
  "data/ownership-note.json",
] as const;

/** A/B means exact artifact bytes; this does not claim a published version upgrade. */
export async function runGeneratedOwnershipUpdate(options: GeneratedOwnershipOptions) {
  prepareAuthoringWorkspace(options.workspace);
  const repoRoot = realpathSync(options.repoRoot),
    consumer = realpathSync(options.consumer.consumer);
  const evidence = resolve(options.evidenceDirectory);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    state: "running",
    cleanupConfirmed: false,
    experiment: "exact-artifact-A/B; not a published release upgrade",
    commands: [],
    credentialBytesArchived: false,
    credentialHashesArchived: false,
  };
  const write = () =>
    writeFileSync(
      join(evidence, "authoring-ownership.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  write();
  let markerPath: string | undefined;
  let primary: unknown;
  let commandEvidenceIncomplete = false;
  let markerOwned = false;
  try {
    const candidate = inspectApplicationArtifact(options.candidateCore);
    const baseline = inspectApplicationArtifact(options.baselineCore);
    const provider = inspectApplicationArtifact(options.provider);
    check(
      candidate.sha256 === options.consumer.core.sha256 &&
        provider.sha256 === options.consumer.provider.sha256 &&
        provider.packageName === "@auggy/anthropic",
      "Ownership fixture must use its exact generated candidate and Anthropic adapter",
    );
    const changedMembers = ownershipChangedMembers(baseline, candidate);
    report.generatedState = assertFreshGeneratedServiceState(consumer);
    const original = snapshotGeneratedAuthoringSources({
      repoRoot,
      consumer,
      sourceFiles: options.consumer.sourceFiles,
    });
    assertOnlyApplicationEdits(options.consumer.installedSources, original, []);
    const cli = assertInstalledApplicationArtifact(consumer, repoRoot, candidate, "auggy/cli");
    assertInstalledApplicationArtifact(consumer, repoRoot, provider, "@auggy/anthropic");
    const initialConfig = parse(readAuthoringSource(consumer, "agent.yaml").toString("utf8"));
    check(
      typeof initialConfig?.id === "string" && initialConfig.id.length > 0,
      "Generated identity missing",
    );
    let create: Awaited<ReturnType<typeof runBoundedAuthoringCli>>;
    try {
      create = await runBoundedAuthoringCli({
        entry: cli.entry,
        args: ["augment", "create", "retained-capability", "--with-skill"],
        cwd: consumer,
        workspace: options.workspace,
      });
    } catch (error) {
      commandEvidenceIncomplete = true;
      throw error;
    }
    (report.commands as unknown[]).push({ phase: "actual-custom-authoring", ...create });
    assertAuthoringCommandSucceeded(create);
    const files = [...options.consumer.sourceFiles, ...CUSTOM_FILES];
    const afterAuthoring = snapshotGeneratedAuthoringSources({
      repoRoot,
      consumer,
      sourceFiles: files,
    });
    for (const file of ["src/index.ts", "src/agent.ts", "src/http.ts", "src/turn.ts"])
      check(
        afterAuthoring[file] === original[file],
        "Custom creation changed generated execution source",
      );
    for (const [file, addition] of [
      ["src/turn.ts", '\nexport const retainedTurnRevision = "customer-owned-turn";\n'],
      [
        "src/augments/retained-capability/service.ts",
        '\nexport const retainedDomainRevision = "customer-owned-domain";\n',
      ],
      [
        "skills/retained-capability/SKILL.md",
        "\nCustomer-owned instructions retained across dependency updates.\n",
      ],
    ] as const) {
      writeFileSync(
        join(consumer, file),
        Buffer.concat([readAuthoringSource(consumer, file), Buffer.from(addition)]),
      );
    }
    const envPath = join(consumer, ".env");
    const environment = readBoundedRegularFile(envPath, 64 * 1024);
    check((environment.mode & 0o077) === 0, "Generated credential file must be private");
    writeFileSync(
      envPath,
      Buffer.concat([
        environment.bytes,
        Buffer.from("\nAUGGY_OWNERSHIP_SENTINEL=private-fixture-only\n"),
      ]),
      { mode: 0o600 },
    );
    const db = new Database(join(consumer, "data/ownership.sqlite"), { create: true });
    try {
      db.exec("CREATE TABLE retained_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.query("INSERT INTO retained_state VALUES (?, ?)").run("sample", "retained-domain-state");
    } finally {
      db.close();
    }
    writeFileSync(
      join(consumer, "data/ownership-note.json"),
      '{"source":"owned-system-of-record-fixture","revision":7}\n',
      { mode: 0o600, flag: "wx" },
    );
    const ownedFiles = files.filter((file) => file !== "package.json");
    const snapshot = (): RetainedAuthoringSnapshot => ({
      source: Object.fromEntries(
        ownedFiles.map((file) => [file, applicationHash(readAuthoringSource(consumer, file))]),
      ),
      state: Object.fromEntries(
        STATE_FILES.map((file) => [
          file,
          applicationHash(readBoundedRegularFile(join(consumer, file), 2 * 1024 * 1024).bytes),
        ]),
      ),
      credentialSHA256: applicationHash(readBoundedRegularFile(envPath, 64 * 1024).bytes),
    });
    const owned = snapshot();
    const manifestPath = join(consumer, "package.json");
    const originalManifest = JSON.parse(
      readAuthoringSource(consumer, "package.json").toString("utf8"),
    );
    check(
      originalManifest.dependencies?.auggy === `file:${realpathSync(options.candidateCore.path)}`,
      "Generated manifest did not retain its candidate dependency",
    );
    const run = async (label: string, command: readonly string[]) => {
      try {
        const result = await runAuthoringBuild({
          ...options,
          consumer,
          evidenceDirectory: evidence,
          label,
          command,
        });
        (report.commands as unknown[]).push({ label, ...result });
      } catch (error) {
        try {
          const result = JSON.parse(
            readBoundedRegularFile(join(evidence, `${label}.json`), 64 * 1024).bytes.toString(
              "utf8",
            ),
          );
          (report.commands as unknown[]).push({ label, ...result });
        } catch {
          commandEvidenceIncomplete = true;
        }
        throw error;
      }
    };
    const select = async (
      label: string,
      input: PackedArtifactInput,
      expected: PackedArtifactEvidence,
    ) => {
      const manifest = structuredClone(originalManifest);
      manifest.dependencies.auggy = `file:${realpathSync(input.path)}`;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await run(`${label}-install`, [process.execPath, "install", "--ignore-scripts"]);
      check(
        JSON.stringify(
          JSON.parse(readAuthoringSource(consumer, "package.json").toString("utf8")),
        ) === JSON.stringify(manifest),
        "Dependency replacement changed unrelated package fields",
      );
      assertRetainedAuthoringOwnership(owned, snapshot());
      assertInstalledApplicationArtifact(consumer, repoRoot, provider, "@auggy/anthropic");
      return assertInstalledApplicationArtifact(consumer, repoRoot, expected, "auggy/application");
    };
    const installedA = await select("baseline-a", options.baselineCore, baseline);
    await run("baseline-a-typecheck", [process.execPath, "run", "typecheck"]);
    const modules = join(consumer, "node_modules"),
      moduleIdentity = lstatSync(modules);
    const marker = randomUUID();
    markerPath = join(modules, `.auggy-ownership-${marker}`);
    writeFileSync(markerPath, marker, { flag: "wx", mode: 0o600 });
    markerOwned = true;
    const lockBefore = applicationHash(
      readBoundedRegularFile(join(consumer, "bun.lock"), 2 * 1024 * 1024).bytes,
    );
    const observedBefore = Object.fromEntries(
      changedMembers.map((file) => [
        file,
        applicationHash(
          readBoundedRegularFile(join(installedA.packageRoot, file), 2 * 1024 * 1024).bytes,
        ),
      ]),
    );
    let wrongSelectionRejected = false;
    try {
      assertInstalledApplicationArtifact(consumer, repoRoot, candidate, "auggy/application");
    } catch {
      wrongSelectionRejected = true;
    }
    check(wrongSelectionRejected, "Candidate provenance verifier accepted baseline package bytes");
    const installedB = await select("candidate-b", options.candidateCore, candidate);
    const updatedIdentity = lstatSync(modules);
    check(
      updatedIdentity.dev === moduleIdentity.dev &&
        updatedIdentity.ino === moduleIdentity.ino &&
        readBoundedRegularFile(markerPath, 128).bytes.toString("utf8") === marker,
      "Dependency update replaced the retained node_modules directory",
    );
    const lockAfter = applicationHash(
      readBoundedRegularFile(join(consumer, "bun.lock"), 2 * 1024 * 1024).bytes,
    );
    const observedAfter = Object.fromEntries(
      changedMembers.map((file) => [
        file,
        applicationHash(
          readBoundedRegularFile(join(installedB.packageRoot, file), 2 * 1024 * 1024).bytes,
        ),
      ]),
    );
    for (const file of changedMembers)
      check(
        observedBefore[file] === baseline.fileHashes[file] &&
          observedAfter[file] === candidate.fileHashes[file] &&
          observedBefore[file] !== observedAfter[file],
        "Installed A/B member transition was not observed",
      );
    await run("candidate-b-frozen", [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    await run("candidate-b-typecheck", [process.execPath, "run", "typecheck"]);
    await run("candidate-b-tests", [process.execPath, "run", "test"]);
    const audit = runDependencyAudit({
      cwd: consumer,
      evidencePath: join(evidence, "dependency-audit.json"),
    });
    check(audit.status === "passed", "Retained generated consumer dependency audit failed");
    assertRetainedAuthoringOwnership(owned, snapshot());
    assertInstalledApplicationArtifact(consumer, repoRoot, candidate, "auggy/application");
    assertInstalledApplicationArtifact(consumer, repoRoot, provider, "@auggy/anthropic");
    check(
      JSON.stringify(JSON.parse(readAuthoringSource(consumer, "package.json").toString("utf8"))) ===
        JSON.stringify(originalManifest),
      "Final verification changed unrelated package fields",
    );
    check(
      applicationHash(readBoundedRegularFile(join(consumer, "bun.lock"), 2 * 1024 * 1024).bytes) ===
        lockAfter,
      "Frozen verification changed the retained lock",
    );
    check(
      parse(readAuthoringSource(consumer, "agent.yaml").toString("utf8")).id === initialConfig.id,
      "Dependency replacement changed agent identity",
    );
    Object.assign(report, {
      state: "passed",
      samePackageVersion: baseline.version === candidate.version,
      before: { coreSHA256: baseline.sha256, version: baseline.version, lockSHA256: lockBefore },
      after: { coreSHA256: candidate.sha256, version: candidate.version, lockSHA256: lockAfter },
      installedMembers: { before: observedBefore, after: observedAfter },
      generatedSources: original,
      authoredSources: afterAuthoring,
      ownedSourceHashes: owned.source,
      durableStateHashes: owned.state,
      nodeModulesRetained: true,
      privateCredentialsUnchanged: true,
      identityPreserved: true,
      wrongArtifactRejected: wrongSelectionRejected,
      nonDependencyManifestFieldsPreserved: true,
      fixtureChanges: [
        "actual augment create --with-skill",
        "owned turn/domain exports and skill instruction",
        "private env sentinel",
        "closed SQLite and JSON domain-state fixtures",
        "explicit dependency artifact A/B selection",
      ],
    });
  } catch (error) {
    primary = error;
    report.state = "failed";
    report.failure =
      error instanceof Error ? error.message : "Generated ownership verification failed";
  } finally {
    try {
      if (markerPath && markerOwned) unlinkSync(markerPath);
      // Build/CLI helpers only report success after their process groups are reaped.
      report.cleanupConfirmed =
        !commandEvidenceIncomplete &&
        (report.commands as Record<string, unknown>[]).every(
          (command) => command.cleanupUnknown !== true && command.cleanupConfirmed !== false,
        );
    } catch {
      report.cleanupConfirmed = false;
      report.state = "failed";
    }
    write();
  }
  if (primary) throw primary;
  check(report.cleanupConfirmed, "Generated ownership process or marker cleanup was not confirmed");
  return report;
}
