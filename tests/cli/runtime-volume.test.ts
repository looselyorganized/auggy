import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeVolume } from "../../src/cli/runtime-volume";

const tempRoots: string[] = [];

function makeRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "auggy-runtime-volume-"));
  tempRoots.push(parent);
  const root = join(parent, "data");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // The test may have replaced or removed this path.
    }
    rmSync(root, { recursive: true, force: true });
  }
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
});
