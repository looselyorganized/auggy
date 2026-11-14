import { expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectoryFd, tryOpenAt } from "../../src/lib/posix-at";

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
