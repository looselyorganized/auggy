import { expect, test } from "bun:test";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectoryFd, renameAtNoReplace, tryOpenAt } from "../../src/lib/posix-at";

test("no-replace binding uses only verified Linux syscall ABIs and fails closed", () => {
  const modulePath = new URL("../../src/lib/posix-at.ts", import.meta.url).href;
  const cases = [
    { arch: "x64", mode: "syscall", expected: true, number: 316 },
    { arch: "arm64", mode: "syscall", expected: true, number: 276 },
    { arch: "riscv64", mode: "syscall", expected: false, number: null },
    { arch: "arm64", mode: "unavailable", expected: false, number: null },
    { arch: "arm64", mode: "syscall-error", expected: false, number: 276 },
    { arch: "arm64", mode: "native-error", expected: false, number: null },
  ];
  for (const fixture of cases) {
    // Each child gets an isolated FFI mock: no global native binding or process
    // architecture override can leak into the filesystem integration tests.
    const script = `
      import { mock } from "bun:test";
      import * as ffi from "bun:ffi";
      const fixture = ${JSON.stringify(fixture)};
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: fixture.arch });
      const calls = [];
      let syscallBindings = 0;
      mock.module("bun:ffi", () => ({ ...ffi, dlopen(_path, definitions) {
        if (definitions.renameat2) {
          if (fixture.mode === "native-error") return { symbols: { renameat2: () => -1 } };
          throw new Error("renameat2 not exported");
        }
        syscallBindings++;
        if (fixture.mode === "unavailable") throw new Error("syscall not exported");
        return { symbols: { syscall(number, oldfd, source, newfd, destination, flags, unused) {
          calls.push({ number, oldfd, source: Buffer.from(source).toString(), newfd,
            destination: Buffer.from(destination).toString(), flags, unused });
          return fixture.mode === "syscall-error" ? -1 : 0;
        } } };
      } }));
      const { renameAtNoReplace } = await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify({ result: renameAtNoReplace(7, "source", 9, "destination"),
        calls, syscallBindings }));
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script]);
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.result).toBe(fixture.expected);
    if (fixture.number === null) expect(result.calls).toEqual([]);
    else
      expect(result.calls).toEqual([
        {
          number: fixture.number,
          oldfd: 7,
          source: "source\0",
          newfd: 9,
          destination: "destination\0",
          flags: 1,
          unused: 0,
        },
      ]);
    if (fixture.arch === "riscv64" || fixture.mode === "native-error")
      expect(result.syscallBindings).toBe(0);
  }
});

test("no-replace publication moves the complete inode between directory descriptors", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-no-replace-"));
  mkdirSync(join(root, "stage"));
  mkdirSync(join(root, "destination"));
  const source = join(root, "stage", "source");
  const destination = join(root, "destination", "published");
  writeFileSync(source, "complete", { mode: 0o600 });
  const before = lstatSync(source);
  const sourceFd = openSync(join(root, "stage"), constants.O_RDONLY | constants.O_DIRECTORY);
  const destinationFd = openSync(
    join(root, "destination"),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    expect(renameAtNoReplace(sourceFd, "source", destinationFd, "published")).toBe(true);
    expect(existsSync(source)).toBe(false);
    const published = lstatSync(destination);
    expect([published.dev, published.ino, published.mode, published.nlink]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.nlink,
    ]);
    expect(readFileSync(destination, "utf8")).toBe("complete");
  } finally {
    closeSync(sourceFd);
    closeSync(destinationFd);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of ["file", "symlink", "dangling-symlink", "directory"] as const) {
  test(`no-replace publication preserves source and existing ${kind}`, () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-no-replace-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    writeFileSync(source, "staged", { mode: 0o600 });
    writeFileSync(join(root, "target"), "operator-owned");
    if (kind === "file") writeFileSync(destination, "operator-owned");
    else if (kind === "directory") {
      mkdirSync(destination);
      writeFileSync(join(destination, "entry"), "operator-owned");
    } else symlinkSync(kind === "symlink" ? "target" : "missing", destination);
    const beforeSource = lstatSync(source);
    const beforeDestination = lstatSync(destination);
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(renameAtNoReplace(fd, "source", fd, "destination")).toBe(false);
      expect(lstatSync(source).ino).toBe(beforeSource.ino);
      expect(readFileSync(source, "utf8")).toBe("staged");
      expect(lstatSync(destination).ino).toBe(beforeDestination.ino);
      expect(lstatSync(destination).mode).toBe(beforeDestination.mode);
      if (kind === "file") expect(readFileSync(destination, "utf8")).toBe("operator-owned");
      else if (kind === "directory")
        expect(readFileSync(join(destination, "entry"), "utf8")).toBe("operator-owned");
      else expect(readlinkSync(destination)).toBe(kind === "symlink" ? "target" : "missing");
      expect(readFileSync(join(root, "target"), "utf8")).toBe("operator-owned");
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("no-replace publication fails closed on invalid descriptors and missing source", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-no-replace-"));
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  writeFileSync(join(root, "source"), "staged");
  try {
    expect(renameAtNoReplace(-1, "source", fd, "destination")).toBe(false);
    expect(renameAtNoReplace(fd, "source", -1, "destination")).toBe(false);
    expect(renameAtNoReplace(fd, "missing", fd, "destination")).toBe(false);
    expect(existsSync(join(root, "destination"))).toBe(false);
    expect(readFileSync(join(root, "source"), "utf8")).toBe("staged");
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("competing no-replace publishers retain the losing source and the winning inode", async () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-no-replace-race-"));
  const modulePath = new URL("../../src/lib/posix-at.ts", import.meta.url).href;
  const sources = ["first", "second"];
  const before = sources.map((source) => {
    writeFileSync(join(root, source), source);
    return lstatSync(join(root, source));
  });
  const children = sources.map((source) => {
    const script = `
      import { closeSync, constants, openSync } from "node:fs";
      import { renameAtNoReplace } from ${JSON.stringify(modulePath)};
      const fd = openSync(${JSON.stringify(root)}, constants.O_RDONLY | constants.O_DIRECTORY);
      await Bun.write(Bun.stdout, "ready\\n");
      await Bun.stdin.text();
      const published = renameAtNoReplace(fd, ${JSON.stringify(source)}, fd, "destination");
      closeSync(fd);
      console.log(JSON.stringify(published));
    `;
    return Bun.spawn([process.execPath, "--eval", script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  });
  try {
    const readers = children.map((child) => child.stdout.getReader());
    const ready = await Promise.all(readers.map((reader) => reader.read()));
    expect(ready.map((chunk) => Buffer.from(chunk.value!).toString())).toEqual([
      "ready\n",
      "ready\n",
    ]);
    for (const child of children) child.stdin.end();
    const results = await Promise.all(
      children.map(async (child, index) => {
        const reader = readers[index]!;
        const chunks: Uint8Array[] = [];
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
        }
        reader.releaseLock();
        expect(await child.exited).toBe(0);
        return JSON.parse(Buffer.concat(chunks).toString()) as boolean;
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.indexOf(true);
    const loser = results.indexOf(false);
    expect(readFileSync(join(root, "destination"), "utf8")).toBe(sources[winner]!);
    expect(lstatSync(join(root, "destination")).ino).toBe(before[winner]!.ino);
    expect(existsSync(join(root, sources[winner]!))).toBe(false);
    expect(lstatSync(join(root, sources[loser]!)).ino).toBe(before[loser]!.ino);
    expect(readFileSync(join(root, sources[loser]!), "utf8")).toBe(sources[loser]!);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor enumeration distinguishes actual EOF, bounded truncation and an injected read error", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-directory-enumeration-"));
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    // A prior failing syscall leaves errno set; successful EOF must clear it.
    expect(tryOpenAt(fd, "missing", constants.O_RDONLY)).toHaveProperty("errno");
    expect(listDirectoryFd(fd, 1)).toEqual({ names: [], truncated: false });
    writeFileSync(join(root, "entry"), "private", { mode: 0o600 });
    expect(listDirectoryFd(fd, 0)).toEqual({ names: [], truncated: true });
    expect(listDirectoryFd(fd, 1)).toEqual({ names: ["entry"], truncated: false });
    expect(() =>
      listDirectoryFd(fd, 1, {
        readEntry: () => {
          // Reproduce readdir's error protocol: null with nonzero native errno.
          tryOpenAt(fd, "missing", constants.O_RDONLY);
          return null;
        },
      }),
    ).toThrow(/directory enumeration failed/);
    // The failed independent stream must not close or advance the caller's FD.
    expect(listDirectoryFd(fd, 1)).toEqual({ names: ["entry"], truncated: false });
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
