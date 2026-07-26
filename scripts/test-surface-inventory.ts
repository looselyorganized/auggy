import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type TestSuite = "runtime" | "admin" | "external";
export type TestSelectorKind = "exact" | "children" | "tree";

export interface TestSurfaceSelector {
  kind: TestSelectorKind;
  path: string;
  exclude?: string[];
  allowEmpty?: true;
}

export interface TestSurfaceShardManifest {
  id: string;
  suite: TestSuite;
  selectors: TestSurfaceSelector[];
}

export interface TestSurfaceManifest {
  schema: 1;
  shards: TestSurfaceShardManifest[];
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  stage: number;
}

export interface ResolvedTestShard {
  id: string;
  suite: TestSuite;
  files: string[];
}

export interface TestSurfaceInventory {
  shards: ResolvedTestShard[];
  runtimeFiles: number;
  adminFiles: number;
  externalFiles: number;
}

export interface BunTestInvocation {
  cwd: string;
  argv: string[];
}

const ROOT = resolve(import.meta.dir, "..");
const MANIFEST_PATH = "tests/ci/test-surface-manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GIT_TREE_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_ENTRIES = 100_000;
const TEST_FILE_PATTERN = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;
const SAFE_SHARD_ID = /^[a-z][a-z0-9-]{0,31}$/;
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const DISCOVERY_ROOTS: Record<TestSuite, readonly string[]> = {
  external: ["examples/temporal-order-support"],
  runtime: ["tests", "examples", "packages"],
  admin: ["admin/src"],
};

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function fail(message: string): never {
  throw new Error(`[test-surface] ${message}`);
}

function describePath(path: string): string {
  return JSON.stringify(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    fail(`${label} has unknown fields: ${unknown.sort().join(", ")}`);
  }
}

function validateSafePath(path: unknown, label: string): asserts path is string {
  if (typeof path !== "string" || path.length < 1 || path.length > 4096) {
    fail(`${label} must be a nonempty bounded string`);
  }
  if (path !== path.normalize("NFC")) {
    fail(`${label} is not NFC-normalized: ${describePath(path)}`);
  }
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    hasControlCharacter(path)
  ) {
    fail(`${label} is not a canonical repository path: ${describePath(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} contains an unsafe path segment: ${describePath(path)}`);
  }
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function suiteForPath(path: string): TestSuite | null {
  // Isolated examples are nested below the broad examples/ runtime root, so
  // classify their exact dependency boundary before the general roots.
  if (DISCOVERY_ROOTS.external.some((root) => isAtOrBelow(path, root))) return "external";
  for (const [suite, roots] of Object.entries(DISCOVERY_ROOTS) as Array<
    [TestSuite, readonly string[]]
  >) {
    if (roots.some((root) => isAtOrBelow(path, root))) return suite;
  }
  return null;
}

function isBunTestPath(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

function parseManifest(value: unknown): TestSurfaceManifest {
  if (!isRecord(value)) fail("manifest must be an object");
  assertExactKeys(value, ["schema", "shards"], "manifest");
  if (value.schema !== 1) fail("manifest schema must equal 1");
  if (!Array.isArray(value.shards) || value.shards.length === 0) {
    fail("manifest shards must be a nonempty array");
  }

  const ids = new Set<string>();
  const shards = value.shards.map((rawShard, shardIndex): TestSurfaceShardManifest => {
    if (!isRecord(rawShard)) fail(`manifest shard ${shardIndex} must be an object`);
    assertExactKeys(rawShard, ["id", "suite", "selectors"], `manifest shard ${shardIndex}`);
    if (typeof rawShard.id !== "string" || !SAFE_SHARD_ID.test(rawShard.id)) {
      fail(`manifest shard ${shardIndex} has an unsafe id`);
    }
    if (ids.has(rawShard.id)) fail(`manifest has duplicate shard id ${rawShard.id}`);
    ids.add(rawShard.id);
    if (
      rawShard.suite !== "runtime" &&
      rawShard.suite !== "admin" &&
      rawShard.suite !== "external"
    ) {
      fail(`manifest shard ${rawShard.id} has an invalid suite`);
    }
    const suite = rawShard.suite;
    if (!Array.isArray(rawShard.selectors) || rawShard.selectors.length === 0) {
      fail(`manifest shard ${rawShard.id} must declare selectors`);
    }

    const selectorKeys = new Set<string>();
    const selectors = rawShard.selectors.map((rawSelector, selectorIndex): TestSurfaceSelector => {
      if (!isRecord(rawSelector)) {
        fail(`selector ${selectorIndex} in shard ${rawShard.id} must be an object`);
      }
      assertExactKeys(
        rawSelector,
        ["kind", "path", "exclude", "allowEmpty"],
        `selector ${selectorIndex} in shard ${rawShard.id}`,
      );
      if (
        rawSelector.kind !== "exact" &&
        rawSelector.kind !== "children" &&
        rawSelector.kind !== "tree"
      ) {
        fail(`selector ${selectorIndex} in shard ${rawShard.id} has an invalid kind`);
      }
      validateSafePath(rawSelector.path, `selector ${selectorIndex} path in shard ${rawShard.id}`);
      if (!DISCOVERY_ROOTS[suite].some((root) => isAtOrBelow(rawSelector.path as string, root))) {
        fail(
          `selector ${describePath(rawSelector.path as string)} in ${suite} shard ${
            rawShard.id
          } is outside its suite roots`,
        );
      }
      if (rawSelector.allowEmpty !== undefined && rawSelector.allowEmpty !== true) {
        fail(`selector ${selectorIndex} in shard ${rawShard.id} has invalid allowEmpty policy`);
      }
      if (rawSelector.kind === "exact" && rawSelector.allowEmpty === true) {
        fail(`exact selector ${selectorIndex} in shard ${rawShard.id} cannot allow an empty match`);
      }
      const exclude: string[] = [];
      if (rawSelector.exclude !== undefined) {
        if (!Array.isArray(rawSelector.exclude)) {
          fail(`selector ${selectorIndex} exclusion list in shard ${rawShard.id} is invalid`);
        }
        const seenExclusions = new Set<string>();
        for (const [excludeIndex, excluded] of rawSelector.exclude.entries()) {
          validateSafePath(
            excluded,
            `exclusion ${excludeIndex} in selector ${selectorIndex} of shard ${rawShard.id}`,
          );
          if (seenExclusions.has(excluded)) {
            fail(`selector ${selectorIndex} in shard ${rawShard.id} has duplicate exclusions`);
          }
          seenExclusions.add(excluded);
          exclude.push(excluded);
        }
      }
      const selectorKey = JSON.stringify([
        rawSelector.kind,
        rawSelector.path,
        [...exclude].sort(),
        rawSelector.allowEmpty === true,
      ]);
      if (selectorKeys.has(selectorKey)) {
        fail(`shard ${rawShard.id} has a duplicate selector`);
      }
      selectorKeys.add(selectorKey);
      return {
        kind: rawSelector.kind,
        path: rawSelector.path,
        ...(exclude.length > 0 ? { exclude } : {}),
        ...(rawSelector.allowEmpty === true ? { allowEmpty: true as const } : {}),
      };
    });
    return {
      id: rawShard.id,
      suite,
      selectors,
    };
  });

  if (!shards.some((shard) => shard.suite === "runtime")) {
    fail("manifest has no runtime shard");
  }
  if (!shards.some((shard) => shard.suite === "admin")) {
    fail("manifest has no admin shard");
  }
  return { schema: 1, shards };
}

function selectorMatches(selector: TestSurfaceSelector, path: string): boolean {
  const selected =
    selector.kind === "exact"
      ? path === selector.path
      : selector.kind === "children"
        ? dirname(path) === selector.path
        : path.startsWith(`${selector.path}/`);
  return selected && !selector.exclude?.includes(path);
}

function selectorMatchesBeforeExclusion(selector: TestSurfaceSelector, path: string): boolean {
  return selector.kind === "exact"
    ? path === selector.path
    : selector.kind === "children"
      ? dirname(path) === selector.path
      : path.startsWith(`${selector.path}/`);
}

export function validateTestSurface(
  rawEntries: readonly GitTreeEntry[],
  rawManifest: unknown,
): TestSurfaceInventory {
  const manifest = parseManifest(rawManifest);
  const entries = [...rawEntries];
  if (entries.length > MAX_TRACKED_ENTRIES) {
    fail(`tracked tree exceeds ${MAX_TRACKED_ENTRIES} entries`);
  }
  const testCandidates = entries.filter((entry) => isBunTestPath(entry.path));
  const paths = new Set<string>();
  const foldedPaths = new Map<string, string>();

  for (const entry of testCandidates) {
    validateSafePath(entry.path, "tracked path");
    if (paths.has(entry.path)) fail(`duplicate tracked path ${describePath(entry.path)}`);
    paths.add(entry.path);
    const folded = entry.path.toLocaleLowerCase("en-US");
    const existingFold = foldedPaths.get(folded);
    if (existingFold && existingFold !== entry.path) {
      fail(
        `case-fold collision between ${describePath(existingFold)} and ${describePath(entry.path)}`,
      );
    }
    foldedPaths.set(folded, entry.path);
    if (entry.stage !== 0) {
      fail(`tracked test has unresolved Git stage ${entry.stage}: ${describePath(entry.path)}`);
    }
    if (!REGULAR_GIT_MODES.has(entry.mode)) {
      fail(`tracked test is not a regular file: ${describePath(entry.path)} (${entry.mode})`);
    }
  }
  const outsideSuite = testCandidates
    .filter((entry) => suiteForPath(entry.path) === null)
    .sort((a, b) => comparePaths(a.path, b.path));
  if (outsideSuite.length > 0) {
    fail(
      `tracked Bun test is outside declared suite roots: ${describePath(outsideSuite[0]!.path)}`,
    );
  }
  const tests = testCandidates.sort((a, b) => comparePaths(a.path, b.path));

  for (const shard of manifest.shards) {
    for (const selector of shard.selectors) {
      const rootExists = entries.some((entry) => isAtOrBelow(entry.path, selector.path));
      if (!rootExists) {
        fail(`selector ${describePath(selector.path)} in shard ${shard.id} is stale`);
      }
      if (selector.kind === "exact" && !tests.some((entry) => entry.path === selector.path)) {
        fail(`exact selector ${describePath(selector.path)} in shard ${shard.id} is not a test`);
      }
      for (const excluded of selector.exclude ?? []) {
        const candidate = tests.find((entry) => entry.path === excluded);
        if (!candidate || !selectorMatchesBeforeExclusion(selector, excluded)) {
          fail(
            `exclusion ${describePath(excluded)} in selector ${describePath(
              selector.path,
            )} of shard ${shard.id} is missing or outside the selector`,
          );
        }
      }
      if (!selector.allowEmpty && !tests.some((entry) => selectorMatches(selector, entry.path))) {
        fail(
          `selector ${describePath(selector.path)} in shard ${shard.id} resolves to no tracked tests`,
        );
      }
    }
  }

  const resolved = new Map<string, string[]>(manifest.shards.map((shard) => [shard.id, []]));
  for (const entry of tests) {
    const expectedSuite = suiteForPath(entry.path);
    const owners: string[] = [];
    for (const shard of manifest.shards) {
      for (const selector of shard.selectors) {
        if (selectorMatches(selector, entry.path)) owners.push(shard.id);
      }
    }
    if (owners.length === 0) {
      fail(`unassigned tracked test ${describePath(entry.path)}`);
    }
    if (owners.length !== 1) {
      fail(
        `multiple canonical owners for tracked test ${describePath(entry.path)}: ${owners.join(
          ", ",
        )}`,
      );
    }
    const owner = manifest.shards.find((shard) => shard.id === owners[0])!;
    if (owner.suite !== expectedSuite) {
      fail(
        `${owner.suite} shard ${owner.id} cannot own ${expectedSuite} test ${describePath(
          entry.path,
        )}`,
      );
    }
    resolved.get(owner.id)!.push(entry.path);
  }

  const shards = manifest.shards.map((shard): ResolvedTestShard => {
    const files = resolved.get(shard.id)!.sort(comparePaths);
    if (files.length === 0) fail(`shard ${shard.id} resolved to no tracked tests`);
    return { id: shard.id, suite: shard.suite, files };
  });
  const runtimeFiles = shards
    .filter((shard) => shard.suite === "runtime")
    .reduce((sum, shard) => sum + shard.files.length, 0);
  const adminFiles = shards
    .filter((shard) => shard.suite === "admin")
    .reduce((sum, shard) => sum + shard.files.length, 0);
  const externalFiles = shards
    .filter((shard) => shard.suite === "external")
    .reduce((sum, shard) => sum + shard.files.length, 0);
  if (runtimeFiles === 0) fail("runtime test inventory is empty");
  if (adminFiles === 0) fail("admin test inventory is empty");
  return { shards, runtimeFiles, adminFiles, externalFiles };
}

export function readGitTreeEntries(root = ROOT): GitTreeEntry[] {
  const result = Bun.spawnSync(["git", "ls-files", "--stage", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  if (result.exitCode !== 0) fail("git ls-files failed");
  if (result.stdout.byteLength > MAX_GIT_TREE_BYTES) {
    fail("git ls-files output exceeds 16 MiB");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    fail("git ls-files returned a non-UTF-8 path");
  }
  const entries: GitTreeEntry[] = [];
  for (const record of source.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) fail("git ls-files returned malformed stage data");
    const metadata = record.slice(0, tab).split(" ");
    if (metadata.length !== 3) fail("git ls-files returned malformed metadata");
    const stage = Number(metadata[2]);
    if (!Number.isSafeInteger(stage)) fail("git ls-files returned an invalid stage");
    entries.push({
      mode: metadata[0]!,
      stage,
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

export function readTestSurfaceManifest(root = ROOT): TestSurfaceManifest {
  const bytes = readFileSync(join(root, MANIFEST_PATH));
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail("manifest exceeds 64 KiB");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  return parseManifest(value);
}

function validateWorktree(inventory: TestSurfaceInventory, root: string): void {
  const normalizedRoot = resolve(root);
  for (const path of inventory.shards.flatMap((shard) => shard.files)) {
    let current = normalizedRoot;
    for (const segment of path.split("/")) {
      current = join(current, segment);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch {
        fail(`tracked test is missing from the worktree: ${describePath(path)}`);
      }
      if (stat.isSymbolicLink()) {
        fail(`tracked test traverses a worktree symlink: ${describePath(path)}`);
      }
    }
    const relative = current.slice(normalizedRoot.length + (normalizedRoot.endsWith(sep) ? 0 : 1));
    if (relative !== path.split("/").join(sep)) {
      fail(`tracked test resolved outside the repository: ${describePath(path)}`);
    }
    if (!lstatSync(current).isFile()) {
      fail(`tracked test is not a worktree file: ${describePath(path)}`);
    }
  }
}

export function createBunTestInvocation(
  shard: ResolvedTestShard,
  root = ROOT,
  bunExecutable = process.execPath,
): BunTestInvocation {
  const cwd =
    shard.suite === "admin"
      ? join(root, "admin")
      : shard.suite === "external"
        ? join(root, "examples", "temporal-order-support")
        : root;
  const files = shard.files.map((path) =>
    shard.suite === "admin"
      ? `./${path.slice("admin/".length)}`
      : shard.suite === "external"
        ? `./${path.slice("examples/temporal-order-support/".length)}`
        : `./${path}`,
  );
  return {
    cwd,
    argv: [bunExecutable, "test", "--max-concurrency=1", "--timeout=30000", "--", ...files],
  };
}

export function selectExplicitRuntimeFiles(
  inventory: TestSurfaceInventory,
  requested: readonly string[],
): ResolvedTestShard {
  if (requested.length === 0 || requested.length > 512) {
    fail("explicit runtime test list must contain between 1 and 512 paths");
  }
  const inventoried = new Set(
    inventory.shards.filter((shard) => shard.suite === "runtime").flatMap((shard) => shard.files),
  );
  const seen = new Set<string>();
  for (const path of requested) {
    if (seen.has(path)) fail(`explicit runtime test list contains duplicate ${describePath(path)}`);
    seen.add(path);
    if (!inventoried.has(path)) {
      fail(`explicit path is not an inventoried runtime test: ${describePath(path)}`);
    }
  }
  return { id: "explicit-runtime", suite: "runtime", files: [...requested] };
}

async function runShard(shard: ResolvedTestShard, root: string): Promise<number> {
  const invocation = createBunTestInvocation(shard, root);
  const child = Bun.spawn(invocation.argv, {
    cwd: invocation.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return await child.exited;
}

function loadInventory(root: string): TestSurfaceInventory {
  const inventory = validateTestSurface(readGitTreeEntries(root), readTestSurfaceManifest(root));
  validateWorktree(inventory, root);
  return inventory;
}

async function main(args: string[]): Promise<number> {
  const [command, argument, ...extra] = args;
  const inventory = loadInventory(ROOT);

  if (command === "run-runtime-files" && argument) {
    return await runShard(selectExplicitRuntimeFiles(inventory, [argument, ...extra]), ROOT);
  }
  if (extra.length > 0) fail("too many arguments");

  if (command === "check" && argument === undefined) {
    console.log(
      `[test-surface] ${inventory.runtimeFiles} runtime + ${inventory.adminFiles} admin + ${inventory.externalFiles} isolated external tests across ${inventory.shards.length} shards`,
    );
    return 0;
  }
  if (
    command === "matrix" &&
    (argument === "runtime" || argument === "admin" || argument === "external")
  ) {
    console.log(
      JSON.stringify(
        inventory.shards.filter((shard) => shard.suite === argument).map((shard) => shard.id),
      ),
    );
    return 0;
  }
  if (command === "run" && argument) {
    const shard = inventory.shards.find((candidate) => candidate.id === argument);
    if (!shard) fail(`unknown shard id ${JSON.stringify(argument)}`);
    return await runShard(shard, ROOT);
  }
  if (command === "run-runtime" && argument === undefined) {
    for (const shard of inventory.shards.filter((candidate) => candidate.suite === "runtime")) {
      const code = await runShard(shard, ROOT);
      if (code !== 0) return code;
    }
    return 0;
  }
  if (command === "run-all" && argument === undefined) {
    for (const shard of inventory.shards) {
      const code = await runShard(shard, ROOT);
      if (code !== 0) return code;
    }
    return 0;
  }
  fail(
    "usage: bun scripts/test-surface-inventory.ts check|matrix <runtime|admin|external>|run <shard>|run-runtime|run-all",
  );
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "[test-surface] inventory failed");
    process.exitCode = 1;
  }
}
