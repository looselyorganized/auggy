/** Private mutation plans: validate inputs and destinations without writing anything. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AUTHORING_LIMITS,
  type FileSnapshot,
  type MutationPlan,
  type MutationPlanInput,
} from "./contracts";
import { AuthoringError, sameFileIdentity, snapshotHash } from "./document-io";

const KINDS = new Set([
  "init",
  "augment-add",
  "augment-create",
  "augment-install",
  "augment-remove",
  "agentmail-config",
  "migrate",
]);

function reject(code: string, message: string): never {
  throw new AuthoringError(code, message);
}

function control(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function validateRelativePath(value: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    control(value) ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value) > AUTHORING_LIMITS.pathBytes ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    reject(
      "unsafe-destination",
      "Use a normalized, bounded project-relative destination without traversal or control characters.",
    );
  }
}

function snapshotPrecondition(snapshot: FileSnapshot): object {
  return snapshot.exists
    ? {
        path: snapshot.path,
        exists: true,
        identity: {
          dev: snapshot.identity.dev,
          ino: snapshot.identity.ino,
          size: snapshot.identity.size,
          mode: snapshot.identity.mode,
          mtimeNs: snapshot.identity.mtimeNs,
          ctimeNs: snapshot.identity.ctimeNs,
        },
        sha256: snapshot.sha256,
      }
    : { path: snapshot.path, exists: false };
}

function validateSnapshot(snapshot: FileSnapshot): void {
  if (
    typeof snapshot.path !== "string" ||
    !isAbsolute(snapshot.path) ||
    resolve(snapshot.path) !== snapshot.path ||
    control(snapshot.path)
  ) {
    reject("invalid-precondition", "Input snapshots require normalized absolute paths.");
  }
  if (!snapshot.exists) return;
  const { identity, bytes, sha256 } = snapshot;
  if (
    !(bytes instanceof Uint8Array) ||
    !identity ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 0 ||
    identity.size !== bytes.length ||
    bytes.length > AUTHORING_LIMITS.outputBytes ||
    !Number.isSafeInteger(identity.mode) ||
    (identity.mode & 0o170000) !== 0o100000 ||
    ![identity.dev, identity.ino, identity.mtimeNs, identity.ctimeNs].every(
      (value) => typeof value === "string" && /^\d+$/.test(value),
    ) ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    snapshotHash(bytes) !== sha256
  ) {
    reject(
      "invalid-precondition",
      "Input snapshot identity, size and hash must match its private bytes; read a fresh snapshot.",
    );
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.path === right.path &&
    left.exists === right.exists &&
    (!left.exists ||
      (right.exists &&
        left.sha256 === right.sha256 &&
        sameFileIdentity(left.identity, right.identity)))
  );
}

function validateParentChain(projectDir: string, relativePath: string): void {
  let cursor = projectDir;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    try {
      const stats = lstatSync(cursor);
      if (
        stats.isSymbolicLink() ||
        (index < parts.length - 1 ? !stats.isDirectory() : !stats.isFile())
      ) {
        reject(
          "unsafe-destination",
          "Destinations must be regular files below real project directories; review symlinks and special files.",
        );
      }
    } catch (error) {
      if (error instanceof AuthoringError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      reject(
        "unsafe-destination",
        "Cannot validate a destination parent; review directory permissions before retrying.",
      );
    }
  }
}

export function createMutationPlan(input: MutationPlanInput): MutationPlan {
  if (!KINDS.has(input.kind)) reject("invalid-operation", "Unsupported authoring operation.");
  let projectDir: string;
  try {
    projectDir = realpathSync(input.projectDir);
    if (!lstatSync(projectDir).isDirectory())
      reject("invalid-project", "Select an existing project directory.");
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    reject("invalid-project", "Select an existing accessible project directory.");
  }
  validateRelativePath(input.configRelativePath);
  if (
    input.files.length > AUTHORING_LIMITS.plannedWrites ||
    input.inputs.length > AUTHORING_LIMITS.receiptEntries
  )
    reject(
      "plan-limit",
      "The plan exceeds supported file or precondition counts; split it after review.",
    );
  const snapshots = new Map<string, FileSnapshot>();
  let inputBytes = 0;
  for (const snapshot of input.inputs) {
    validateSnapshot(snapshot);
    const previous = snapshots.get(snapshot.path);
    if (previous && !sameSnapshot(previous, snapshot))
      reject(
        "conflicting-precondition",
        "The same input has conflicting snapshots; re-read the entire plan.",
      );
    if (!previous && snapshot.exists) inputBytes += snapshot.bytes.length;
    snapshots.set(snapshot.path, snapshot);
  }
  if (inputBytes > AUTHORING_LIMITS.aggregateInputBytes)
    reject("input-limit", "Plan inputs exceed the aggregate byte limit; reduce the operation.");
  const destinations = new Set<string>();
  const outputs: { path: string; sha256: string; mode: number; role: string }[] = [];
  let outputBytes = 0;
  let activationCount = 0;
  for (const file of input.files) {
    validateRelativePath(file.relativePath);
    const key = file.relativePath.toLowerCase();
    if (
      destinations.has(key) ||
      [...destinations].some((other) => other.startsWith(`${key}/`) || key.startsWith(`${other}/`))
    )
      reject(
        "duplicate-destination",
        "Planned destinations overlap or collide by case; choose unique file paths.",
      );
    destinations.add(key);
    const initialModelSnapshot =
      input.kind === "init" &&
      file.relativePath === ".auggy/models.lock.json" &&
      file.role === "support" &&
      !file.before.exists &&
      file.mode === 0o600;
    if (
      !initialModelSnapshot &&
      file.relativePath.split("/").some((part) => [".git", ".auggy"].includes(part.toLowerCase()))
    )
      reject(
        "reserved-destination",
        "Authoring outputs cannot modify repository metadata or private operation state.",
      );
    validateSnapshot(file.before);
    const absolutePath = join(projectDir, file.relativePath);
    if (file.before.path !== absolutePath)
      reject(
        "destination-precondition",
        "Destination and before-snapshot must identify the same contained file.",
      );
    const expected = snapshots.get(absolutePath);
    if (!expected || !sameSnapshot(expected, file.before))
      reject(
        "destination-precondition",
        "Every destination requires the identical before-snapshot in plan inputs.",
      );
    validateParentChain(projectDir, file.relativePath);
    if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777)
      reject("invalid-mode", "Output file modes must contain only ordinary permission bits.");
    if (!(file.bytes instanceof Uint8Array) || file.bytes.length > AUTHORING_LIMITS.outputBytes)
      reject("output-limit", "A planned file exceeds the supported output byte limit.");
    outputBytes += file.bytes.length;
    switch (file.role) {
      case "activation":
        if (file.bytes.length > AUTHORING_LIMITS.documentBytes)
          reject("output-limit", "Central config output exceeds the readable document byte limit.");
        activationCount++;
        if (file.relativePath !== input.configRelativePath)
          reject("invalid-role", "Only the selected central config may activate the plan.");
        break;
      case "ignore":
        if (file.relativePath !== ".gitignore")
          reject("invalid-role", "Ignore writes must target the project .gitignore file.");
        break;
      case "new-env":
        if (
          input.kind !== "init" ||
          file.relativePath !== ".env" ||
          file.before.exists ||
          file.mode !== 0o600
        )
          reject(
            "invalid-role",
            "New env creation is init-only, requires absence and private mode 0600.",
          );
        break;
      case "support":
        if ([input.configRelativePath.toLowerCase(), ".gitignore", ".env"].includes(key))
          reject(
            "invalid-role",
            "Central config, ignore and credential files require their dedicated roles.",
          );
        break;
      default:
        reject("invalid-role", "Unsupported planned-file role.");
    }
    if (key === ".env" && file.role !== "new-env")
      reject("invalid-role", "Existing credentials cannot be changed by a general file plan.");
    outputs.push({
      path: file.relativePath,
      sha256: snapshotHash(file.bytes),
      mode: file.mode,
      role: file.role,
    });
  }
  if (outputBytes > AUTHORING_LIMITS.aggregateOutputBytes)
    reject("output-limit", "The plan exceeds the aggregate output byte limit.");
  if (activationCount !== 1)
    reject(
      "invalid-activation",
      "A mutation plan requires exactly one central config activation file.",
    );
  if (input.summary.length > AUTHORING_LIMITS.plannedWrites)
    reject("summary-limit", "The plan summary exceeds its supported record limit.");
  for (const summary of input.summary) {
    validateRelativePath(summary.path);
    const file = input.files.find((entry) => entry.relativePath === summary.path);
    if (
      !file ||
      summary.operation !== (file.before.exists ? "replace" : "create") ||
      typeof summary.reason !== "string" ||
      Buffer.byteLength(summary.reason) > AUTHORING_LIMITS.diagnosticBytes ||
      control(summary.reason)
    )
      reject(
        "invalid-summary",
        "Use bounded controlled summaries matching the planned file operations.",
      );
  }
  // Canonical field order and path sorting make the fingerprint independent of call order.
  const canonicalInputs = [...snapshots.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(snapshotPrecondition);
  outputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fingerprint = snapshotHash(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: input.kind,
        projectDir,
        configRelativePath: input.configRelativePath,
        inputs: canonicalInputs,
        outputs,
      }),
    ),
  );
  return Object.freeze({
    ...input,
    projectDir,
    inputs: Object.freeze([...snapshots.values()]),
    files: Object.freeze([...input.files]),
    summary: Object.freeze([...input.summary]),
    schemaVersion: 1,
    fingerprint,
  });
}
