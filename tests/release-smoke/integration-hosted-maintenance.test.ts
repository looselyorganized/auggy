import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  exportHostedMaintenanceBundle,
  importHostedMaintenanceBundle,
  installHostedMaintenanceEntrypoint,
  persistHostedMaintenanceStopped,
  persistHostedRailwayMaintenanceStopped,
  prepareHostedMaintenanceExportConfig,
  prepareHostedMaintenanceFixtures,
} from "../../scripts/release-smoke/integration-hosted-maintenance";
import {
  MAINTENANCE_LIMITS,
  decodeMaintenanceTransfer,
  indexMaintenanceBundle,
  parseHostedMaintenanceOperation,
  readMaintenanceBundleFile,
  writeMaintenanceBundleFile,
  verifyHostedWorkerReplay,
  prepareEmptyMaintenanceVolume,
} from "../../scripts/release-smoke/integration-fixtures/hosted/maintenance-command";
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "auggy-offline-maintenance-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});
const data = Buffer.from("synthetic runtime state");
function manifest() {
  return {
    kind: "auggy-runtime-state-bundle",
    formatVersion: 1,
    directories: [{ path: "empty", mode: "0700" }],
    files: [{ path: "state.sqlite", bytes: data.byteLength, sha256: hash(data), mode: "0600" }],
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const stopped = {
  runtimeId: "a".repeat(64),
  volumeId: "auggy-owned-source-volume",
  running: false,
  exitCode: 0,
  observedAtMs: Date.now(),
  controllerReceiptSHA256: "b".repeat(64),
};

test("fresh volume preparation changes only an empty owned real directory through its descriptor", () => {
  const empty = join(workspace, "empty-volume");
  mkdirSync(empty, { mode: 0o755 });
  chmodSync(empty, 0o755);
  const identity = statSync(empty);
  const prepared = prepareEmptyMaintenanceVolume(empty);
  expect(prepared.beforeMode).toBe("755");
  expect(prepared.mode).toBe("700");
  expect(prepared.directoryIdentity).toEqual({ dev: identity.dev, ino: identity.ino });
  expect(statSync(empty).mode & 0o7777).toBe(0o700);
  const nonempty = join(workspace, "used-volume");
  mkdirSync(nonempty, { mode: 0o755 });
  chmodSync(nonempty, 0o755);
  writeFileSync(join(nonempty, "runtime-state"), "owned state");
  expect(() => prepareEmptyMaintenanceVolume(nonempty)).toThrow("must be empty");
  expect(statSync(nonempty).mode & 0o7777).toBe(0o755);
  chmodSync(empty, 0o755);
  symlinkSync(empty, join(workspace, "linked-volume"));
  expect(() => prepareEmptyMaintenanceVolume(join(workspace, "linked-volume"))).toThrow();
  expect(statSync(empty).mode & 0o7777).toBe(0o755);
  expect(parseHostedMaintenanceOperation({ operation: "prepare-empty-volume" }).operation).toBe(
    "prepare-empty-volume",
  );
  expect(() =>
    parseHostedMaintenanceOperation({ operation: "prepare-empty-volume", path: empty }),
  ).toThrow();
});

test("fresh restore fixture removes only a sole empty real lost+found directory", () => {
  const fresh = join(workspace, "fresh");
  mkdirSync(fresh, { mode: 0o755 });
  mkdirSync(join(fresh, "lost+found"), { mode: 0o700 });
  const original = statSync(fresh);
  const result = prepareEmptyMaintenanceVolume(fresh);
  expect(result.removedEmptyLostFound).toBe(true);
  expect(result.directoryIdentity).toEqual({ dev: original.dev, ino: original.ino });
  expect(statSync(fresh).mode & 0o777).toBe(0o700);
  expect(() => statSync(join(fresh, "lost+found"))).toThrow();

  for (const kind of ["recovered", "other-entry", "file", "symlink"] as const) {
    const target = join(workspace, kind);
    mkdirSync(target, { mode: 0o755 });
    const lost = join(target, "lost+found");
    if (kind === "file") writeFileSync(lost, data);
    else if (kind === "symlink") symlinkSync(fresh, lost);
    else {
      mkdirSync(lost, { mode: 0o700 });
      writeFileSync(join(kind === "recovered" ? lost : target, "preserved"), data);
    }
    expect(() => prepareEmptyMaintenanceVolume(target)).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o755);
    if (kind === "recovered" || kind === "other-entry")
      expect(readFileSync(join(kind === "recovered" ? lost : target, "preserved"))).toEqual(data);
    if (kind === "file") expect(readFileSync(lost)).toEqual(data);
    if (kind === "symlink") expect(statSync(fresh).ino).toBe(original.ino);
  }
});

test("finite operations reject arbitrary CLI args, paths and incomplete stopped claims", () => {
  expect(() =>
    parseHostedMaintenanceOperation({ operation: "backup", stopped, argv: ["run"] }),
  ).toThrow();
  expect(() =>
    parseHostedMaintenanceOperation({ operation: "export-file", index: 0, path: "/etc/passwd" }),
  ).toThrow();
  expect(() =>
    parseHostedMaintenanceOperation({
      operation: "restore",
      stopped: { ...stopped, running: true },
      destinationVolumeId: "auggy-fresh-volume",
    }),
  ).toThrow();
  expect(() =>
    parseHostedMaintenanceOperation({ operation: "reconcile", stopped, restoreId: "wrong" }),
  ).toThrow();
  expect(parseHostedMaintenanceOperation({ operation: "backup", stopped }).operation).toBe(
    "backup",
  );
});

test("worker reconciliation binds Telegram receipt/backup identity and the exact confirmed updates", () => {
  const value = {
    operation: "reconcile-worker",
    stopped,
    restoreId: "00000000-0000-4000-8000-000000000001",
    sealedGenerationReceiptSHA256: "a".repeat(64),
    backupManifestSHA256: "b".repeat(64),
    confirmedUpdateIds: [1, 2, 3],
  };
  expect(parseHostedMaintenanceOperation(value).operation).toBe("reconcile-worker");
  for (const patch of [
    { confirmedUpdateIds: [1, 3] },
    { confirmedUpdateIds: [1, 2, 4] },
    { confirmedUpdateIds: [1, 2, 3, 4] },
    { backupManifestSHA256: "unknown" },
    { sealedGenerationReceiptSHA256: "" },
    { unreplayedOperationId: value.restoreId },
  ])
    expect(() => parseHostedMaintenanceOperation({ ...value, ...patch })).toThrow();
});

test("worker replay evidence refuses wrong database, namespace, missing, reordered and extra claims", () => {
  const value = {
    applicationId: 0x54475250,
    schemaVersion: 2,
    claims: [1, 2, 3].map((updateId) => ({ namespace: "telegram:bot-123456789", updateId })),
  };
  const result = verifyHostedWorkerReplay(value);
  expect(result.claims.map((claim) => claim.updateId)).toEqual([1, 2, 3]);
  expect(
    result.claims.every((claim) => claim.namespaceSHA256 === hash("telegram:bot-123456789")),
  ).toBe(true);
  for (const patch of [
    { applicationId: 0 },
    { schemaVersion: 1 },
    { claims: value.claims.slice(0, 2) },
    { claims: [...value.claims, value.claims[0]] },
    { claims: [...value.claims].reverse() },
    { claims: [value.claims[0], value.claims[0], value.claims[2]] },
    { claims: value.claims.map((claim) => ({ ...claim, namespace: "telegram:bot-other" })) },
  ])
    expect(() => verifyHostedWorkerReplay({ ...value, ...patch })).toThrow();
});

test("Railway stopped proof records observed singleton status without inventing a clean exit code", () => {
  const observation = {
    provider: "railway" as const,
    projectId: "00000000-0000-4000-8000-000000000001",
    environmentId: "00000000-0000-4000-8000-000000000002",
    serviceId: "00000000-0000-4000-8000-000000000003",
    deploymentId: "00000000-0000-4000-8000-000000000004",
    imageDigest: `sha256:${"d".repeat(64)}`,
    volumeId: "00000000-0000-4000-8000-000000000005",
    deploymentStopped: true as const,
    instances: [{ id: "00000000-0000-4000-8000-000000000006", status: "STOPPED" as const }],
    sealedGenerationReceiptSHA256: "e".repeat(64),
    quiescenceReceiptSHA256: "f".repeat(64),
    observedAtMs: Date.now(),
  };
  const proof = persistHostedRailwayMaintenanceStopped({
    evidenceDirectory: workspace,
    name: "railway-stopped.json",
    observation,
  });
  expect(proof.provider).toBe("railway");
  expect("exitCode" in proof).toBe(false);
  expect(proof.controllerReceiptSHA256).toBe(
    hash(readFileSync(join(workspace, "railway-stopped.json"))),
  );
  expect(statSync(join(workspace, "railway-stopped.json")).mode & 0o777).toBe(0o600);
  expect(() =>
    persistHostedRailwayMaintenanceStopped({
      evidenceDirectory: workspace,
      name: "railway-stopped.json",
      observation,
    }),
  ).toThrow();
  for (const status of ["EXITED", "REMOVED"])
    expect(
      parseHostedMaintenanceOperation({
        operation: "backup",
        stopped: { ...proof, instances: [{ ...proof.instances[0], status }] },
      }).operation,
    ).toBe("backup");
  for (const patch of [
    { exitCode: 0 },
    { deploymentStopped: false },
    { instances: [] },
    { instances: [proof.instances[0], proof.instances[0]] },
    { instances: [{ ...proof.instances[0], id: null }] },
    ...[
      null,
      "RUNNING",
      "CRASHED",
      "REMOVING",
      "RESTARTING",
      "INITIALIZING",
      "CREATED",
      "SKIPPED",
    ].map((status) => ({ instances: [{ ...proof.instances[0], status }] })),
    { sealedGenerationReceiptSHA256: undefined },
    { quiescenceReceiptSHA256: undefined },
    { provider: "unknown" },
  ])
    expect(() =>
      parseHostedMaintenanceOperation({ operation: "backup", stopped: { ...proof, ...patch } }),
    ).toThrow();
  expect(() =>
    parseHostedMaintenanceOperation({
      operation: "backup",
      stopped: { ...stopped, exitCode: 137 },
    }),
  ).toThrow();
});

test("bundle transfer rejects path traversal, duplicate records, replay guard and bounds", () => {
  const base = manifest();
  for (const path of [
    "../outside",
    "/absolute",
    "a/../../outside",
    ".auggy-auth-replay-guard.json",
  ])
    expect(() =>
      indexMaintenanceBundle(bytes({ ...base, files: [{ ...base.files[0], path }] })),
    ).toThrow();
  expect(() =>
    indexMaintenanceBundle(bytes({ ...base, files: [base.files[0], base.files[0]] })),
  ).toThrow();
  expect(() =>
    indexMaintenanceBundle(
      bytes({ ...base, files: [{ ...base.files[0], bytes: MAINTENANCE_LIMITS.fileBytes + 1 }] }),
    ),
  ).toThrow();
  expect(() =>
    indexMaintenanceBundle(
      bytes({
        ...base,
        files: Array.from({ length: 17 }, (_, i) => ({ ...base.files[0], path: `file-${i}` })),
      }),
    ),
  ).toThrow();
  expect(() =>
    indexMaintenanceBundle(
      bytes({
        ...base,
        files: Array.from({ length: 5 }, (_, i) => ({
          ...base.files[0],
          path: `file-${i}`,
          bytes: MAINTENANCE_LIMITS.fileBytes,
        })),
      }),
    ),
  ).toThrow();
});

test("bundle transfer preserves lost+found without admitting traversal", () => {
  const value = {
    ...manifest(),
    directories: [{ path: "lost+found", mode: "0700" }],
    files: [
      { path: "lost+found/recovered+state", bytes: data.length, sha256: hash(data), mode: "0600" },
    ],
  };
  const index = indexMaintenanceBundle(bytes(value));
  expect(index.directories).toEqual([{ path: "lost+found" }]);
  expect(index.files[0]?.path).toBe("lost+found/recovered+state");
  writeMaintenanceBundleFile(workspace, index.files[0]!.path, data);
  expect(readMaintenanceBundleFile(workspace, index.files[0]!.path, 100)).toEqual(data);
  for (const path of [
    "lost+found/../escape",
    "lost+found/./state",
    "/lost+found",
    "lost+found//state",
  ]) {
    expect(() =>
      indexMaintenanceBundle(bytes({ ...value, directories: [{ path, mode: "0700" }] })),
    ).toThrow();
    expect(() => writeMaintenanceBundleFile(workspace, path, data)).toThrow();
  }
});

test("transfer accepts exact bytes only and never overwrites or follows a linked file", () => {
  expect(decodeMaintenanceTransfer(data.toString("base64"), hash(data), data.byteLength)).toEqual(
    data,
  );
  expect(() =>
    decodeMaintenanceTransfer(`${data.toString("base64")}\n`, hash(data), 100),
  ).toThrow();
  expect(() => decodeMaintenanceTransfer(data.toString("base64"), "f".repeat(64), 100)).toThrow();
  expect(() => decodeMaintenanceTransfer(data.toString("base64"), hash(data), 1)).toThrow();
  writeMaintenanceBundleFile(workspace, "safe/file", data);
  expect(readMaintenanceBundleFile(workspace, "safe/file", 100)).toEqual(data);
  expect(() => writeMaintenanceBundleFile(workspace, "safe/file", data)).toThrow();
  symlinkSync("file", join(workspace, "safe/link"));
  expect(() => readMaintenanceBundleFile(workspace, "safe/link", 100)).toThrow();
  expect(statSync(join(workspace, "safe/file")).mode & 0o777).toBe(0o600);
});

test("stopped observation is a private exclusive controller receipt and rejects a live or forced process", () => {
  const options = {
    evidenceDirectory: workspace,
    name: "stopped.json",
    runtimeId: stopped.runtimeId,
    volumeId: stopped.volumeId,
    status: { running: false, exitCode: 0 },
    observedAtMs: Date.now(),
  };
  const proof = persistHostedMaintenanceStopped(options);
  expect(proof.controllerReceiptSHA256).toBe(hash(readFileSync(join(workspace, "stopped.json"))));
  expect(statSync(join(workspace, "stopped.json")).mode & 0o777).toBe(0o600);
  expect(() => persistHostedMaintenanceStopped(options)).toThrow();
  expect(() =>
    persistHostedMaintenanceStopped({
      ...options,
      name: "live.json",
      status: { running: true, exitCode: 0 },
    }),
  ).toThrow();
  expect(() =>
    persistHostedMaintenanceStopped({
      ...options,
      name: "forced.json",
      status: { running: false, exitCode: 137 },
    }),
  ).toThrow();
});

test("bounded controller export preserves empty directories and import verifies exact remote identity", async () => {
  const source = bytes(manifest());
  const index = indexMaintenanceBundle(source);
  const directory = join(workspace, "backup");
  const exported = await exportHostedMaintenanceBundle({
    directory,
    control: async (op) => {
      if (op.operation === "export-manifest")
        return { operation: op.operation, ...index, base64: source.toString("base64") };
      if (op.operation === "export-file")
        return {
          operation: op.operation,
          index: op.index,
          ...index.files[0],
          base64: data.toString("base64"),
        };
      throw Error("Unexpected export operation");
    },
  });
  expect(exported.totalBytes).toBe(data.byteLength);
  expect(statSync(join(directory, "payload/empty")).isDirectory()).toBe(true);
  const operations: string[] = [];
  const imported = await importHostedMaintenanceBundle({
    directory,
    control: async (op) => {
      operations.push(op.operation);
      if (op.operation === "import-manifest")
        return { operation: op.operation, manifestSHA256: op.sha256 };
      if (op.operation === "import-file")
        return {
          operation: op.operation,
          index: op.index,
          sha256: op.sha256,
          bytes: data.byteLength,
        };
      if (op.operation === "verify")
        return { operation: op.operation, manifestSHA256: index.manifestSHA256 };
      throw Error("Unexpected import operation");
    },
  });
  expect(imported).toEqual(index);
  expect(operations).toEqual(["import-manifest", "import-file", "verify"]);
  writeFileSync(join(directory, "payload/state.sqlite"), "changed");
  await expect(
    importHostedMaintenanceBundle({
      directory,
      control: async (op) => ({ operation: op.operation, manifestSHA256: index.manifestSHA256 }),
    }),
  ).rejects.toThrow("changed before import");
});

test("wrong exporter identities fail before publishing substituted bytes", async () => {
  const source = bytes(manifest());
  const index = indexMaintenanceBundle(source);
  await expect(
    exportHostedMaintenanceBundle({
      directory: join(workspace, "backup"),
      control: async (op) => {
        if (op.operation === "export-manifest")
          return { operation: op.operation, ...index, base64: source.toString("base64") };
        return {
          operation: op.operation,
          index: 0,
          ...index.files[0],
          sha256: "f".repeat(64),
          base64: data.toString("base64"),
        };
      },
    }),
  ).rejects.toThrow("binding changed");
});

test("maintenance artifacts bind the public CLI command to25s and no-ingress bounded hold", async () => {
  const consumer = join(workspace, "context");
  mkdirSync(join(consumer, "src/fixtures"), { recursive: true });
  const prepared = await prepareHostedMaintenanceFixtures(
    join(consumer, "src/fixtures/g4-maintenance"),
  );
  expect(prepared.registry.commands).toHaveLength(1);
  expect(prepared.registry.commands[0]?.timeoutMs).toBe(25_000);
  expect(prepared.registry.commands[0]?.envKeys).toEqual([]);
  expect(prepared.files.every((file) => file.bytes <= 2 * 1024 * 1024)).toBe(true);
  writeFileSync(
    join(consumer, "auggy-deployment.json"),
    JSON.stringify({ profile: { kind: "none" } }),
  );
  writeFileSync(
    join(consumer, "Dockerfile"),
    'FROM pinned\nCOPY . /app\nENTRYPOINT ["original"]\n',
  );
  const overlay = installHostedMaintenanceEntrypoint(consumer, prepared);
  expect(overlay.entrySHA256).toBe(prepared.entrySHA256);
  expect(readFileSync(join(consumer, "Dockerfile"), "utf8")).toContain('"--hold"');
  expect(MAINTENANCE_LIMITS.lifetimeMs).toBeLessThanOrEqual(120_000);
  writeFileSync(
    join(consumer, "auggy-deployment.json"),
    JSON.stringify({ profile: { kind: "http" } }),
  );
  expect(() => installHostedMaintenanceEntrypoint(consumer, prepared)).toThrow("no-ingress");
});

test("separate maintenance export keeps the real runtime config bytes and immutable identity", () => {
  const runtime =
    "id: aug1_76eaa8dc-ec24-4122-ad9b-d1f9891052f5\nname: http-agent\napplication:\n  contractVersion: 1\n  entrypoint: ./src/index.ts\naugments:\n  - name: web\n    type: webTransport\n";
  writeFileSync(join(workspace, "agent.yaml"), runtime);
  const prepared = prepareHostedMaintenanceExportConfig(workspace);
  expect(readFileSync(join(workspace, "agent.yaml"), "utf8")).toBe(runtime);
  expect(prepared.runtimeConfig.sha256).toBe(hash(runtime));
  const exported = readFileSync(join(workspace, "maintenance.yaml"), "utf8");
  expect(exported).toContain(`id: ${prepared.agentId}`);
  expect(exported).toContain("augments: []");
  expect(exported).toContain("./src/fixtures/g4-maintenance/commands/maintenance.js");
  expect(prepared.exportConfig.sha256).toBe(hash(exported));
  expect(() => prepareHostedMaintenanceExportConfig(workspace)).toThrow("exists");
});
