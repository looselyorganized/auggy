import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { parseConfigFileTextToJson } from "typescript";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runDependencyAudit } from "../audit-dependencies";
import { redactEvidence } from "./export-evidence";
import { runPackedTurn } from "./packed-turn";
import { runPackedLink } from "./packed-link";

const BASELINE = "29147dfc7af0de59c3631c34a164ed3f3f6f4d5c";
const FIXTURE = "tests/fixtures/release-upgrade/retained-lock";
const HISTORICAL_LINK_VERSION = "0.1.2";
const HISTORICAL = {
  "@modelcontextprotocol/sdk": "1.29.0",
  zod: "4.3.6",
  hono: "4.12.34",
  "@hono/node-server": "2.0.11",
};
const LEGACY_SERVER_ADVISORIES = [
  "GHSA-rmxm-3fg6-px4f",
  "GHSA-qv5m-9pm6-hqp3",
  "GHSA-jpvv-r467-5p4w",
];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path: string) => sha(readFileSync(path));
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
type Manifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  [key: string]: unknown;
};
const manifestAt = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"));
export function hasLegacyServerAdvisory(ids: Array<string | null>): boolean {
  return ids.some((id) => id !== null && LEGACY_SERVER_ADVISORIES.includes(id));
}

export function candidateLinkRange(catalog: unknown): string {
  check(Array.isArray(catalog), "Candidate augment catalog must be an array");
  const range = catalog.find((entry) => entry?.type === "link")?.packageDeps?.["@auggy/link"];
  check(
    typeof range === "string" && /^(?:\^|~)?\d+\.\d+\.\d+$/.test(range),
    "Candidate Link range must declare an explicit dependency floor",
  );
  check(
    Bun.semver.order(range.replace(/^[~^]/, ""), "0.2.0") >= 0,
    "Candidate Link floor must include the reviewed 0.2.0 migration",
  );
  return range;
}

export function validateLinkArtifact(manifest: Manifest, range: string): string {
  check(
    manifest.name === "@auggy/link" &&
      typeof manifest.version === "string" &&
      Bun.semver.satisfies(manifest.version, range) &&
      Bun.semver.satisfies(manifest.version, ">=0.2.0"),
    "Link artifact name/version does not satisfy the candidate catalog",
  );
  return manifest.version;
}

export function classifyUpgrade(
  baseline: string,
  candidate: string,
): "same-version-content-change" | "versioned-upgrade" {
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  check(
    version.test(baseline) && version.test(candidate),
    "Upgrade requires valid package versions",
  );
  check(
    Bun.semver.order(candidate, baseline) >= 0,
    "Candidate must not downgrade the baseline runtime",
  );
  return candidate === baseline ? "same-version-content-change" : "versioned-upgrade";
}

/** Rebind local pack bytes only; registry versions/integrities never change. */
export function rebindLocalArtifactIntegrity(
  lockText: string,
  artifacts: Record<string, Buffer>,
): string {
  const parsed = parseConfigFileTextToJson("bun.lock", lockText);
  check(!parsed.error, "Cannot parse retained Bun lock");
  const lock = parsed.config;
  check(lock?.lockfileVersion === 1 && lock.packages, "Unsupported retained lock format");
  let changed = false;
  for (const [name, bytes] of Object.entries(artifacts)) {
    const entry = lock.packages[name];
    check(
      Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        entry[0].includes("@./artifacts/") &&
        typeof entry.at(-1) === "string" &&
        entry.at(-1).startsWith("sha512-"),
      "Unexpected local artifact entry in retained lock",
    );
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (entry.at(-1) !== integrity) {
      entry[entry.length - 1] = integrity;
      changed = true;
    }
  }
  return changed ? `${JSON.stringify(lock, null, 2)}\n` : lockText;
}

export function migrateConsumerManifest(
  current: Manifest,
  policy: Record<string, string>,
): Manifest {
  check(
    current.overrides === undefined ||
      (typeof current.overrides === "object" &&
        current.overrides !== null &&
        !Array.isArray(current.overrides)),
    "Consumer overrides must be an object",
  );
  check(
    Object.keys(policy).length > 0 &&
      Object.values(policy).every((version) => /^\d+\.\d+\.\d+$/.test(version)),
    "Candidate policy must contain exact dependency versions",
  );
  return { ...current, overrides: { ...current.overrides, ...policy } };
}

export function belowFloor(version: string, range: string): boolean {
  const parse = (value: string) =>
    /^(?:\^|~|>=)?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const actual = parse(version),
    floor = parse(range);
  check(actual && floor, "Unsupported version format in upgrade dependency floor");
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== floor[i]) return actual[i]! < floor[i]!;
  }
  return false;
}

export function installedPackage(
  anchor: string,
  name: string,
): { root: string; manifest: Manifest } {
  const resolver = createRequire(join(anchor, "package.json"));
  const canonicalAnchor = realpathSync(anchor);
  const moduleBoundary = canonicalAnchor.indexOf(`${sep}node_modules${sep}`);
  const consumer = moduleBoundary < 0 ? canonicalAnchor : canonicalAnchor.slice(0, moduleBoundary);
  // Metadata inspection does not require a runnable root export. MCP exposes
  // usable client subpaths while its advertised root entry is absent.
  // Start from the owning package to preserve nested/isolated dependency edges.
  // Bun maps packages such as ws/undici to built-ins and returns null search
  // paths. Their installed package metadata still belongs in the audited graph.
  const fallbackPaths: string[] = [];
  for (
    let current = canonicalAnchor;
    current === consumer || current.startsWith(`${consumer}${sep}`);
    current = dirname(current)
  )
    fallbackPaths.push(join(current, "node_modules"));
  for (const directory of resolver.resolve.paths(name) ?? fallbackPaths) {
    const file = join(directory, name, "package.json");
    if (!existsSync(file)) continue;
    const root = realpathSync(dirname(file));
    const canonicalFile = realpathSync(file);
    check(
      root.startsWith(`${consumer}${sep}node_modules${sep}`) &&
        canonicalFile.startsWith(`${consumer}${sep}node_modules${sep}`),
      "Dependency metadata escaped the isolated consumer",
    );
    const manifest = manifestAt(canonicalFile);
    check(
      typeof manifest.name === "string" && typeof manifest.version === "string",
      `Invalid installed metadata for ${name}`,
    );
    return { root, manifest };
  }
  throw new Error(`Installed package metadata missing for ${name}`);
}

function productionPackages(consumer: string): Array<{ root: string; manifest: Manifest }> {
  const queue = [consumer],
    visited = new Set<string>(),
    packages: Array<{ root: string; manifest: Manifest }> = [];
  while (queue.length) {
    const owner = queue.shift()!;
    if (visited.has(owner)) continue;
    visited.add(owner);
    const manifest = manifestAt(join(owner, "package.json"));
    if (owner !== consumer) packages.push({ root: owner, manifest });
    for (const name of Object.keys(manifest.dependencies ?? {}))
      queue.push(installedPackage(owner, name).root);
  }
  return packages;
}

interface CommandRecord {
  label: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutSHA256: string;
  stderrSHA256: string;
}
function environment(workspace: string): Record<string, string> {
  const npm = Bun.which("npm");
  check(npm, "npm is required to pack the historical source without scripts");
  const home = join(workspace, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = join(workspace, "tmp");
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  return {
    PATH: `${dirname(process.execPath)}:${dirname(npm)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: temp,
    CI: "1",
    NO_COLOR: "1",
    npm_config_userconfig: "/dev/null",
    npm_config_cache: join(workspace, "npm-cache"),
    BUN_INSTALL_CACHE_DIR: join(workspace, "bun-cache"),
  };
}

function command(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  label: string,
  evidenceDir?: string,
  records?: CommandRecord[],
): Buffer {
  const started = Date.now();
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  records?.push({
    label,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    stdoutSHA256: sha(stdout),
    stderrSHA256: sha(stderr),
  });
  if (evidenceDir)
    writeFileSync(
      join(evidenceDir, `${label}.log`),
      redactEvidence(Buffer.concat([stdout, stderr]).toString("utf8").slice(-200_000), []),
      { mode: 0o600 },
    );
  check(
    !result.error && result.status === 0 && !result.signal,
    `${label} failed; see bounded command evidence`,
  );
  return stdout;
}

function buildBaseline(
  repoRoot: string,
  workspace: string,
  env: Record<string, string>,
  records: CommandRecord[],
): string {
  const source = join(workspace, "baseline-source");
  mkdirSync(source);
  const artifactDir = join(workspace, "consumer", "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const archive = command(
    repoRoot,
    [
      "git",
      "archive",
      BASELINE,
      "package.json",
      "src",
      "LICENSE",
      "README.md",
      "CHANGELOG.md",
      "SECURITY.md",
      "packages/anthropic",
    ],
    env,
    "baseline-git-archive",
    undefined,
    records,
  );
  const unpack = spawnSync("tar", ["-xf", "-", "-C", source], {
    input: archive,
    env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  check(unpack.status === 0 && !unpack.error, "Could not unpack baseline Git source");
  for (const [directory, target] of [
    [source, "auggy-baseline.tgz"],
    [join(source, "packages/anthropic"), "auggy-anthropic-baseline.tgz"],
  ]) {
    const output = command(
      directory!,
      ["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", artifactDir],
      env,
      `pack-${target}`,
      undefined,
      records,
    )
      .toString("utf8")
      .trim()
      .split("\n")
      .at(-1)!;
    check(
      output === basename(output) && output.endsWith(".tgz"),
      "Unexpected npm pack artifact filename",
    );
    renameSync(join(artifactDir, output), join(artifactDir, target!));
  }
  return artifactDir;
}

function historicalInventory(consumer: string): Record<string, string> {
  const core = installedPackage(consumer, "auggy"),
    sdk = installedPackage(core.root, "@modelcontextprotocol/sdk");
  return {
    "@modelcontextprotocol/sdk": sdk.manifest.version!,
    zod: installedPackage(core.root, "zod").manifest.version!,
    hono: installedPackage(sdk.root, "hono").manifest.version!,
    "@hono/node-server": installedPackage(sdk.root, "@hono/node-server").manifest.version!,
  };
}

/** Regeneration is intentionally explicit; ordinary upgrade tests never rewrite the fixture. */
export function regenerateRetainedLock(repoRoot: string): void {
  check(Bun.version === "1.3.14", "Retained lock generation requires Bun1.3.14");
  const workspace = mkdtempSync(join(tmpdir(), "auggy-upgrade-fixture-"));
  const env = environment(workspace),
    records: CommandRecord[] = [];
  try {
    const artifacts = buildBaseline(repoRoot, workspace, env, records),
      consumer = dirname(artifacts);
    const manifest: Manifest = {
      name: "auggy-retained-lock-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      overrides: { "@hono/node-server": "2.0.11" },
      dependencies: {
        auggy: "file:./artifacts/auggy-baseline.tgz",
        "@auggy/anthropic": "file:./artifacts/auggy-anthropic-baseline.tgz",
        "@modelcontextprotocol/sdk": "1.29.0",
        zod: "4.3.6",
        hono: "4.12.34",
      },
    };
    json(join(consumer, "package.json"), manifest);
    command(
      consumer,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "historical-seed",
      undefined,
      records,
    );
    delete manifest.dependencies!["@modelcontextprotocol/sdk"];
    delete manifest.dependencies!.zod;
    delete manifest.dependencies!.hono;
    json(join(consumer, "package.json"), manifest);
    command(
      consumer,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "retain-historical-transitives",
      undefined,
      records,
    );
    const lockHash = fileHash(join(consumer, "bun.lock"));
    command(
      consumer,
      [process.execPath, "install", "--ignore-scripts", "--frozen-lockfile"],
      env,
      "historical-frozen",
      undefined,
      records,
    );
    check(fileHash(join(consumer, "bun.lock")) === lockHash, "Frozen generation changed the lock");
    check(
      JSON.stringify(historicalInventory(consumer)) === JSON.stringify(HISTORICAL),
      "Historical transitive versions were not retained",
    );
    const fixture = join(repoRoot, FIXTURE);
    mkdirSync(fixture, { recursive: true });
    for (const name of ["package.json", "bun.lock"])
      copyFileSync(join(consumer, name), join(fixture, name));
    json(join(fixture, "provenance.json"), {
      schema: 1,
      baselineRevision: BASELINE,
      baselineTree: command(
        repoRoot,
        ["git", "rev-parse", `${BASELINE}^{tree}`],
        env,
        "baseline-tree",
      )
        .toString()
        .trim(),
      bunVersion: Bun.version,
      npmVersion: command(consumer, ["npm", "--version"], env, "npm-version").toString().trim(),
      historicalVersions: HISTORICAL,
      baselineArtifacts: Object.fromEntries(
        ["auggy-baseline.tgz", "auggy-anthropic-baseline.tgz"].map((name) => [
          name,
          fileHash(join(artifacts, name)),
        ]),
      ),
      fixtureFiles: Object.fromEntries(
        ["package.json", "bun.lock"].map((name) => [name, fileHash(join(fixture, name))]),
      ),
      method:
        "Real Bun lock recreated from exact baseline Git source. Pack with --ignore-scripts; temporarily seed historical MCP/Zod/hono direct versions, remove those three seeds, install retaining lock/node_modules, then verify frozen install. This records a recreated historical graph, not an original historical timestamp. The baseline runtime and dependency lifecycle scripts are never executed.",
      commands: records,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runUpgradeConsumer(options: {
  candidateCore: string;
  candidateAnthropic: string;
  candidateCli: string;
  /** Explicit pre-publication experiment only; default release gate uses registry. */
  candidateLink?: string;
  repoRoot: string;
  evidenceDir: string;
}): Promise<void> {
  check(Bun.version === "1.3.14", "Upgrade acceptance requires Bun1.3.14");
  const repoRoot = realpathSync(options.repoRoot),
    evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "auggy-upgrade-consumer-")),
    env = environment(workspace);
  const records: CommandRecord[] = [],
    phases: Record<string, { status: string; [key: string]: unknown }> = Object.fromEntries(
      [
        "baseline",
        "retainedOverride",
        "migration",
        "candidateTurn",
        "linkBaseline",
        "linkSelected",
        "linkFresh",
      ].map((name) => [name, { status: "pending" }]),
    ),
    failures: string[] = [];
  let status: "running" | "passed" | "failed" = "running";
  const sourceRevision = command(repoRoot, ["git", "rev-parse", "HEAD"], env, "source-revision")
    .toString()
    .trim();
  const report = () =>
    json(join(evidenceDir, "upgrade.json"), {
      schema: 1,
      status,
      sourceRevision,
      baselineRevision: BASELINE,
      bun: Bun.version,
      platform: process.platform,
      phases,
      failures,
      commands: records,
      retainedWorkspace: status === "passed" ? null : workspace,
    });
  report();
  try {
    const fixture = join(repoRoot, FIXTURE),
      provenance = JSON.parse(readFileSync(join(fixture, "provenance.json"), "utf8"));
    check(
      provenance.baselineRevision === BASELINE && provenance.bunVersion === Bun.version,
      "Fixture provenance mismatch",
    );
    for (const name of ["package.json", "bun.lock"])
      check(
        fileHash(join(fixture, name)) === provenance.fixtureFiles[name],
        `Retained fixture ${name} hash mismatch`,
      );
    const artifacts = buildBaseline(repoRoot, workspace, env, records),
      consumer = dirname(artifacts);
    for (const name of ["package.json", "bun.lock"])
      copyFileSync(join(fixture, name), join(consumer, name));
    const artifactBindings: Record<string, unknown> = {};
    for (const [name, packageName, sourcePath] of [
      ["auggy-baseline.tgz", "auggy", "package.json"],
      ["auggy-anthropic-baseline.tgz", "@auggy/anthropic", "packages/anthropic/package.json"],
    ]) {
      const packed = command(
        consumer,
        ["tar", "-xOf", join(artifacts, name!), "package/package.json"],
        env,
        `inspect-${name}`,
      );
      const original = command(
        repoRoot,
        ["git", "show", `${BASELINE}:${sourcePath}`],
        env,
        `source-${name}`,
      );
      check(
        JSON.stringify(JSON.parse(packed.toString())) ===
          JSON.stringify(JSON.parse(original.toString())),
        "Historical pack metadata differs from exact baseline source",
      );
      artifactBindings[packageName!] = {
        fixtureSHA256: provenance.baselineArtifacts[name!],
        actualSHA256: fileHash(join(artifacts, name!)),
        sourceManifestSHA256: sha(original),
        packedManifestSHA256: sha(packed),
      };
    }
    const fixtureLockText = readFileSync(join(consumer, "bun.lock"), "utf8");
    const boundLock = rebindLocalArtifactIntegrity(fixtureLockText, {
      auggy: readFileSync(join(artifacts, "auggy-baseline.tgz")),
      "@auggy/anthropic": readFileSync(join(artifacts, "auggy-anthropic-baseline.tgz")),
    });
    writeFileSync(join(consumer, "bun.lock"), boundLock);
    const applicationPath = join(consumer, "application-owned.ts");
    writeFileSync(
      applicationPath,
      "// User-owned execution source survives dependency-only migration.\nexport const applicationRevision = 'retained';\n",
    );
    const applicationHash = fileHash(applicationPath);
    for (const folder of ["filesystem", "webTransport"]) {
      mkdirSync(join(consumer, "augments", folder), { recursive: true });
      writeFileSync(
        join(consumer, "augments", folder, "augment.yaml"),
        `type: ${folder}\nconfig: {}\n`,
      );
    }
    writeFileSync(
      join(consumer, "agent.yaml"),
      `id: aug1_${randomUUID()}\nname: upgrade-consumer\nengine:\n  provider: anthropic\n  model: claude-sonnet-4-5\naugments:\n  - filesystem\n  - webTransport\n`,
    );
    writeFileSync(join(consumer, ".env"), "", { mode: 0o600 });
    const projectFiles = [
      "application-owned.ts",
      "agent.yaml",
      ".env",
      "augments/filesystem/augment.yaml",
      "augments/webTransport/augment.yaml",
    ];
    const projectSourceHashes = Object.fromEntries(
      projectFiles.map((file) => [file, fileHash(join(consumer, file))]),
    );
    const initialLock = fileHash(join(consumer, "bun.lock"));
    command(
      consumer,
      [process.execPath, "install", "--ignore-scripts", "--frozen-lockfile"],
      env,
      "baseline-install",
      evidenceDir,
      records,
    );
    check(
      fileHash(join(consumer, "bun.lock")) === initialLock,
      "Baseline frozen install changed retained lock",
    );
    const oldVersions = historicalInventory(consumer);
    check(
      JSON.stringify(oldVersions) === JSON.stringify(HISTORICAL),
      "The consumer is not using the required historical dependency graph",
    );
    const retainedMarker = join(consumer, "node_modules/.auggy-upgrade-retention"),
      marker = randomUUID();
    writeFileSync(retainedMarker, marker);
    const modulesIdentity = {
      dev: statSync(join(consumer, "node_modules")).dev,
      ino: statSync(join(consumer, "node_modules")).ino,
    };
    const assertRetained = (expectedProjectHashes = projectSourceHashes) => {
      const current = statSync(join(consumer, "node_modules"));
      check(
        current.dev === modulesIdentity.dev &&
          current.ino === modulesIdentity.ino &&
          readFileSync(retainedMarker, "utf8") === marker,
        "Upgrade discarded the existing node_modules tree",
      );
      check(
        fileHash(applicationPath) === applicationHash,
        "Dependency upgrade changed application-owned source",
      );
      for (const [file, expected] of Object.entries(expectedProjectHashes))
        check(
          fileHash(join(consumer, file)) === expected,
          `Dependency upgrade changed application file: ${file}`,
        );
    };
    phases.baseline = {
      status: "passed",
      lockSHA256: initialLock,
      fixtureLockSHA256: sha(fixtureLockText),
      localArtifactIntegrityRebound: boundLock !== fixtureLockText,
      versions: oldVersions,
      sourceFixtureSHA256: fileHash(join(fixture, "provenance.json")),
      artifacts: artifactBindings,
      applicationSourceSHA256: applicationHash,
      projectSourceHashes,
      lifecycleScripts: "disabled",
      runtimeExecuted: false,
    };
    report();
    copyFileSync(options.candidateCore, join(artifacts, "auggy-candidate.tgz"));
    copyFileSync(options.candidateAnthropic, join(artifacts, "auggy-anthropic-candidate.tgz"));
    const candidateBytes = command(
      consumer,
      ["tar", "-xOf", join(artifacts, "auggy-candidate.tgz"), "package/package.json"],
      env,
      "candidate-manifest",
    );
    const candidate: Manifest = JSON.parse(candidateBytes.toString());
    const baselineVersion = installedPackage(consumer, "auggy").manifest.version;
    check(candidate.name === "auggy", "Upgrade candidate must be the auggy package");
    const transitionKind = classifyUpgrade(baselineVersion ?? "", candidate.version ?? "");
    check(
      fileHash(options.candidateCore) !== provenance.baselineArtifacts["auggy-baseline.tgz"],
      "Candidate artifact is identical to baseline",
    );
    const changed = manifestAt(join(consumer, "package.json"));
    changed.dependencies!.auggy = "file:./artifacts/auggy-candidate.tgz";
    changed.dependencies!["@auggy/anthropic"] = "file:./artifacts/auggy-anthropic-candidate.tgz";
    json(join(consumer, "package.json"), changed);
    const beforeNegativeLock = fileHash(join(consumer, "bun.lock"));
    command(
      consumer,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "retained-override-install",
      evidenceDir,
      records,
    );
    assertRetained();
    const installedCore = installedPackage(consumer, "auggy");
    check(
      fileHash(join(installedCore.root, "package.json")) === sha(candidateBytes),
      "Upgrade did not install candidate B metadata",
    );
    const candidateCodeHashes: Record<string, string> = {};
    for (const file of [
      "src/cli/index.ts",
      "src/kernel/turn-loop.ts",
      "src/cli/scaffold-package-json.ts",
      "src/cli/augment-catalog.ts",
      "src/cli/augment-resolver.ts",
      "src/cli/agent-isolation.ts",
    ]) {
      const bytes = command(
        consumer,
        ["tar", "-xOf", join(artifacts, "auggy-candidate.tgz"), `package/${file}`],
        env,
        "candidate-code",
      );
      candidateCodeHashes[file] = sha(bytes);
      check(
        fileHash(join(installedCore.root, file)) === sha(bytes),
        `Installed core code did not match candidate B: ${file}`,
      );
    }
    check(
      fileHash(realpathSync(options.candidateCli)) === candidateCodeHashes["src/cli/index.ts"],
      "Supplied packed candidate CLI differs from artifact B",
    );
    const policyProbe = join(consumer, ".upgrade-policy.ts");
    writeFileSync(
      policyProbe,
      `import { SCAFFOLD_SECURITY_OVERRIDES } from "./node_modules/auggy/src/cli/scaffold-package-json.ts";\nimport { AUGMENT_CATALOG } from "./node_modules/auggy/src/cli/augment-catalog.ts";\nconsole.log(JSON.stringify({overrides:SCAFFOLD_SECURITY_OVERRIDES,catalog:AUGMENT_CATALOG}));\n`,
    );
    const candidatePolicy = JSON.parse(
      command(
        consumer,
        [process.execPath, policyProbe],
        env,
        "candidate-policy",
        undefined,
        records,
      ).toString(),
    );
    rmSync(policyProbe);
    const policy: Record<string, string> = candidatePolicy.overrides;
    const linkRange = candidateLinkRange(candidatePolicy.catalog);
    let linkSpecifier = linkRange;
    let linkSelection: Record<string, unknown> = {
      kind: "registry-range",
      requestedRange: linkRange,
    };
    let linkArtifactVersion: string | undefined;
    if (options.candidateLink) {
      const candidateLinkPath = realpathSync(options.candidateLink);
      const manifest = JSON.parse(
        command(
          consumer,
          ["tar", "-xOf", candidateLinkPath, "package/package.json"],
          env,
          "link-artifact-manifest",
        ).toString(),
      );
      linkArtifactVersion = validateLinkArtifact(manifest, linkRange);
      const installedArtifactPath = join(artifacts, "auggy-link-candidate.tgz");
      copyFileSync(candidateLinkPath, installedArtifactPath);
      linkSpecifier = `file:${installedArtifactPath}`;
      linkSelection = {
        kind: "local-artifact-experiment",
        requestedRange: linkRange,
        version: linkArtifactVersion,
        artifactSHA256: fileHash(installedArtifactPath),
        registryReleaseVerified: false,
      };
    }
    check(
      policy["@hono/node-server"] && belowFloor("2.0.11", policy["@hono/node-server"]),
      "Candidate policy does not repair the historical application override",
    );
    const retainedSdk = installedPackage(installedCore.root, "@modelcontextprotocol/sdk");
    const retainedOverride = installedPackage(retainedSdk.root, "@hono/node-server").manifest
      .version;
    check(
      retainedOverride === "2.0.11",
      "Negative control did not retain the old application override",
    );
    const negativeAudit = runDependencyAudit({
      cwd: consumer,
      evidencePath: join(evidenceDir, "retained-override-audit.json"),
    });
    check(
      negativeAudit.advisoryPackages !== null &&
        negativeAudit.advisoryPackages > 0 &&
        negativeAudit.advisories.length > 0 &&
        (negativeAudit.exitCode === 0 || negativeAudit.exitCode === 1) &&
        negativeAudit.signal === null &&
        ["advisories", "command-failed"].includes(negativeAudit.failure ?? ""),
      "Negative audit did not produce verified advisory evidence",
    );
    check(
      hasLegacyServerAdvisory(negativeAudit.advisories.map((advisory) => advisory.id)),
      "Negative audit lacks an expected historical Hono server advisory",
    );
    phases.retainedOverride = {
      status: "expected-rejection-observed",
      retainedOverride,
      requiredOverride: policy["@hono/node-server"],
      lockBeforeSHA256: beforeNegativeLock,
      lockAfterSHA256: fileHash(join(consumer, "bun.lock")),
      nodeModulesRetained: true,
      candidateVersion: candidate.version,
      baselineVersion,
      transitionKind,
      candidateSHA256: fileHash(options.candidateCore),
      candidateManifestSHA256: sha(candidateBytes),
      auditStatus: negativeAudit.status,
    };
    report();
    const migrated = migrateConsumerManifest(changed, policy);
    json(join(consumer, "package.json"), migrated);
    const beforeMigrationLock = fileHash(join(consumer, "bun.lock"));
    command(
      consumer,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "dependency-migration-install",
      evidenceDir,
      records,
    );
    assertRetained();
    const upgradedCore = installedPackage(consumer, "auggy");
    for (const [file, expected] of Object.entries(candidateCodeHashes))
      check(
        fileHash(join(upgradedCore.root, file)) === expected,
        `Migration replaced candidate core code: ${file}`,
      );
    const upgradedCli = realpathSync(join(consumer, "node_modules/.bin/auggy"));
    check(
      upgradedCli === realpathSync(join(upgradedCore.root, "src/cli/index.ts")),
      "Upgrade acceptance CLI is not owned by the retained consumer",
    );
    const floorResults: Record<string, { actual: string; required: string; satisfied: boolean }> =
      {};
    for (const name of ["@modelcontextprotocol/sdk", "zod"]) {
      const actual = installedPackage(upgradedCore.root, name).manifest.version!;
      const required = candidate.dependencies?.[name];
      check(required, `Candidate is missing ${name} dependency floor`);
      floorResults[name] = { actual, required, satisfied: !belowFloor(actual, required) };
    }
    const productionGraph = productionPackages(consumer);
    for (const [name, required] of Object.entries(policy)) {
      const occurrences = productionGraph.filter((entry) => entry.manifest.name === name);
      check(occurrences.length > 0, `Candidate runtime policy package is absent: ${name}`);
      const versions = [...new Set(occurrences.map((entry) => entry.manifest.version!))].sort();
      floorResults[name] = {
        actual: versions.join(", "),
        required,
        satisfied: versions.every((version) => version === required),
      };
    }
    const floorsPass = Object.values(floorResults).every((entry) => entry.satisfied);
    if (!floorsPass)
      failures.push("Migrated consumer does not satisfy candidate dependency policy");
    const positiveAudit = runDependencyAudit({
      cwd: consumer,
      evidencePath: join(evidenceDir, "migrated-consumer-audit.json"),
    });
    if (positiveAudit.status !== "passed") failures.push("Migrated consumer audit failed");
    phases.migration = {
      status: floorsPass && positiveAudit.status === "passed" ? "passed" : "failed",
      policy,
      floors: floorResults,
      lockBeforeSHA256: beforeMigrationLock,
      lockAfterSHA256: fileHash(join(consumer, "bun.lock")),
      nodeModulesRetained: true,
      auditStatus: positiveAudit.status,
    };
    report();
    if (floorsPass && positiveAudit.status === "passed") {
      try {
        await runPackedTurn({
          cli: upgradedCli,
          agentDir: consumer,
          home: env.HOME!,
          evidenceDir: join(evidenceDir, "candidate-turn"),
          repoRoot,
        });
        check(
          fileHash(join(consumer, "application-owned.ts")) === applicationHash,
          "Candidate acceptance changed application source",
        );
        phases.candidateTurn = {
          status: "passed",
          applicationSourceSHA256: applicationHash,
          installedCli: upgradedCli,
          candidateCodeHashes,
        };
      } catch {
        failures.push("Migrated candidate turn acceptance failed");
        phases.candidateTurn = { status: "failed" };
      }
    } else
      phases.candidateTurn = {
        status: "skipped",
        reason: "Dependency policy/audit prerequisite failed",
      };
    // Independent historical selected arm: exact core A + Link0.1.2 before
    // upgrading core/provider/Link and policy together. Never run the old graph.
    const selected = join(workspace, "selected-link");
    mkdirSync(join(selected, "artifacts"), { recursive: true });
    for (const name of ["auggy-baseline.tgz", "auggy-anthropic-baseline.tgz"])
      copyFileSync(join(artifacts, name), join(selected, "artifacts", name));
    copyFileSync(join(fixture, "package.json"), join(selected, "package.json"));
    writeFileSync(join(selected, "bun.lock"), boundLock);
    for (const file of projectFiles) {
      mkdirSync(dirname(join(selected, file)), { recursive: true });
      copyFileSync(join(consumer, file), join(selected, file));
    }
    mkdirSync(join(selected, "workspace"));
    writeFileSync(
      join(selected, "workspace/operator-note.txt"),
      "Operator-owned workspace data survives the coupled upgrade.\n",
    );
    const selectedConfig = parseYaml(readFileSync(join(selected, "agent.yaml"), "utf8"));
    selectedConfig.augments.push("link");
    writeFileSync(join(selected, "agent.yaml"), stringifyYaml(selectedConfig));
    mkdirSync(join(selected, "augments/link"));
    writeFileSync(
      join(selected, "augments/link/augment.yaml"),
      stringifyYaml({
        type: "link",
        config: {
          port: 57321,
          dbPath: "./data/link-upgrade.db",
          agentCard: {
            id: randomUUID(),
            name: "retained-link",
            description: "Retained operator-owned Link configuration",
            endpointUrl: "http://127.0.0.1:57321",
          },
          peers: {},
        },
      }),
    );
    const linkProjectHashes = {
      ...projectSourceHashes,
      "workspace/operator-note.txt": fileHash(join(selected, "workspace/operator-note.txt")),
      "agent.yaml": fileHash(join(selected, "agent.yaml")),
      "augments/link/augment.yaml": fileHash(join(selected, "augments/link/augment.yaml")),
    };
    const linkManifest = manifestAt(join(selected, "package.json"));
    linkManifest.dependencies!["@auggy/link"] = HISTORICAL_LINK_VERSION;
    json(join(selected, "package.json"), linkManifest);
    command(
      selected,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "link-historical-install",
      evidenceDir,
      records,
    );
    check(
      JSON.stringify(historicalInventory(selected)) === JSON.stringify(HISTORICAL),
      "Selected historical core dependency graph changed unexpectedly",
    );
    const selectedMarker = join(selected, "node_modules/.auggy-link-retention"),
      selectedNonce = randomUUID();
    writeFileSync(selectedMarker, selectedNonce);
    const selectedModules = statSync(join(selected, "node_modules"));
    const assertSelectedRetained = () => {
      const current = statSync(join(selected, "node_modules"));
      check(
        current.dev === selectedModules.dev &&
          current.ino === selectedModules.ino &&
          readFileSync(selectedMarker, "utf8") === selectedNonce,
        "Selected upgrade replaced node_modules",
      );
      for (const [file, expected] of Object.entries(linkProjectHashes))
        check(
          fileHash(join(selected, file)) === expected,
          `Selected upgrade changed application/config/workspace file: ${file}`,
        );
    };
    assertSelectedRetained();
    const oldCore = installedPackage(selected, "auggy");
    const oldCoreCodeHashes: Record<string, string> = {};
    for (const file of ["package.json", ...Object.keys(candidateCodeHashes)]) {
      const packed = command(
        selected,
        ["tar", "-xOf", join(artifacts, "auggy-baseline.tgz"), `package/${file}`],
        env,
        "selected-baseline-core",
      );
      oldCoreCodeHashes[file] = sha(packed);
      check(
        fileHash(join(oldCore.root, file)) === sha(packed),
        "Selected baseline did not install core artifact A",
      );
    }
    check(
      Object.entries(candidateCodeHashes).some(
        ([file, expected]) => oldCoreCodeHashes[file] !== expected,
      ),
      "Selected experiment lacks a distinguishing A/B implementation hash",
    );
    const oldLink = installedPackage(selected, "@auggy/link");
    check(
      oldLink.manifest.version === HISTORICAL_LINK_VERSION,
      "Historical selected Link did not install 0.1.2",
    );
    const linkBaselineLock = fileHash(join(selected, "bun.lock"));
    phases.linkBaseline = {
      status: "passed",
      coreVersion: oldCore.manifest.version,
      coreCodeHashes: oldCoreCodeHashes,
      linkVersion: oldLink.manifest.version,
      lockSHA256: linkBaselineLock,
      packageSHA256: fileHash(join(oldLink.root, "package.json")),
      sdkEntrySHA256: fileHash(join(oldLink.root, "dist/index.js")),
      runtimeExecuted: false,
      lifecycleScripts: "disabled",
      projectSourceHashes: linkProjectHashes,
      note: "Separate consumer installs historical core A and selected Link0.1.2 before the coupled candidate upgrade; old runtime is never executed.",
    };
    report();
    const upgradedSelection = migrateConsumerManifest(
      {
        ...linkManifest,
        dependencies: {
          ...linkManifest.dependencies,
          auggy: `file:${join(artifacts, "auggy-candidate.tgz")}`,
          "@auggy/anthropic": `file:${join(artifacts, "auggy-anthropic-candidate.tgz")}`,
          "@auggy/link": linkSpecifier,
        },
      },
      policy,
    );
    json(join(selected, "package.json"), upgradedSelection);
    check(
      fileHash(join(selected, "bun.lock")) === linkBaselineLock,
      "Link upgrade replaced its retained lock before installation",
    );
    command(
      selected,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "link-selected-upgrade",
      evidenceDir,
      records,
    );
    assertSelectedRetained();
    for (const [file, expected] of Object.entries(candidateCodeHashes))
      check(
        fileHash(join(installedPackage(selected, "auggy").root, file)) === expected,
        "Coupled selected upgrade did not install candidate core B",
      );
    const link = installedPackage(selected, "@auggy/link"),
      linkZod = installedPackage(link.root, "zod");
    check(
      typeof link.manifest.version === "string" &&
        Bun.semver.satisfies(link.manifest.version, linkRange),
      "Selected Link does not match candidate catalog",
    );
    if (linkArtifactVersion)
      check(
        link.manifest.version === linkArtifactVersion,
        "Installed Link differs from selected artifact version",
      );
    const linkCodeHashes = Object.fromEntries(
      [
        "package.json",
        "dist/index.js",
        "dist/client/peer.js",
        "dist/client/response-body.js",
        "dist/protocol/types.js",
        "dist/protocol/validation-budget.js",
      ].map((file) => [file, fileHash(join(link.root, file))]),
    );
    if (options.candidateLink)
      for (const [file, expected] of Object.entries(linkCodeHashes)) {
        const packed = command(
          selected,
          ["tar", "-xOf", join(artifacts, "auggy-link-candidate.tgz"), `package/${file}`],
          env,
          "link-artifact-code",
        );
        check(sha(packed) === expected, "Installed Link code differs from selected artifact");
      }
    check(
      typeof linkZod.manifest.version === "string" &&
        !belowFloor(linkZod.manifest.version, "4.6.6"),
      "Selected Link did not install the reviewed Zod floor",
    );
    const linkAudit = runDependencyAudit({
      cwd: selected,
      evidencePath: join(evidenceDir, "link-selected-audit.json"),
    });
    phases.linkSelected = {
      status: linkAudit.status,
      requestedRange: linkRange,
      selection: linkSelection,
      baselineLockSHA256: linkBaselineLock,
      projectSourceHashes: linkProjectHashes,
      candidateCodeHashes,
      linkVersion: link.manifest.version,
      zodVersion: linkZod.manifest.version,
      packageSHA256: fileHash(join(link.root, "package.json")),
      sdkEntrySHA256: fileHash(join(link.root, "dist/index.js")),
      codeHashes: linkCodeHashes,
      auditFailure: linkAudit.failure,
      advisoryPackages: linkAudit.advisoryPackages,
      advisories: linkAudit.advisories,
      lockSHA256: fileHash(join(selected, "bun.lock")),
      nodeModulesRetained: true,
    };
    if (linkAudit.status !== "passed")
      failures.push("Link-selected consumer audit failed; no advisory exemption applied");
    else {
      try {
        await runPackedLink({
          cli: realpathSync(join(selected, "node_modules/.bin/auggy")),
          agentDir: selected,
          home: env.HOME!,
          evidenceDir: join(evidenceDir, "link-retained"),
          repoRoot,
        });
        assertSelectedRetained();
        phases.linkSelected.runtime = "passed";
      } catch {
        phases.linkSelected.status = "failed";
        phases.linkSelected.runtime = "failed";
        failures.push("Retained Link-selected runtime acceptance failed");
      }
    }
    report();
    // A fresh selected consumer is independent of the retained lock experiment.
    const fresh = join(workspace, "fresh-link");
    mkdirSync(fresh);
    json(join(fresh, "package.json"), {
      name: "fresh-link-acceptance",
      private: true,
      type: "module",
      dependencies: {
        auggy: `file:${join(artifacts, "auggy-candidate.tgz")}`,
        "@auggy/anthropic": `file:${join(artifacts, "auggy-anthropic-candidate.tgz")}`,
        "@auggy/link": linkSpecifier,
      },
      overrides: policy,
    });
    writeFileSync(join(fresh, "agent.yaml"), `id: aug1_${randomUUID()}\nname: fresh-link\n`);
    command(
      fresh,
      [process.execPath, "install", "--ignore-scripts"],
      env,
      "link-fresh-install",
      evidenceDir,
      records,
    );
    const freshLink = installedPackage(fresh, "@auggy/link");
    for (const [file, expected] of Object.entries(linkCodeHashes))
      check(
        fileHash(join(freshLink.root, file)) === expected,
        "Fresh/retained Link implementation differs",
      );
    check(
      freshLink.manifest.version === link.manifest.version &&
        fileHash(join(freshLink.root, "dist/index.js")) ===
          fileHash(join(link.root, "dist/index.js")),
      "Fresh/retained Link installed different SDK artifacts",
    );
    for (const [file, expected] of Object.entries(candidateCodeHashes))
      check(
        fileHash(join(installedPackage(fresh, "auggy").root, file)) === expected,
        "Fresh consumer core differs from candidate artifact",
      );
    const freshAudit = runDependencyAudit({
      cwd: fresh,
      evidencePath: join(evidenceDir, "link-fresh-audit.json"),
    });
    phases.linkFresh = {
      status: freshAudit.status,
      selection: linkSelection,
      linkVersion: freshLink.manifest.version,
      sdkEntrySHA256: fileHash(join(freshLink.root, "dist/index.js")),
      codeHashes: linkCodeHashes,
      lockSHA256: fileHash(join(fresh, "bun.lock")),
      auditFailure: freshAudit.failure,
    };
    if (freshAudit.status !== "passed") failures.push("Fresh Link-selected audit failed");
    else {
      try {
        await runPackedLink({
          cli: realpathSync(join(fresh, "node_modules/.bin/auggy")),
          agentDir: fresh,
          home: env.HOME!,
          evidenceDir: join(evidenceDir, "link-fresh"),
          repoRoot,
        });
        phases.linkFresh.runtime = "passed";
      } catch {
        phases.linkFresh.status = "failed";
        phases.linkFresh.runtime = "failed";
        failures.push("Fresh Link-selected runtime acceptance failed");
      }
    }
  } catch (error) {
    failures.push(redactEvidence(String(error), []));
  } finally {
    if (!failures.length) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        failures.push("Upgrade workspace cleanup failed");
      }
    }
    status = failures.length ? "failed" : "passed";
    for (const phase of Object.values(phases))
      if (phase.status === "pending") {
        phase.status = "skipped";
        phase.reason = "An earlier prerequisite failed";
      }
    report();
  }
  check(
    failures.length === 0,
    `Retained-lock upgrade acceptance failed (${failures.length} issue(s)); see upgrade.json`,
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "candidate-core": { type: "string" },
      "candidate-anthropic": { type: "string" },
      "candidate-cli": { type: "string" },
      "candidate-link": { type: "string" },
      "repo-root": { type: "string" },
      "evidence-dir": { type: "string" },
      "regenerate-fixture": { type: "boolean" },
    },
    strict: true,
  });
  check(values["repo-root"], "Missing --repo-root");
  if (values["regenerate-fixture"]) regenerateRetainedLock(resolve(values["repo-root"]));
  else {
    for (const name of [
      "candidate-core",
      "candidate-anthropic",
      "candidate-cli",
      "evidence-dir",
    ] as const)
      check(values[name], `Missing --${name}`);
    await runUpgradeConsumer({
      candidateCore: resolve(values["candidate-core"]!),
      candidateAnthropic: resolve(values["candidate-anthropic"]!),
      candidateCli: resolve(values["candidate-cli"]!),
      ...(values["candidate-link"] ? { candidateLink: resolve(values["candidate-link"]) } : {}),
      repoRoot: resolve(values["repo-root"]),
      evidenceDir: resolve(values["evidence-dir"]!),
    });
  }
}
