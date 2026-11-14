import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeDataVolume, RUNTIME_SINGLETON_LOCK_FILE } from "../src/cli/runtime-volume";
import { createPinnedFile } from "../src/lib/anchored-files";
import { tryLockFileExclusive } from "../src/lib/posix-at";
import { withRuntimeDataAdmission } from "../src/runtime-data-admission";
import type {
  AdmittedRuntimeVolumeLease,
  RuntimeDataAdmission,
} from "../src/runtime-data-contracts";

const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";
const tempRoots: string[] = [];
const leases: AdmittedRuntimeVolumeLease[] = [];

function makeRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "auggy-runtime-admission-"));
  tempRoots.push(parent);
  const root = join(parent, "data");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function admit(root: string): AdmittedRuntimeVolumeLease {
  const lease = prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId);
  leases.push(lease);
  return lease;
}

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime data admission capability", () => {
  test("issues one frozen identity and retains its private root descriptor until release", () => {
    const root = makeRoot();
    const lease = admit(root);
    const token = lease.runtimeDataAdmission;
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.keys(token).sort()).toEqual(["agentId", "runtimeDataRoot"]);
    expect(Object.keys(lease).sort()).toEqual([
      "release",
      "runtimeDataAdmission",
      "runtimeDataRoot",
    ]);
    // Test-only descriptor observation verifies ownership; production callers
    // must not retain or use a borrowed descriptor outside their callback.
    const retained = withRuntimeDataAdmission(token, (fd) => fd);
    expect(fstatSync(retained).isDirectory()).toBe(true);
    expect(
      withRuntimeDataAdmission(token, (fd) => createPinnedFile(fd, "owned", "data", "test file")),
    ).toBe(true);
    lease.release();
    expect(() => withRuntimeDataAdmission(token, () => true)).toThrow("lease has been released");
    expect(() => fstatSync(retained)).toThrow();
    expect(() => lease.release()).not.toThrow();
    expect(() => admit(root)).not.toThrow();
  });

  test("rejects fabricated, spread and prototype-derived tokens before entering the callback", () => {
    const root = makeRoot();
    const token = admit(root).runtimeDataAdmission;
    const inputs = [
      { runtimeDataRoot: root, agentId },
      { ...token },
      Object.create(token),
      null,
      undefined,
    ];
    let calls = 0;
    for (const value of inputs) {
      expect(() =>
        withRuntimeDataAdmission(value as RuntimeDataAdmission, () => {
          calls++;
        }),
      ).toThrow("admission is invalid");
    }
    expect(calls).toBe(0);
  });

  test("capability does not revive when a new lease opens the same root", () => {
    const root = makeRoot();
    const old = admit(root);
    old.release();
    const current = admit(root);
    expect(current.runtimeDataAdmission).not.toBe(old.runtimeDataAdmission);
    expect(() => withRuntimeDataAdmission(old.runtimeDataAdmission, () => true)).toThrow(
      "released",
    );
    expect(withRuntimeDataAdmission(current.runtimeDataAdmission, () => true)).toBe(true);
  });

  test("root pathname replacement cannot mix an old pinned root with a new database root", () => {
    const root = makeRoot();
    const lease = admit(root);
    const original = `${root}-original`;
    renameSync(root, original);
    mkdirSync(root, { mode: 0o700 });
    let calls = 0;
    expect(() =>
      withRuntimeDataAdmission(lease.runtimeDataAdmission, () => {
        calls++;
      }),
    ).toThrow("root path changed");
    expect(calls).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(() => admit(original)).toThrow("another live replica");
    lease.release();
    expect(() => admit(original)).not.toThrow();
  });

  test("replacing the configured root with a symlink to the original still fails", () => {
    const root = makeRoot();
    const lease = admit(root);
    const original = `${root}-original`;
    renameSync(root, original);
    symlinkSync(original, root);
    expect(() => withRuntimeDataAdmission(lease.runtimeDataAdmission, () => true)).toThrow(
      "symlink",
    );
  });

  test("benign parent aliases work but retargeting the alias invalidates admission", () => {
    const root = makeRoot();
    const parent = join(root, "parent");
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(join(parent, "state"), { mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(parent, alias);
    const lease = admit(join(alias, "state"));
    expect(withRuntimeDataAdmission(lease.runtimeDataAdmission, () => true)).toBe(true);
    const other = join(root, "other");
    mkdirSync(other, { mode: 0o700 });
    mkdirSync(join(other, "state"), { mode: 0o700 });
    rmSync(alias);
    symlinkSync(other, alias);
    expect(() => withRuntimeDataAdmission(lease.runtimeDataAdmission, () => true)).toThrow(
      "root path changed",
    );
    expect(readdirSync(join(other, "state"))).toEqual([]);
  });

  test("private mode and current ownership must survive for the whole lease", () => {
    const root = makeRoot();
    const lease = admit(root);
    chmodSync(root, 0o755);
    expect(() => withRuntimeDataAdmission(lease.runtimeDataAdmission, () => true)).toThrow(
      "mode 0700",
    );
    chmodSync(root, 0o700);
    const uid = process.getuid!();
    const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(() => withRuntimeDataAdmission(lease.runtimeDataAdmission, () => true)).toThrow(
        "owned by the current user",
      );
    } finally {
      getuid.mockRestore();
    }
    expect(withRuntimeDataAdmission(lease.runtimeDataAdmission, () => true)).toBe(true);
  });

  test("a callback cannot successfully return after replacing its root or releasing its lease", () => {
    const root = makeRoot();
    const lease = admit(root);
    expect(() =>
      withRuntimeDataAdmission(lease.runtimeDataAdmission, () => {
        chmodSync(root, 0o755);
        return "must not escape";
      }),
    ).toThrow("mode 0700");
    chmodSync(root, 0o700);
    expect(() =>
      withRuntimeDataAdmission(lease.runtimeDataAdmission, () => {
        lease.release();
        return "must not escape";
      }),
    ).toThrow("released during descriptor borrowing");
  });

  test("runtime thenable rejection backs up the synchronous callback type", () => {
    const lease = admit(makeRoot());
    const token = lease.runtimeDataAdmission;
    const erased = withRuntimeDataAdmission as unknown as (
      admission: RuntimeDataAdmission,
      operation: (fd: number) => unknown,
    ) => unknown;
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: Exercise deliberate thenable rejection.
      then() {},
    };
    const ordinaryData = {
      // biome-ignore lint/suspicious/noThenProperty: A non-callable field is not a thenable.
      then: "data",
    };
    expect(() => erased(token, () => Promise.resolve(1))).toThrow("must be synchronous");
    expect(() => erased(token, () => thenable)).toThrow("must be synchronous");
    expect(withRuntimeDataAdmission(token, () => ordinaryData)).toBe(ordinaryData);
    expect(() =>
      withRuntimeDataAdmission(token, () => {
        throw new Error("callback failed");
      }),
    ).toThrow("callback failed");
    expect(withRuntimeDataAdmission(token, () => true)).toBe(true);
  });

  test.each(["missing", "replaced", "symlink", "hardlink", "mode"] as const)(
    "refuses a %s singleton anchor before lending the root descriptor",
    (mutation) => {
      const root = makeRoot();
      const lease = admit(root);
      const lock = join(root, RUNTIME_SINGLETON_LOCK_FILE);
      if (mutation === "hardlink") {
        linkSync(lock, join(root, "lock-alias"));
      } else if (mutation === "mode") {
        chmodSync(lock, 0o644);
      } else {
        const previous = join(root, "old-lock");
        renameSync(lock, previous);
        if (mutation === "replaced") writeFileSync(lock, "", { mode: 0o600 });
        if (mutation === "symlink") symlinkSync(previous, lock);
      }
      let calls = 0;
      expect(() =>
        withRuntimeDataAdmission(lease.runtimeDataAdmission, () => {
          calls++;
        }),
      ).toThrow(/singleton lock/);
      expect(calls).toBe(0);
    },
  );

  test("a replacement singleton lease cannot leave the old capability usable", () => {
    const root = makeRoot();
    const old = admit(root);
    renameSync(join(root, RUNTIME_SINGLETON_LOCK_FILE), join(root, "old-lock"));
    const replacement = admit(root);
    expect(() => withRuntimeDataAdmission(old.runtimeDataAdmission, () => true)).toThrow(
      "lock path changed",
    );
    expect(withRuntimeDataAdmission(replacement.runtimeDataAdmission, () => true)).toBe(true);
    old.release();
    expect(withRuntimeDataAdmission(replacement.runtimeDataAdmission, () => true)).toBe(true);
  });

  test("lock replacement before capability issuance refuses admission and releases the old inode", () => {
    const root = makeRoot();
    const oldLock = join(root, "old-lock");
    expect(() =>
      prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId, {
        __testHooks: {
          beforeCapabilityIssued() {
            renameSync(join(root, RUNTIME_SINGLETON_LOCK_FILE), oldLock);
            writeFileSync(join(root, RUNTIME_SINGLETON_LOCK_FILE), "", { mode: 0o600 });
          },
        },
      }),
    ).toThrow("lock path changed");
    const fd = openSync(oldLock, constants.O_RDWR);
    try {
      expect(tryLockFileExclusive(fd)).toBe("acquired");
    } finally {
      closeSync(fd);
    }
    expect(() => admit(root)).not.toThrow();
  });

  test("late root replacement refuses capability issuance and releases the original root", () => {
    const root = makeRoot();
    const original = `${root}-original`;
    expect(() =>
      prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId, {
        __testHooks: {
          beforeCapabilityIssued() {
            renameSync(root, original);
            mkdirSync(root, { mode: 0o700 });
          },
        },
      }),
    ).toThrow("root path changed");
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(join(original, "agent-mail"))).toEqual([]);
    expect(() => admit(original)).not.toThrow();
  });

  test("production admission singleton survives until its process exits", async () => {
    const root = makeRoot();
    const module = new URL("../src/cli/runtime-volume.ts", import.meta.url).href;
    const source = `import { prepareRuntimeDataVolume } from ${JSON.stringify(module)};
      prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: ${JSON.stringify(root)} }, ${JSON.stringify(agentId)});
      console.log("production-lease-acquired"); await Bun.sleep(60_000);`;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("production-lease-acquired");
      expect(() => admit(root)).toThrow("another live replica");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      reader.releaseLock();
    }
    expect(() => admit(root)).not.toThrow();
  });
});
