import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeEmptyRailwayRuntimeMount,
  prepareRuntimeDataVolume,
  prepareRuntimeVolume,
  prepareRuntimeVolumeLease,
  RUNTIME_SINGLETON_LOCK_FILE,
  selectRuntimeDataRoot,
} from "../../src/cli/runtime-volume";
import { pinDirectory } from "../../src/lib/anchored-files";
import { withRuntimeDataAdmission } from "../../src/runtime-data-admission";
import type { AdmittedRuntimeVolumeLease } from "../../src/runtime-data-contracts";

const tempRoots: string[] = [];
const leases: AdmittedRuntimeVolumeLease[] = [];
const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";

function admitRoot(root: string): AdmittedRuntimeVolumeLease {
  const lease = prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId);
  leases.push(lease);
  return lease;
}

function initializeRailwayMount(root: string): void {
  const pinned = pinDirectory(root, "Railway test mount");
  try {
    initializeEmptyRailwayRuntimeMount(pinned, root);
  } finally {
    closeSync(pinned.fd);
  }
}

function makeRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "auggy-runtime-volume-"));
  tempRoots.push(parent);
  const root = join(parent, "data");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  for (const root of tempRoots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // The test may have replaced or removed this path.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("selectRuntimeDataRoot", () => {
  test.each(["direct", "foreground", "launchd"] as const)(
    "%s preserves local storage only when the generic variable is absent",
    (mode) => {
      expect(
        selectRuntimeDataRoot(mode, {
          auggyDataDir: undefined,
          railwayVolumeMountPath: "/app/data",
        }),
      ).toEqual({ kind: "local" });
      expect(
        selectRuntimeDataRoot(mode, {
          auggyDataDir: "/app/data",
          railwayVolumeMountPath: undefined,
        }),
      ).toEqual({ kind: "explicit", runtimeDataRoot: "/app/data" });
    },
  );

  test.each(["", "  ", "data", "~/data", "/data\0bad", "/data/../other", "/data/./child"])(
    "rejects invalid explicit root %j without normalizing it",
    (auggyDataDir) => {
      expect(() =>
        selectRuntimeDataRoot("direct", { auggyDataDir, railwayVolumeMountPath: undefined }),
      ).toThrow(/absolute filesystem path|path components/);
    },
  );

  test("preserves literal absolute filesystem paths without interpolation", () => {
    const path = "/tmp/$PROJECT/my data";
    expect(
      selectRuntimeDataRoot("foreground", {
        auggyDataDir: path,
        railwayVolumeMountPath: "/another/platform/path",
      }),
    ).toEqual({ kind: "explicit", runtimeDataRoot: path });
  });

  test.each([undefined, "/app/data"])(
    "Railway admits matching configuration %j",
    (auggyDataDir) => {
      expect(
        selectRuntimeDataRoot("railway", {
          auggyDataDir,
          railwayVolumeMountPath: "/app/data",
        }),
      ).toEqual({ kind: "railway", runtimeDataRoot: "/app/data" });
    },
  );

  test.each([undefined, "/wrong", "/app/data/"])("Railway refuses advertisement %j", (mount) => {
    expect(() =>
      selectRuntimeDataRoot("railway", {
        auggyDataDir: "/app/data",
        railwayVolumeMountPath: mount,
      }),
    ).toThrow("expected RAILWAY_VOLUME_MOUNT_PATH=/app/data");
  });

  test("Railway refuses a conflicting generic root", () => {
    expect(() =>
      selectRuntimeDataRoot("railway", {
        auggyDataDir: "/other",
        railwayVolumeMountPath: "/app/data",
      }),
    ).toThrow("Railway requires AUGGY_DATA_DIR=/app/data");
  });
});

describe("prepareRuntimeDataVolume", () => {
  test("admits generic storage without a Railway advertisement and retains one lease", () => {
    const root = makeRoot();
    const first = admitRoot(root);
    expect(first.runtimeDataRoot).toBe(root);
    expect(first.runtimeDataAdmission.agentId).toBe(agentId);
    expect(withRuntimeDataAdmission(first.runtimeDataAdmission, () => "admitted")).toBe("admitted");
    expect(readdirSync(join(root, "agent-mail"))).toEqual([]);
    expect(() => admitRoot(root)).toThrow("another live replica owns this agent volume");
    first.release();
    first.release();
    expect(() => admitRoot(root)).not.toThrow();
  });

  test("requires a valid agent identity before mutating the root", () => {
    const root = makeRoot();
    for (const invalid of ["", "agent", "aug1_bad"]) {
      expect(() =>
        prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, invalid),
      ).toThrow("valid aug1_ UUID");
      expect(readdirSync(root)).toEqual([]);
    }
  });

  test("rejects a different agent and preserves the existing identity", () => {
    const root = makeRoot();
    admitRoot(root).release();
    const before = readFileSync(join(root, ".auggy-state-identity.json"), "utf8");
    expect(() =>
      prepareRuntimeDataVolume(
        { kind: "explicit", runtimeDataRoot: root },
        "aug1_00000000-0000-0000-0000-000000000001",
      ),
    ).toThrow("different agent id");
    expect(readFileSync(join(root, ".auggy-state-identity.json"), "utf8")).toBe(before);
    expect(() => admitRoot(root)).not.toThrow();
  });

  test("never creates a missing generic root", () => {
    const parent = makeRoot();
    const missing = join(parent, "missing");
    expect(() => admitRoot(missing)).toThrow("does not exist");
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });

  test("never repairs a permissive generic root or existing state directory", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    expect(() => admitRoot(root)).toThrow("mode 0700");
    expect(lstatSync(root).mode & 0o777).toBe(0o755);
    expect(readdirSync(root)).toEqual([]);
    chmodSync(root, 0o700);
    const state = join(root, "agent-mail");
    mkdirSync(state);
    chmodSync(state, 0o755);
    expect(() => admitRoot(root)).toThrow("AgentMail state directory must have mode 0700");
    expect(lstatSync(state).mode & 0o777).toBe(0o755);
    chmodSync(state, 0o700);
    expect(() => admitRoot(root)).not.toThrow();
  });

  test("rejects wrong ownership before creating state", () => {
    const root = makeRoot();
    const uid = process.getuid!();
    const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(() => admitRoot(root)).toThrow("could not pin directory");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      getuid.mockRestore();
    }
    expect(() => admitRoot(root)).not.toThrow();
  });

  test("root replacement during admission fails before touching the replacement", () => {
    const root = makeRoot();
    const original = `${root}-original`;
    const outside = `${root}-outside`;
    mkdirSync(outside, { mode: 0o700 });
    expect(() =>
      prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId, {
        __testHooks: {
          afterRootPinned() {
            renameSync(root, original);
            symlinkSync(outside, root);
          },
        },
      }),
    ).toThrow("must not be a symlink");
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(original)).toEqual([]);
    expect(() => admitRoot(original)).not.toThrow();
  });

  test("a real state-directory admission failure releases the acquired singleton", () => {
    const root = makeRoot();
    writeFileSync(join(root, "agent-mail"), "not a directory");
    expect(() => admitRoot(root)).toThrow("directory is missing or unsafe");
    rmSync(join(root, "agent-mail"));
    const recovered = admitRoot(root);
    expect(withRuntimeDataAdmission(recovered.runtimeDataAdmission, () => true)).toBe(true);
  });

  test.each([0, 1, 2, 3])(
    "probe fsync failure %i cleans owned artifacts and releases the singleton",
    (failAt) => {
      const root = makeRoot();
      admitRoot(root).release();
      const originalFsync = fs.fsyncSync;
      let faults = 0;
      const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (faults++ === failAt) throw new Error("injected probe durability failure");
        return originalFsync(fd);
      });
      try {
        expect(() => admitRoot(root)).toThrow("injected probe durability failure");
      } finally {
        fsync.mockRestore();
      }
      expect(faults).toBeGreaterThan(0);
      expect(readdirSync(join(root, "agent-mail"))).toEqual([]);
      expect(() => admitRoot(root)).not.toThrow();
    },
  );

  test("restore fence refusal precedes identity, lock and state creation", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".auggy-restore-fence.json"), "incomplete", { mode: 0o600 });
    expect(() => admitRoot(root)).toThrow(/restore fence/);
    expect(readdirSync(root)).toEqual([".auggy-restore-fence.json"]);
  });

  test("legacy probe and lease helpers do not mint managed capabilities", () => {
    const root = makeRoot();
    expect(prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toBe(root);
    for (const identity of [undefined, agentId]) {
      const legacy = prepareRuntimeVolumeLease({
        advertisedMount: root,
        runtimeDataRoot: root,
        agentId: identity,
      });
      try {
        expect("runtimeDataAdmission" in legacy).toBe(false);
      } finally {
        legacy.release();
      }
    }
  });
});

describe("explicit Railway empty-mount initialization", () => {
  test("narrows an owned default-mode empty mount and permits subsequent admission", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    initializeRailwayMount(root);
    expect(lstatSync(root).mode & 0o7777).toBe(0o700);
    expect(readdirSync(root)).toEqual([]);
    const lease = admitRoot(root);
    lease.release();
    expect(() => initializeRailwayMount(root)).not.toThrow();
    expect(() => admitRoot(root)).not.toThrow();
  });

  test.each(["metadata", "lost+found", ".hidden"])(
    "does not repair a permissive mount containing %s",
    (entry) => {
      const root = makeRoot();
      chmodSync(root, 0o755);
      writeFileSync(join(root, entry), "platform metadata");
      expect(() => initializeRailwayMount(root)).toThrow("nonempty Railway mount");
      expect(lstatSync(root).mode & 0o777).toBe(0o755);
      expect(readdirSync(root)).toEqual([entry]);
    },
  );

  test("rejects a symlink or replaced configured mount without changing either directory", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    const original = `${root}-original`;
    const pinned = pinDirectory(root, "Railway test mount");
    try {
      renameSync(root, original);
      mkdirSync(root, { mode: 0o755 });
      chmodSync(root, 0o755);
      expect(() => initializeEmptyRailwayRuntimeMount(pinned, root)).toThrow(
        "changed during admission",
      );
      expect(lstatSync(root).mode & 0o777).toBe(0o755);
      expect(lstatSync(original).mode & 0o777).toBe(0o755);
      rmSync(root, { recursive: true });
      symlinkSync(original, root);
      expect(() => initializeEmptyRailwayRuntimeMount(pinned, root)).toThrow(
        "must not be a symlink",
      );
      expect(lstatSync(original).mode & 0o777).toBe(0o755);
    } finally {
      closeSync(pinned.fd);
    }
  });

  test("refuses an unowned mount without changing mode", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    const pinned = pinDirectory(root, "Railway test mount");
    const getuid = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      expect(() => initializeEmptyRailwayRuntimeMount(pinned, root)).toThrow(
        "owned by the current user",
      );
      expect(lstatSync(root).mode & 0o777).toBe(0o755);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      getuid.mockRestore();
      closeSync(pinned.fd);
    }
  });

  test("rechecks physical identity after descriptor chmod without modifying a replacement", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    const original = `${root}-original`;
    const originalChmod = fs.fchmodSync;
    const chmod = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
      renameSync(root, original);
      mkdirSync(root, { mode: 0o755 });
      chmodSync(root, 0o755);
      return originalChmod(fd, mode);
    });
    try {
      expect(() => initializeRailwayMount(root)).toThrow("changed during admission");
    } finally {
      chmod.mockRestore();
    }
    expect(lstatSync(root).mode & 0o7777).toBe(0o755);
    expect(lstatSync(original).mode & 0o7777).toBe(0o700);
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(original)).toEqual([]);
  });

  test("rechecks emptiness after durable mode initialization", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    const originalFsync = fs.fsyncSync;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      writeFileSync(join(root, "unexpected"), "leave this file untouched");
      return originalFsync(fd);
    });
    try {
      expect(() => initializeRailwayMount(root)).toThrow("nonempty Railway mount");
    } finally {
      fsync.mockRestore();
    }
    expect(readdirSync(root)).toEqual(["unexpected"]);
    expect(readFileSync(join(root, "unexpected"), "utf8")).toBe("leave this file untouched");
  });
});

describe("prepareRuntimeVolume", () => {
  test("rejects a missing advertised mount", () => {
    const root = makeRoot();
    expect(() =>
      prepareRuntimeVolume({ advertisedMount: undefined, runtimeDataRoot: root }),
    ).toThrow("got unset");
  });

  test("rejects the wrong advertised mount", () => {
    const root = makeRoot();
    expect(() =>
      prepareRuntimeVolume({ advertisedMount: `${root}-other`, runtimeDataRoot: root }),
    ).toThrow(`expected RAILWAY_VOLUME_MOUNT_PATH=${root}`);
  });

  test("rejects a missing runtime data root without creating it", () => {
    const parent = mkdtempSync(join(tmpdir(), "auggy-runtime-volume-missing-"));
    tempRoots.push(parent);
    const root = join(parent, "data");
    expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
      "runtime data root: does not exist",
    );
    expect(() => lstatSync(root)).toThrow();
  });

  test("rejects a symlink runtime data root", () => {
    const parent = mkdtempSync(join(tmpdir(), "auggy-runtime-volume-link-"));
    tempRoots.push(parent);
    const target = join(parent, "target");
    const root = join(parent, "data");
    mkdirSync(target);
    symlinkSync(target, root);
    expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
      "runtime data root: must not be a symlink",
    );
  });

  test("rejects a symlink AgentMail state leaf", () => {
    const root = makeRoot();
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "agent-mail"));
    expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
      "AgentMail state directory: directory is missing or unsafe",
    );
  });

  test("refuses to boot an incompletely reconciled restored volume", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, ".auggy-restore-fence.json"),
      JSON.stringify({
        version: 1,
        status: "requires-reconciliation",
        restoreId: "9fb78f48-61f3-41ca-a38f-0be277897f52",
        bundleManifestSha256: "a".repeat(64),
        restoredAt: "2026-07-25T13:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
      "reconcile downstream effects before startup",
    );
    expect(readdirSync(root)).toEqual([".auggy-restore-fence.json"]);
  });

  test("creates an owner-only leaf and completes the durability probe without residue", () => {
    const root = makeRoot();
    expect(prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toBe(root);

    const stateDir = join(root, "agent-mail");
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  test("repairs an existing state leaf to owner-only permissions", () => {
    const root = makeRoot();
    const stateDir = join(root, "agent-mail");
    mkdirSync(stateDir, { mode: 0o755 });
    chmodSync(stateDir, 0o755);

    prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root });
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o700);
  });

  test("rejects a permissive runtime root before creating state", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
      "runtime data root must have mode 0700",
    );
    expect(existsSync(join(root, "agent-mail"))).toBe(false);
  });

  test("keeps admission anchored when the configured root is replaced", () => {
    const root = makeRoot();
    const original = `${root}-original`;
    const outside = `${root}-outside`;
    mkdirSync(outside, { mode: 0o700 });
    chmodSync(outside, 0o700);

    expect(
      prepareRuntimeVolume({
        advertisedMount: root,
        runtimeDataRoot: root,
        agentId: "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211",
        __testHooks: {
          afterRootPinned() {
            renameSync(root, original);
            symlinkSync(outside, root, "dir");
          },
        },
      }),
    ).toBe(root);
    expect(readdirSync(join(original, "agent-mail"))).toEqual([]);
    expect(existsSync(join(original, ".auggy-state-identity.json"))).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("rejects a read-only volume where permission enforcement is available", () => {
    const root = makeRoot();
    chmodSync(root, 0o500);
    try {
      mkdirSync(join(root, "permission-check"));
      rmSync(join(root, "permission-check"), { recursive: true, force: true });
      return;
    } catch {
      expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
        "failed durability admission",
      );
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test("holds one crash-released singleton lease for a runtime volume", async () => {
    const root = makeRoot();
    const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../fixtures/runtime-volume-lease-child.ts"),
        root,
        agentId,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("lease-acquired");

    expect(() =>
      prepareRuntimeVolumeLease({ advertisedMount: root, runtimeDataRoot: root, agentId }),
    ).toThrow(/another live replica owns this agent volume/i);

    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
    const replacement = prepareRuntimeVolumeLease({
      advertisedMount: root,
      runtimeDataRoot: root,
      agentId,
    });
    replacement.release();
  });

  test("rejects symlink and hard-linked singleton lock anchors", () => {
    const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";
    const symlinkRoot = makeRoot();
    const symlinkTarget = join(symlinkRoot, "outside-lock");
    writeFileSync(symlinkTarget, "");
    symlinkSync(symlinkTarget, join(symlinkRoot, RUNTIME_SINGLETON_LOCK_FILE));
    expect(() =>
      prepareRuntimeVolumeLease({
        advertisedMount: symlinkRoot,
        runtimeDataRoot: symlinkRoot,
        agentId,
      }),
    ).toThrow(/regular non-symlink file/i);

    const hardLinkRoot = makeRoot();
    const hardLinkTarget = join(hardLinkRoot, "shared-lock");
    writeFileSync(hardLinkTarget, "");
    linkSync(hardLinkTarget, join(hardLinkRoot, RUNTIME_SINGLETON_LOCK_FILE));
    expect(() =>
      prepareRuntimeVolumeLease({
        advertisedMount: hardLinkRoot,
        runtimeDataRoot: hardLinkRoot,
        agentId,
      }),
    ).toThrow(/singly linked regular file/i);
  });
});
