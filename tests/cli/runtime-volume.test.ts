import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeVolume } from "../../src/cli/runtime-volume";

const tempRoots: string[] = [];

function makeRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "auggy-runtime-volume-"));
  tempRoots.push(parent);
  const root = join(parent, "data");
  mkdirSync(root);
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
      "runtime data root does not exist",
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
      "runtime data root must be a real directory",
    );
  });

  test("rejects a symlink AgentMail state leaf", () => {
    const root = makeRoot();
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, "agent-mail"));
    expect(() => prepareRuntimeVolume({ advertisedMount: root, runtimeDataRoot: root })).toThrow(
      "AgentMail state directory must be a real directory",
    );
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
