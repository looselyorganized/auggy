import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import {
  AuthoringError,
  decodeSnapshotText,
  readFileSnapshot,
  sameFileIdentity,
  snapshotHash,
} from "../../src/cli/authoring/document-io";

const directories: string[] = [];
function fixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auggy-snapshot-")));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringError);
    return (error as AuthoringError).code;
  }
  throw new Error("Expected classified error");
}

describe("bounded descriptor snapshots", () => {
  test("returns stable identity and hashes without logging or modifying raw bytes", () => {
    const path = join(fixture(), "private.yaml");
    const bytes = Buffer.from("token: PRIVATE_BYTES\n");
    writeFileSync(path, bytes, { mode: 0o600 });
    const first = readFileSnapshot(path, bytes.length);
    const second = readFileSnapshot(path, bytes.length);
    expect(first.exists).toBe(true);
    expect(second.exists).toBe(true);
    if (!first.exists || !second.exists) throw new Error("Expected snapshots");
    expect(first.path).toBe(path);
    expect(first.bytes).toEqual(bytes);
    expect(first.sha256).toBe(snapshotHash(bytes));
    expect(first.identity.size).toBe(bytes.length);
    expect(first.identity.mode & 0o777).toBe(0o600);
    expect(first.identity.mode & 0o170000).toBe(0o100000);
    expect(sameFileIdentity(first.identity, second.identity)).toBe(true);
    chmodSync(path, 0o640);
    const changed = readFileSnapshot(path, bytes.length);
    expect(changed.exists && sameFileIdentity(first.identity, changed.identity)).toBe(false);
    expect(readFileSync(path)).toEqual(bytes);
  });

  test("missing optional files are distinct from errors and zero-byte files", () => {
    const path = join(fixture(), "missing");
    expect(readFileSnapshot(path, 0, { allowMissing: true })).toEqual({ path, exists: false });
    expect(errorCode(() => readFileSnapshot(path, 0))).toBe("missing-file");
    writeFileSync(path, "");
    const empty = readFileSnapshot(path, 0);
    expect(empty.exists && empty.bytes.length).toBe(0);
  });

  test("rejects oversized files and nonfinite or excessive limits", () => {
    const path = join(fixture(), "large");
    writeFileSync(path, "1234");
    expect(errorCode(() => readFileSnapshot(path, 3))).toBe("file-too-large");
    for (const limit of [Infinity, NaN, -1, 1.5, AUTHORING_LIMITS.aggregateOutputBytes + 1])
      expect(errorCode(() => readFileSnapshot(path, limit))).toBe("invalid-read-limit");
  });

  test("rejects leaf symlinks, directories and FIFO without blocking", () => {
    const dir = fixture();
    const target = join(dir, "target");
    writeFileSync(target, "private");
    const link = join(dir, "link");
    symlinkSync(target, link);
    expect(errorCode(() => readFileSnapshot(link, 1024))).toBe("unsafe-file");
    expect(errorCode(() => readFileSnapshot(dir, 1024))).toBe("unsafe-file");
    const pipe = join(dir, "pipe");
    const result = spawnSync("mkfifo", [pipe]);
    expect(result.status).toBe(0);
    const started = performance.now();
    expect(errorCode(() => readFileSnapshot(pipe, 1024))).toBe("unsafe-file");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("invalid UTF-8 is rejected, with no parser excerpts or causes", () => {
    expect(errorCode(() => decodeSnapshotText(new Uint8Array([0xc3, 0x28])))).toBe("invalid-utf8");
    expect(decodeSnapshotText(Buffer.from("options: { token: '${TOKEN}' }\n"))).toContain(
      "${TOKEN}",
    );
    const error = new AuthoringError("invalid-yaml", "Review the file locally.", {
      path: "secret\ncontrol",
      field: "options",
    });
    expect(error.diagnostic).toEqual({
      code: "invalid-yaml",
      message: "Review the file locally.",
      field: "options",
    });
    expect(error.cause).toBeUndefined();
  });
});
