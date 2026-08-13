import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteTelegramReplayStore } from "../../src/augments/telegramTransport/replay-store";
import {
  assertNoRuntimeStateRestoreFence,
  admitRuntimeStateIdentity,
  createRuntimeStateBundle,
  readRuntimeStateRestoreFence,
  reconcileRuntimeStateRestore,
  resumeRuntimeStateRestore,
  restoreRuntimeStateBundle,
  verifyRuntimeStateBundle,
} from "../../src/cli/runtime-state-bundle";
import type { RuntimeStateInventory } from "../../src/cli/runtime-state-inventory";
import {
  createWebIdempotencyStore,
  hashIdempotencyBinding,
  hashIdempotencyKey,
} from "../../src/transports/idempotency-store";
import {
  createSqliteDurableJobStore,
  DURABLE_JOBS_APPLICATION_ID,
  DURABLE_JOBS_SCHEMA_VERSION,
} from "../../src/jobs/sqlite-store";

const roots: string[] = [];
const AGENT_ID = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; source: string; backups: string } {
  const root = mkdtempSync(join(tmpdir(), "auggy-runtime-bundle-"));
  roots.push(root);
  const source = join(root, "source");
  const backups = join(root, "backups");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  chmodSync(source, 0o700);
  chmodSync(backups, 0o700);
  admitRuntimeStateIdentity(source, AGENT_ID);
  return { root, source, backups };
}

function inventory(): RuntimeStateInventory {
  return {
    version: 1,
    agent: { id: AGENT_ID, name: "restore-test" },
    configShapeSha256: "a".repeat(64),
    stores: [
      {
        id: "web-idempotency:web",
        owner: "augment:web",
        namespace: "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211",
        kind: "sqlite",
        backupPlane: "runtime-volume",
        relativePath: "web-idempotency.db",
        schema: "AUID/v2",
        retention: "test",
        restoreOrder: 50,
        replayCritical: true,
        required: false,
      },
    ],
    externalPrerequisites: [],
  };
}

function seedReplayState(root: string) {
  const webPath = join(root, "web-idempotency.db");
  const store = createWebIdempotencyStore({ dbPath: webPath, maxRecords: 10 });
  const completeKey = hashIdempotencyKey("public", "complete");
  const completeBinding = hashIdempotencyBinding({ peer: "one", body: "same" });
  const complete = store.claim(completeKey, completeBinding);
  if (complete.status !== "leader") throw new Error("expected leader");
  expect(store.complete(completeKey, complete.ownerToken, '{"ok":true}')).toBe("complete");

  const unknownKey = hashIdempotencyKey("public", "unknown");
  const unknownBinding = hashIdempotencyBinding({ peer: "two", body: "same" });
  const unknown = store.claim(unknownKey, unknownBinding);
  if (unknown.status !== "leader") throw new Error("expected leader");
  store.markUnknown(unknownKey, unknown.ownerToken);
  store.close();

  const telegramPath = join(root, "telegram-replay.db");
  const telegram = createSqliteTelegramReplayStore({
    dbPath: telegramPath,
    now: () => 100,
    randomUUID: () => "conflict-id",
  });
  expect(telegram.claim("agent:telegram", 7, "b".repeat(64))).toBe("claimed");
  expect(telegram.claim("agent:telegram", 7, "c".repeat(64))).toBe("conflict");
  telegram.close?.();
  return { completeKey, completeBinding, unknownKey, unknownBinding };
}

describe("runtime state bundle", () => {
  test("restores completed, unknown, and quarantined replay state behind a startup fence", () => {
    const paths = fixture();
    const keys = seedReplayState(paths.source);
    writeFileSync(join(paths.source, "admin-overrides.json"), '{"version":1}', { mode: 0o600 });
    const bundle = join(paths.backups, "checkpoint.auggy-state");
    const stateInventory = inventory();
    stateInventory.stores[0]!.required = true;
    const manifest = createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: stateInventory,
      confirmStopped: true,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });

    expect(manifest.files.map((file) => file.path)).toContain("web-idempotency.db");
    expect(manifest.files.find((file) => file.path === "web-idempotency.db")?.sqlite).toMatchObject(
      {
        applicationId: 0x41554944,
        userVersion: 2,
        quickCheck: "deferred",
        journalArtifacts: ["web-idempotency.db-wal", "web-idempotency.db-shm"],
      },
    );
    expect(verifyRuntimeStateBundle(bundle).files.length).toBe(manifest.files.length);

    const restored = join(paths.root, "restored");
    const fence = restoreRuntimeStateBundle({
      bundlePath: bundle,
      destinationRoot: restored,
      confirmStopped: true,
      restoreId: () => "9fb78f48-61f3-41ca-a38f-0be277897f52",
      now: () => new Date("2026-07-25T13:00:00.000Z"),
      expectedInventory: stateInventory,
    });
    expect(fence.status).toBe("requires-reconciliation");
    expect(() => assertNoRuntimeStateRestoreFence(restored)).toThrow("reconcile downstream");
    expect(() =>
      admitRuntimeStateIdentity(restored, "aug1_11111111-1111-4111-8111-111111111111"),
    ).toThrow("different agent id");
    expect(() =>
      admitRuntimeStateIdentity(restored, "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211"),
    ).not.toThrow();

    const restoredWeb = createWebIdempotencyStore({
      dbPath: join(restored, "web-idempotency.db"),
      maxRecords: 10,
    });
    expect(restoredWeb.claim(keys.completeKey, keys.completeBinding).status).toBe("replay");
    expect(restoredWeb.claim(keys.unknownKey, keys.unknownBinding).status).toBe("unknown");
    restoredWeb.close();
    const restoredTelegram = createSqliteTelegramReplayStore({
      dbPath: join(restored, "telegram-replay.db"),
      now: () => 200,
    });
    expect(restoredTelegram.claim("agent:telegram", 8, "d".repeat(64))).toBe("quarantined");
    restoredTelegram.close?.();
    expect(() =>
      reconcileRuntimeStateRestore({
        runtimeDataRoot: restored,
        restoreId: "wrong-id",
        confirmDownstreamReconciled: true,
      }),
    ).toThrow("restore id does not match");
    reconcileRuntimeStateRestore({
      runtimeDataRoot: restored,
      restoreId: fence.restoreId,
      confirmDownstreamReconciled: true,
    });
    expect(readRuntimeStateRestoreFence(restored)).toBeNull();
    expect(() => assertNoRuntimeStateRestoreFence(restored)).not.toThrow();
  });

  test("requires explicit offline acknowledgement and an empty restore target", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "state.json"), "{}", { mode: 0o600 });
    const bundle = join(paths.backups, "checkpoint.auggy-state");
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: bundle,
        inventory: inventory(),
        confirmStopped: false,
      }),
    ).toThrow("stopped-and-drained");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: inventory(),
      confirmStopped: true,
    });
    const target = join(paths.root, "nonempty");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    expect(() =>
      restoreRuntimeStateBundle({
        bundlePath: bundle,
        destinationRoot: target,
        confirmStopped: true,
        expectedInventory: inventory(),
      }),
    ).toThrow("must be empty");
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  test("rejects symlinks and tampered payloads without publishing a trusted result", () => {
    const paths = fixture();
    const sourceAlias = join(paths.root, "source-alias");
    symlinkSync(paths.source, sourceAlias, "dir");
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: sourceAlias,
        bundlePath: join(paths.backups, "source-alias.auggy-state"),
        inventory: inventory(),
        confirmStopped: true,
      }),
    ).toThrow("must not be a symlink");

    writeFileSync(join(paths.root, "outside"), "secret", { mode: 0o600 });
    symlinkSync(join(paths.root, "outside"), join(paths.source, "escape"));
    const rejectedBundle = join(paths.backups, "rejected.auggy-state");
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: rejectedBundle,
        inventory: inventory(),
        confirmStopped: true,
      }),
    ).toThrow("unsafe entry");
    expect(existsSync(rejectedBundle)).toBe(false);

    rmSync(join(paths.source, "escape"));
    writeFileSync(join(paths.source, "state.json"), "{}", { mode: 0o600 });
    const bundle = join(paths.backups, "valid.auggy-state");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: inventory(),
      confirmStopped: true,
    });
    const bundleAlias = join(paths.backups, "bundle-alias");
    symlinkSync(bundle, bundleAlias, "dir");
    expect(() => verifyRuntimeStateBundle(bundleAlias)).toThrow("must not be a symlink");
    writeFileSync(join(bundle, "payload", "state.json"), '{"tampered":true}');
    expect(() => verifyRuntimeStateBundle(bundle)).toThrow("integrity check failed");
  });

  test("bounds directory depth before copying a hostile state tree", () => {
    const paths = fixture();
    let directory = paths.source;
    for (let index = 0; index < 65; index += 1) {
      directory = join(directory, "d");
      mkdirSync(directory, { mode: 0o700 });
    }
    writeFileSync(join(directory, "state.json"), "{}", { mode: 0o600 });
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: join(paths.backups, "too-deep.auggy-state"),
        inventory: inventory(),
        confirmStopped: true,
      }),
    ).toThrow("unsafe path");
  });

  test("preserves empty required directory state", () => {
    const paths = fixture();
    mkdirSync(join(paths.source, "workspace", "nested-empty"), {
      recursive: true,
      mode: 0o700,
    });
    const value = inventory();
    value.stores.push({
      id: "filesystem:workspace:workspace",
      owner: "augment:workspace",
      namespace: AGENT_ID,
      kind: "directory",
      backupPlane: "runtime-volume",
      relativePath: "workspace",
      schema: "opaque-files/v1",
      retention: "operator managed",
      restoreOrder: 70,
      replayCritical: false,
      required: true,
    });
    const bundle = join(paths.backups, "empty-directory.auggy-state");
    const manifest = createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: value,
      confirmStopped: true,
    });
    expect(manifest.directories.map((entry) => entry.path)).toEqual([
      "workspace",
      "workspace/nested-empty",
    ]);
    const restored = join(paths.root, "restored-empty");
    restoreRuntimeStateBundle({
      bundlePath: bundle,
      destinationRoot: restored,
      expectedInventory: value,
      confirmStopped: true,
    });
    expect(existsSync(join(restored, "workspace", "nested-empty"))).toBe(true);
  });

  test("binds backup and restore to volume identity and current configuration", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "state.json"), "{}", { mode: 0o600 });
    const wrongIdentity = inventory();
    wrongIdentity.agent.id = "aug1_11111111-1111-4111-8111-111111111111";
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: join(paths.backups, "wrong-identity.auggy-state"),
        inventory: wrongIdentity,
        confirmStopped: true,
      }),
    ).toThrow("identity does not match");

    const value = inventory();
    const bundle = join(paths.backups, "compatible.auggy-state");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: value,
      confirmStopped: true,
    });
    const drifted = structuredClone(value);
    drifted.configShapeSha256 = "b".repeat(64);
    const destination = join(paths.root, "config-drift");
    expect(() =>
      restoreRuntimeStateBundle({
        bundlePath: bundle,
        destinationRoot: destination,
        expectedInventory: drifted,
        confirmStopped: true,
      }),
    ).toThrow("configuration shape");
    expect(existsSync(destination)).toBe(false);
  });

  test("rejects wrong declared SQLite identity and bounded byte overflow", () => {
    const paths = fixture();
    const foreign = new Database(join(paths.source, "web-idempotency.db"));
    foreign.run("PRAGMA application_id = 1234");
    foreign.run("PRAGMA user_version = 2");
    foreign.run("CREATE TABLE foreign_state (id TEXT PRIMARY KEY)");
    foreign.close();
    const sqliteInventory = inventory();
    sqliteInventory.stores[0]!.required = true;
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: join(paths.backups, "foreign.auggy-state"),
        inventory: sqliteInventory,
        confirmStopped: true,
      }),
    ).toThrow("SQLite identity is incompatible");
    writeFileSync(join(paths.source, "web-idempotency.db-wal"), "foreign journal", {
      mode: 0o600,
    });
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: join(paths.backups, "foreign-journaled.auggy-state"),
        inventory: sqliteInventory,
        confirmStopped: true,
      }),
    ).toThrow("SQLite identity is incompatible");

    rmSync(join(paths.source, "web-idempotency.db"));
    rmSync(join(paths.source, "web-idempotency.db-wal"));
    writeFileSync(join(paths.source, "oversized.bin"), "0123456789", { mode: 0o600 });
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: paths.source,
        bundlePath: join(paths.backups, "oversized.auggy-state"),
        inventory: inventory(),
        confirmStopped: true,
        maxFileBytes: 5,
        maxTotalBytes: 20,
      }),
    ).toThrow("state file exceeds 5 bytes");
    expect(readdirSync(paths.backups)).toEqual([]);
  });

  test("admits exact supported legacy inventory identities", () => {
    const paths = fixture();
    for (const [filename, schema, applicationId, userVersion] of [
      ["notify-v1.db", "NTFY/v1", 0x4e544659, 1],
    ] as const) {
      const db = new Database(join(paths.source, filename));
      db.run(`PRAGMA application_id = ${applicationId}`);
      db.run(`PRAGMA user_version = ${userVersion}`);
      db.run("CREATE TABLE exact_legacy_state (id TEXT PRIMARY KEY)");
      db.close();

      const legacyInventory = inventory();
      legacyInventory.stores = [
        {
          ...legacyInventory.stores[0]!,
          id: `legacy:${schema}`,
          relativePath: filename,
          schema,
          required: true,
        },
      ];
      expect(() =>
        createRuntimeStateBundle({
          sourceRoot: paths.source,
          bundlePath: join(paths.backups, `${schema.replace("/", "-")}.auggy-state`),
          inventory: legacyInventory,
          confirmStopped: true,
        }),
      ).not.toThrow();
    }
  });

  test("validates the durable-jobs v2 identity before backup succeeds", () => {
    const paths = fixture();
    const databasePath = join(paths.source, "durable-jobs.sqlite");
    const store = createSqliteDurableJobStore({ dbPath: databasePath });
    store.submit({
      idempotencyKey: "backup-job",
      binding: { operation: "inventory-test" },
      payload: { version: 1, value: { prompt: "private" } },
    });
    store.close();

    const durableInventory = () => {
      const value = inventory();
      value.stores.push({
        id: "durable-jobs",
        owner: "runtime:durable-jobs",
        namespace: AGENT_ID,
        kind: "sqlite",
        backupPlane: "runtime-volume",
        relativePath: "durable-jobs.sqlite",
        schema: "DJOB/v2",
        retention: "test",
        restoreOrder: 15,
        replayCritical: true,
        required: true,
      });
      return value;
    };
    const value = durableInventory();
    const validBundle = join(paths.backups, "durable-valid.auggy-state");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: validBundle,
      inventory: value,
      confirmStopped: true,
    });
    expect(verifyRuntimeStateBundle(validBundle).inventory.stores).toContainEqual(
      expect.objectContaining({ id: "durable-jobs", schema: "DJOB/v2" }),
    );

    const wrongAppPaths = fixture();
    const wrongApp = new Database(join(wrongAppPaths.source, "durable-jobs.sqlite"));
    wrongApp.run("CREATE TABLE foreign_state (id TEXT PRIMARY KEY)");
    wrongApp.run("PRAGMA application_id = 1234");
    wrongApp.run(`PRAGMA user_version = ${DURABLE_JOBS_SCHEMA_VERSION}`);
    wrongApp.close();
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: wrongAppPaths.source,
        bundlePath: join(wrongAppPaths.backups, "durable-wrong-app.auggy-state"),
        inventory: durableInventory(),
        confirmStopped: true,
      }),
    ).toThrow("SQLite identity is incompatible");

    const wrongVersionPaths = fixture();
    const wrongVersion = new Database(join(wrongVersionPaths.source, "durable-jobs.sqlite"));
    wrongVersion.run("CREATE TABLE future_state (id TEXT PRIMARY KEY)");
    wrongVersion.run(`PRAGMA application_id = ${DURABLE_JOBS_APPLICATION_ID}`);
    wrongVersion.run(`PRAGMA user_version = ${DURABLE_JOBS_SCHEMA_VERSION + 1}`);
    wrongVersion.close();
    expect(() =>
      createRuntimeStateBundle({
        sourceRoot: wrongVersionPaths.source,
        bundlePath: join(wrongVersionPaths.backups, "durable-wrong-version.auggy-state"),
        inventory: durableInventory(),
        confirmStopped: true,
      }),
    ).toThrow("SQLite identity is incompatible");
  });

  test("resumes only the exact verified subset of an interrupted restore", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "a.json"), '{"a":1}', { mode: 0o600 });
    writeFileSync(join(paths.source, "b.json"), '{"b":2}', { mode: 0o600 });
    const value = inventory();
    const bundle = join(paths.backups, "resume.auggy-state");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: value,
      confirmStopped: true,
    });
    const destination = join(paths.root, "interrupted");
    let copied = 0;
    expect(() =>
      restoreRuntimeStateBundle({
        bundlePath: bundle,
        destinationRoot: destination,
        expectedInventory: value,
        confirmStopped: true,
        restoreId: () => "9fb78f48-61f3-41ca-a38f-0be277897f52",
        __testHooks: {
          beforeCopy: () => {
            copied += 1;
            if (copied === 2) throw new Error("injected copy interruption");
          },
        },
      }),
    ).toThrow("injected copy interruption");
    const copying = readRuntimeStateRestoreFence(destination)!;
    expect(copying.status).toBe("copying");
    expect(() => assertNoRuntimeStateRestoreFence(destination)).toThrow("is copying");
    expect(() =>
      resumeRuntimeStateRestore({
        bundlePath: bundle,
        destinationRoot: destination,
        expectedInventory: value,
        restoreId: "11111111-1111-4111-8111-111111111111",
        confirmStopped: true,
      }),
    ).toThrow("restore id does not match");
    const resumed = resumeRuntimeStateRestore({
      bundlePath: bundle,
      destinationRoot: destination,
      expectedInventory: value,
      restoreId: copying.restoreId,
      confirmStopped: true,
    });
    expect(resumed.status).toBe("requires-reconciliation");
    expect(readFileSync(join(destination, "a.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(destination, "b.json"), "utf8")).toBe('{"b":2}');
  });

  test("keeps bundle and restore traversal pinned across root path replacement", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "state.json"), '{"source":true}', { mode: 0o600 });
    const admittedSource = join(paths.root, "admitted-source");
    const outsideSource = join(paths.root, "outside-source");
    mkdirSync(outsideSource, { mode: 0o700 });
    writeFileSync(join(outsideSource, "state.json"), '{"outside":true}', { mode: 0o600 });
    const value = inventory();
    const bundle = join(paths.backups, "anchored.auggy-state");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: value,
      confirmStopped: true,
      __testHooks: {
        afterRootsPinned: () => {
          renameSync(paths.source, admittedSource);
          symlinkSync(outsideSource, paths.source, "dir");
        },
      },
    });
    expect(readFileSync(join(bundle, "payload", "state.json"), "utf8")).toBe('{"source":true}');

    const destination = join(paths.root, "restore-path");
    const admittedDestination = join(paths.root, "admitted-destination");
    const outsideDestination = join(paths.root, "outside-destination");
    mkdirSync(outsideDestination, { mode: 0o700 });
    writeFileSync(join(outsideDestination, "sentinel"), "safe", { mode: 0o600 });
    restoreRuntimeStateBundle({
      bundlePath: bundle,
      destinationRoot: destination,
      expectedInventory: value,
      confirmStopped: true,
      __testHooks: {
        afterRootsPinned: () => {
          renameSync(destination, admittedDestination);
          symlinkSync(outsideDestination, destination, "dir");
        },
      },
    });
    expect(readFileSync(join(admittedDestination, "state.json"), "utf8")).toBe('{"source":true}');
    expect(readFileSync(join(outsideDestination, "sentinel"), "utf8")).toBe("safe");
    expect(existsSync(join(outsideDestination, "state.json"))).toBe(false);
  });

  test("keeps identity creation and fence reconciliation pinned across root replacement", () => {
    const paths = fixture();
    const identityRoot = join(paths.root, "identity-root");
    const admittedIdentityRoot = join(paths.root, "identity-root-admitted");
    const outsideIdentityRoot = join(paths.root, "identity-root-outside");
    mkdirSync(identityRoot, { mode: 0o700 });
    mkdirSync(outsideIdentityRoot, { mode: 0o700 });
    admitRuntimeStateIdentity(identityRoot, AGENT_ID, {
      __testHooks: {
        afterRootPinned: () => {
          renameSync(identityRoot, admittedIdentityRoot);
          symlinkSync(outsideIdentityRoot, identityRoot, "dir");
        },
      },
    });
    expect(existsSync(join(admittedIdentityRoot, ".auggy-state-identity.json"))).toBe(true);
    expect(existsSync(join(outsideIdentityRoot, ".auggy-state-identity.json"))).toBe(false);

    const restoreId = "9fb78f48-61f3-41ca-a38f-0be277897f52";
    const fenceRoot = join(paths.root, "fence-root");
    const admittedFenceRoot = join(paths.root, "fence-root-admitted");
    const outsideFenceRoot = join(paths.root, "fence-root-outside");
    mkdirSync(fenceRoot, { mode: 0o700 });
    mkdirSync(outsideFenceRoot, { mode: 0o700 });
    const fence = JSON.stringify({
      version: 1,
      status: "requires-reconciliation",
      restoreId,
      bundleManifestSha256: "a".repeat(64),
      restoredAt: "2026-07-25T13:00:00.000Z",
    });
    writeFileSync(join(fenceRoot, ".auggy-restore-fence.json"), fence, { mode: 0o600 });
    writeFileSync(join(outsideFenceRoot, ".auggy-restore-fence.json"), fence, { mode: 0o600 });
    reconcileRuntimeStateRestore({
      runtimeDataRoot: fenceRoot,
      restoreId,
      confirmDownstreamReconciled: true,
      __testHooks: {
        afterRootPinned: () => {
          renameSync(fenceRoot, admittedFenceRoot);
          symlinkSync(outsideFenceRoot, fenceRoot, "dir");
        },
      },
    });
    expect(existsSync(join(admittedFenceRoot, ".auggy-restore-fence.json"))).toBe(false);
    expect(readFileSync(join(outsideFenceRoot, ".auggy-restore-fence.json"), "utf8")).toBe(fence);
  });

  test("never serializes external credentials into the bundle manifest", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "state.json"), "{}", { mode: 0o600 });
    const value = inventory();
    value.externalPrerequisites.push({
      id: "remote-store",
      owner: "augment:remote",
      reason: "provider snapshot required",
    });
    const bundle = join(paths.backups, "external.auggy-state");
    createRuntimeStateBundle({
      sourceRoot: paths.source,
      bundlePath: bundle,
      inventory: value,
      confirmStopped: true,
    });
    const manifest = readFileSync(join(bundle, "manifest.json"), "utf8");
    expect(manifest).not.toContain("password");
    expect(manifest).not.toContain("secret");
  });
});
