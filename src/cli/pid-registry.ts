/**
 * Local runtime registry for independently operated Auggy agents.
 *
 * Modern manifests are keyed by immutable config id. Display names remain
 * useful aliases, but an ambiguous alias fails closed. Atomic resource claim
 * files prevent two local agents from consuming one exclusive listener or
 * inbound identity before either transport starts.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { VALID_NAME_RE } from "./config-parser";
import type { PidManifest } from "./types";

interface PidRegistryOptions {
  /** Override `~/.auggy/` for tests. Production callers omit. */
  auggyDir?: string;
  /** Deterministic process-incarnation inspection for tests. */
  processIdentityForPid?: (pid: number) => string | null;
  /** Deterministic concurrency barrier used only by registry tests. */
  onClaimLockAcquired?: (claim: string) => void;
}

interface RuntimePidRegistryOptions extends PidRegistryOptions {
  internalMode?: string;
}

interface ManifestRecord {
  path: string;
  manifest: PidManifest;
}

interface ResourceClaimRecord {
  version: 1 | 2;
  claim: string;
  agentId: string;
  agentName: string;
  pid: number;
  claimNonce: string;
  processIdentity?: string;
}

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RuntimeResourceConflictError extends Error {}

function registryDir(opts: PidRegistryOptions = {}): string {
  return opts.auggyDir ?? join(homedir(), ".auggy");
}

function ensurePrivateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function ensureDir(opts: PidRegistryOptions = {}): string {
  return ensurePrivateDir(registryDir(opts));
}

function claimsDir(opts: PidRegistryOptions = {}): string {
  return ensurePrivateDir(join(ensureDir(opts), "runtime-claims"));
}

function manifestKey(manifest: PidManifest): string {
  return manifest.agentId ?? manifest.name;
}

function manifestPathForKey(key: string, opts: PidRegistryOptions = {}): string {
  return join(registryDir(opts), `${key}.json`);
}

function claimPath(claim: string, opts: PidRegistryOptions = {}): string {
  const digest = createHash("sha256")
    .update("auggy-runtime-resource\0")
    .update(claim)
    .digest("hex");
  return join(claimsDir(opts), `${digest}.json`);
}

function isSafeClaim(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function parseManifest(value: unknown, source: string): PidManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Auggy runtime manifest at ${source}`);
  }
  const record = value as Record<string, unknown>;
  const validBase =
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.name === "string" &&
    VALID_NAME_RE.test(record.name) &&
    (record.port === null ||
      (Number.isSafeInteger(record.port) &&
        (record.port as number) > 0 &&
        (record.port as number) <= 65_535)) &&
    typeof record.configPath === "string" &&
    isAbsolute(record.configPath) &&
    typeof record.agentDir === "string" &&
    isAbsolute(record.agentDir) &&
    typeof record.startedAt === "string" &&
    Number.isFinite(Date.parse(record.startedAt)) &&
    (record.mode === "dev" || record.mode === "launchd");
  if (!validBase) throw new Error(`Invalid Auggy runtime manifest at ${source}`);

  const modernFields = [
    record.agentId,
    record.claimNonce,
    record.processIdentity,
    record.resourceClaims,
  ];
  const hasModernField = modernFields.some((field) => field !== undefined);
  if (hasModernField) {
    if (
      typeof record.agentId !== "string" ||
      !AGENT_ID_RE.test(record.agentId) ||
      typeof record.claimNonce !== "string" ||
      !UUID_RE.test(record.claimNonce) ||
      (record.processIdentity !== undefined && !isSafeClaim(record.processIdentity)) ||
      !Array.isArray(record.resourceClaims) ||
      !record.resourceClaims.every(isSafeClaim) ||
      new Set(record.resourceClaims).size !== record.resourceClaims.length
    ) {
      throw new Error(`Invalid Auggy runtime manifest at ${source}`);
    }
  }
  return record as unknown as PidManifest;
}

function readManifestPath(path: string): PidManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Auggy runtime manifest at ${path}`, { cause: error });
  }
  return parseManifest(parsed, path);
}

function allManifestRecords(opts: PidRegistryOptions = {}): ManifestRecord[] {
  const dir = registryDir(opts);
  if (!existsSync(dir)) return [];
  const records: ManifestRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      records.push({ path, manifest: readManifestPath(path) });
    } catch {
      // Preserve malformed or unrelated JSON for operator inspection. It must
      // never become a signal target and is never deleted implicitly.
    }
  }
  return records;
}

function recordForIdentifier(
  identifier: string,
  opts: PidRegistryOptions = {},
): ManifestRecord | null {
  if (!AGENT_ID_RE.test(identifier) && !VALID_NAME_RE.test(identifier)) {
    throw new Error(`Invalid agent runtime identifier "${identifier}"`);
  }

  const exactPath = manifestPathForKey(identifier, opts);
  if (existsSync(exactPath)) {
    return { path: exactPath, manifest: readManifestPath(exactPath) };
  }
  if (AGENT_ID_RE.test(identifier)) return null;

  const matches = allManifestRecords(opts).filter((record) => record.manifest.name === identifier);
  if (matches.length > 1) {
    throw new Error(
      `Agent name "${identifier}" is ambiguous across ${matches.length} running identities. Use the immutable aug1_ id.`,
    );
  }
  return matches[0] ?? null;
}

/** Check if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return an OS process-incarnation marker that changes when a PID is reused.
 * The marker contains no command line or environment data.
 */
export function getProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterCommand = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTicks = afterCommand[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (startTicks && /^\d+$/.test(startTicks) && UUID_RE.test(bootId)) {
        return `linux:${bootId}:${startTicks}`;
      }
    } catch {
      return null;
    }
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 1_000,
    maxBuffer: 4_096,
  });
  const started = result.status === 0 ? result.stdout.trim() : "";
  if (!started) return null;
  const digest = createHash("sha256")
    .update("auggy-process-incarnation\0")
    .update(process.platform)
    .update("\0")
    .update(started)
    .digest("hex");
  return `ps-sha256:${digest}`;
}

export type RuntimeProcessStatus = "alive" | "gone" | "reused" | "unverifiable";

/** Inspect both PID existence and its recorded OS process incarnation. */
export function inspectRuntimeProcess(
  manifest: Pick<PidManifest, "pid" | "processIdentity">,
  opts: PidRegistryOptions = {},
): RuntimeProcessStatus {
  if (!isProcessAlive(manifest.pid)) return "gone";
  if (!manifest.processIdentity) return "unverifiable";
  const current = (opts.processIdentityForPid ?? getProcessIdentity)(manifest.pid);
  if (!current) return "unverifiable";
  return current === manifest.processIdentity ? "alive" : "reused";
}

/** Write a validated PID manifest atomically without acquiring resource claims. */
export function writePidManifest(manifest: PidManifest, opts: PidRegistryOptions = {}): void {
  ensureDir(opts);
  const key = manifestKey(parseManifest(manifest, "new runtime manifest"));
  writeFileSync(manifestPathForKey(key, opts), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

function parseClaim(value: unknown, source: string): ResourceClaimRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Auggy runtime resource claim at ${source}`);
  }
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    !isSafeClaim(record.claim) ||
    typeof record.agentId !== "string" ||
    !AGENT_ID_RE.test(record.agentId) ||
    typeof record.agentName !== "string" ||
    !VALID_NAME_RE.test(record.agentName) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    typeof record.claimNonce !== "string" ||
    !UUID_RE.test(record.claimNonce) ||
    (record.version === 2 && !isSafeClaim(record.processIdentity)) ||
    (record.version === 1 && record.processIdentity !== undefined)
  ) {
    throw new Error(`Invalid Auggy runtime resource claim at ${source}`);
  }
  return record as unknown as ResourceClaimRecord;
}

function claimLockPath(claim: string, opts: PidRegistryOptions): string {
  return `${claimPath(claim, opts)}.lock`;
}

function withClaimLock<T>(claim: string, opts: PidRegistryOptions, action: () => T): T {
  const path = claimLockPath(claim, opts);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RuntimeResourceConflictError(
        `Runtime resource "${claim}" has another claim operation in progress.`,
      );
    }
    throw error;
  }
  try {
    opts.onClaimLockAcquired?.(claim);
    return action();
  } finally {
    // If lock release fails, propagate the failure. The retained lock then
    // blocks every future mutation until an operator inspects it; continuing
    // would falsely report an exclusive claim as usable.
    rmdirSync(path);
  }
}

function readClaim(path: string): ResourceClaimRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Auggy runtime resource claim at ${path}`, { cause: error });
  }
  return parseClaim(value, path);
}

function unlinkClaimIfOwned(
  claim: string,
  agentId: string,
  claimNonce: string,
  opts: PidRegistryOptions,
): void {
  withClaimLock(claim, opts, () => {
    const path = claimPath(claim, opts);
    if (!existsSync(path)) return;
    const existing = readClaim(path);
    if (existing.agentId !== agentId || existing.claimNonce !== claimNonce) return;
    unlinkSync(path);
  });
}

function acquireOneClaim(claim: string, manifest: PidManifest, opts: PidRegistryOptions): void {
  withClaimLock(claim, opts, () => {
    const path = claimPath(claim, opts);
    const record: ResourceClaimRecord = {
      version: 2,
      claim,
      agentId: manifest.agentId!,
      agentName: manifest.name,
      pid: manifest.pid,
      claimNonce: manifest.claimNonce!,
      processIdentity: manifest.processIdentity!,
    };
    try {
      writeFileSync(path, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readClaim(path);
      const status = inspectRuntimeProcess(existing, opts);
      if (status === "alive" || status === "unverifiable") {
        throw new RuntimeResourceConflictError(
          `Runtime resource "${claim}" is already claimed by agent "${existing.agentName}".`,
        );
      }
      unlinkSync(path);
    }
    writeFileSync(path, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
  });
}

function acquireResourceClaims(manifest: PidManifest, opts: PidRegistryOptions): string[] {
  const claims = [...(manifest.resourceClaims ?? [])].sort();
  if (claims.length === 0) return [];
  if (!manifest.agentId || !manifest.claimNonce) {
    throw new Error("Modern runtime resource claims require immutable agentId and claimNonce");
  }
  if (!manifest.processIdentity) {
    throw new Error("Modern runtime resource claims require an OS process identity");
  }

  const acquired: string[] = [];
  try {
    for (const claim of claims) {
      acquireOneClaim(claim, manifest, opts);
      acquired.push(claim);
    }
    return acquired;
  } catch (error) {
    for (const claim of acquired.reverse()) {
      unlinkClaimIfOwned(claim, manifest.agentId, manifest.claimNonce, opts);
    }
    throw error;
  }
}

function releaseResourceClaims(manifest: PidManifest, opts: PidRegistryOptions): void {
  if (!manifest.agentId || !manifest.claimNonce) return;
  for (const claim of manifest.resourceClaims ?? []) {
    unlinkClaimIfOwned(claim, manifest.agentId, manifest.claimNonce, opts);
  }
}

function removeManifestRecord(record: ManifestRecord, opts: PidRegistryOptions): void {
  releaseResourceClaims(record.manifest, opts);
  if (existsSync(record.path)) unlinkSync(record.path);
}

/**
 * Do not let an identity-keyed runtime overlap a pre-upgrade name-keyed
 * runtime. Legacy manifests did not acquire resource leases, so checking them
 * before modern claims is the only safe upgrade boundary for non-port
 * transports such as Telegram polling.
 */
function removeStaleOrRejectLiveLegacyManifest(
  manifest: PidManifest,
  opts: PidRegistryOptions,
): void {
  if (!manifest.agentId) return;

  const records = new Map<string, ManifestRecord>();
  const exactLegacyPath = manifestPathForKey(manifest.name, opts);
  if (existsSync(exactLegacyPath)) {
    records.set(exactLegacyPath, {
      path: exactLegacyPath,
      manifest: readManifestPath(exactLegacyPath),
    });
  }
  for (const record of allManifestRecords(opts)) {
    if (!record.manifest.agentId) records.set(record.path, record);
  }

  for (const record of records.values()) {
    if (isProcessAlive(record.manifest.pid)) {
      throw new RuntimeResourceConflictError(
        `Legacy runtime for agent "${record.manifest.name}" may still be running. Stop all pre-upgrade runtimes before starting an immutable agent identity.`,
      );
    }
    removeManifestRecord(record, opts);
  }
}

/** Claim the local registry and every declared exclusive resource atomically. */
export function claimRuntimePidManifest(
  manifest: PidManifest,
  opts: RuntimePidRegistryOptions = {},
): boolean {
  if (opts.internalMode === "railway") return false;
  parseManifest(manifest, "new runtime manifest");
  if (manifest.agentId && !manifest.processIdentity) {
    throw new Error("Modern runtime manifests require an OS process identity");
  }
  removeStaleOrRejectLiveLegacyManifest(manifest, opts);
  const acquired = acquireResourceClaims(manifest, opts);
  try {
    try {
      writePidManifest(manifest, opts);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = recordForIdentifier(manifestKey(manifest), opts);
      const status = existing ? inspectRuntimeProcess(existing.manifest, opts) : "gone";
      if (status === "alive" || status === "unverifiable") throw error;
      if (existing) removeManifestRecord(existing, opts);
      writePidManifest(manifest, opts);
      return true;
    }
  } catch (error) {
    if (manifest.agentId && manifest.claimNonce) {
      for (const claim of acquired.reverse()) {
        unlinkClaimIfOwned(claim, manifest.agentId, manifest.claimNonce, opts);
      }
    }
    throw error;
  }
}

/** Release a manifest only when claimRuntimePidManifest actually wrote it. */
export function releaseRuntimePidManifest(
  identifier: string,
  claimed: boolean,
  opts: PidRegistryOptions = {},
): void {
  if (claimed) removePidManifest(identifier, opts);
}

/** Read by immutable id or by an unambiguous display-name alias. */
export function readPidManifest(
  identifier: string,
  opts: PidRegistryOptions = {},
): PidManifest | null {
  return recordForIdentifier(identifier, opts)?.manifest ?? null;
}

/** Read a manifest only when its process is still alive. */
export function readLivePidManifest(
  identifier: string,
  opts: PidRegistryOptions = {},
): PidManifest | null {
  const record = recordForIdentifier(identifier, opts);
  if (!record) return null;
  const status = inspectRuntimeProcess(record.manifest, opts);
  if (status === "alive") return record.manifest;
  if (status === "unverifiable") {
    throw new Error(
      `Cannot verify the process incarnation for agent "${record.manifest.name}"; refusing to treat PID ${record.manifest.pid} as its runtime.`,
    );
  }
  removeManifestRecord(record, opts);
  return null;
}

/** Format a conflict using details from the existing runtime manifest. */
export function formatAgentAlreadyRunningMessage(
  name: string,
  manifest: PidManifest | null,
): string {
  const details = manifest
    ? ` (PID ${manifest.pid}${manifest.port !== null ? `, port ${manifest.port}` : ""})`
    : "";
  const consoleUrl =
    manifest?.port !== null && manifest?.port !== undefined
      ? `\nConsole: http://localhost:${manifest.port}/console`
      : "";

  return `Agent "${name}" is already running${details}.${consoleUrl}\nStop it with: auggy stop ${name}`;
}

/** Remove a manifest and only the resource claims owned by its claim nonce. */
export function removePidManifest(identifier: string, opts: PidRegistryOptions = {}): void {
  const record = recordForIdentifier(identifier, opts);
  if (record) removeManifestRecord(record, opts);
}

/** List live manifests. Malformed files are preserved and never signaled. */
export function listPidManifests(opts: PidRegistryOptions = {}): PidManifest[] {
  const manifests: PidManifest[] = [];
  for (const record of allManifestRecords(opts)) {
    const status = inspectRuntimeProcess(record.manifest, opts);
    if (status === "alive" || status === "unverifiable") {
      manifests.push(record.manifest);
    } else {
      removeManifestRecord(record, opts);
    }
  }
  return manifests;
}

export function tryClaimName(name: string, opts: PidRegistryOptions = {}): boolean {
  try {
    return readLivePidManifest(name, opts) === null;
  } catch {
    return false;
  }
}

export function getAuggyDir(): string {
  return ensureDir();
}
