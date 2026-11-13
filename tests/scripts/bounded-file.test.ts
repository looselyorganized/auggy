import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedRegularFile } from "../../scripts/release-smoke/bounded-file";
import { readApplicationJsonLines } from "../../scripts/release-smoke/application-http";
import { applicationArtifact } from "../../scripts/release-smoke/application-artifacts";

let root: string;
let path: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "auggy-bounded-file-"));
  path = join(root, "fixture");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("reads exact bounded bytes and mode, including an empty file", () => {
  fs.writeFileSync(path, "bounded", { mode: 0o640 });
  fs.chmodSync(path, 0o640);
  const actual = readBoundedRegularFile(path, 7);
  expect(actual.bytes.toString()).toBe("bounded");
  expect(actual.mode & 0o777).toBe(0o640);
  fs.writeFileSync(path, "");
  expect(readBoundedRegularFile(path, 0).bytes.length).toBe(0);
});

test("rejects invalid bounds, oversized files, directories and final-component symlinks", () => {
  for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])
    expect(() => readBoundedRegularFile(path, limit)).toThrow("size limit");
  fs.writeFileSync(path, "too large");
  expect(() => readBoundedRegularFile(path, 1)).toThrow("bound");
  expect(() => readBoundedRegularFile(root, 100)).toThrow("regular file");
  const link = join(root, "link");
  fs.symlinkSync(path, link);
  expect(() => readBoundedRegularFile(link, 100)).toThrow("symbolic links");
  expect(() => readBoundedRegularFile(join(root, "missing"), 100)).toThrow();
});

test.each(["growth", "truncation", "same-size write", "path replacement"] as const)(
  "rejects %s during descriptor reads, bounds requested bytes, and closes the descriptor",
  (change) => {
    const initialSize = 128 * 1024;
    fs.writeFileSync(path, Buffer.alloc(initialSize, "a"));
    const originalRead = fs.readSync;
    let changed = false;
    let requested = 0;
    let descriptor: number | undefined;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      descriptor = args[0] as number;
      requested += args[3] as number;
      const count = Reflect.apply(originalRead, fs, args) as number;
      if (!changed) {
        changed = true;
        if (change === "growth") fs.appendFileSync(path, Buffer.alloc(512 * 1024, "b"));
        else if (change === "truncation") fs.truncateSync(path, 1);
        else if (change === "same-size write")
          fs.writeFileSync(path, Buffer.alloc(initialSize, "b"));
        else {
          const replacement = join(root, "secret");
          fs.writeFileSync(replacement, "must never read this target");
          fs.unlinkSync(path);
          fs.symlinkSync(replacement, path);
        }
      }
      return count;
    });
    try {
      expect(() => readBoundedRegularFile(path, initialSize)).toThrow("changed while reading");
      expect(changed).toBe(true);
      expect(requested).toBeLessThanOrEqual(initialSize + 1);
      expect(descriptor).toBeDefined();
      expect(() => fs.fstatSync(descriptor!)).toThrow();
    } finally {
      read.mockRestore();
    }
  },
);

test("rejects a FIFO without waiting for a writer", () => {
  const create = spawnSync("mkfifo", [path], { timeout: 1000 });
  expect(create.status).toBe(0);
  const module = new URL("../../scripts/release-smoke/bounded-file.ts", import.meta.url).pathname;
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { readBoundedRegularFile } from ${JSON.stringify(module)};
    try { readBoundedRegularFile(${JSON.stringify(path)}, 1024); process.exit(2); }
    catch (error) {
      if (!error.message.includes("regular file")) throw error;
      process.stdout.write("rejected FIFO");
    }
  `,
    ],
    { timeout: 2000, encoding: "utf8", killSignal: "SIGKILL" },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("rejected FIFO");
});

test("artifact inventory hashes a bounded regular archive and rejects a final symlink", async () => {
  const staging = join(root, "package");
  fs.mkdirSync(staging);
  fs.writeFileSync(
    join(staging, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  fs.writeFileSync(join(staging, "index.ts"), "// Packaging fixture; never executed.\n");
  const archive = join(root, "fixture.tgz");
  const packed = spawnSync(
    "tar",
    ["-czf", archive, "-C", root, "package/package.json", "package/index.ts"],
    { timeout: 2000 },
  );
  expect(packed.status).toBe(0);
  const artifact = await applicationArtifact(archive, "fixture");
  expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(artifact.sourceFiles).toContain("package.json");
  expect(artifact.sourceFiles).toContain("index.ts");
  const alias = join(root, "alias.tgz");
  fs.symlinkSync(archive, alias);
  await expect(applicationArtifact(alias, "fixture")).rejects.toThrow("symbolic links");
});

test("diagnostic reads retry concurrent appends and return the complete stable records", () => {
  fs.writeFileSync(path, '{"sequence":1}\n');
  const originalRead = fs.readSync;
  let appended = false;
  const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (!appended) {
      appended = true;
      fs.appendFileSync(path, '{"sequence":2}\n');
    }
    return count;
  });
  try {
    expect(readApplicationJsonLines(root, "fixture")).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    expect(appended).toBe(true);
  } finally {
    read.mockRestore();
  }
});

test("diagnostic retry attempts remain bounded under continuous appends", () => {
  fs.writeFileSync(path, '{"sequence":1}\n');
  const originalRead = fs.readSync;
  let attempts = 0;
  const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    if (args[4] === 0) {
      attempts++;
      fs.appendFileSync(path, '{"sequence":2}\n');
    }
    return count;
  });
  try {
    expect(() => readApplicationJsonLines(root, "fixture")).toThrow("changed while reading");
    expect(attempts).toBe(3);
  } finally {
    read.mockRestore();
  }
});
