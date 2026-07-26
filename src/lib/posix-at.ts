import { CString, dlopen, FFIType, read as ffiRead } from "bun:ffi";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

interface PosixAtSymbols {
  openat(dirfd: number, path: Uint8Array, flags: number, mode: number): number;
  mkdirat(dirfd: number, path: Uint8Array, mode: number): number;
  unlinkat(dirfd: number, path: Uint8Array, flags: number): number;
  renameat(olddirfd: number, oldpath: Uint8Array, newdirfd: number, newpath: Uint8Array): number;
  flock(fd: number, operation: number): number;
  dup(fd: number): number;
  fdopendir(fd: number): unknown;
  readdir(directory: unknown): unknown;
  closedir(directory: unknown): number;
  errno(): number;
}

let symbols: PosixAtSymbols | null = null;
let library: ReturnType<typeof dlopen> | null = null;

function requireSymbols(): PosixAtSymbols {
  if (symbols) return symbols;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("descriptor-relative filesystem isolation is unavailable");
  }
  const libraryPaths =
    process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : (() => {
          const muslArch =
            process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
          return [
            "libc.so.6",
            `/lib/ld-musl-${muslArch}.so.1`,
            `/lib/libc.musl-${muslArch}.so.1`,
            `/usr/lib/libc.musl-${muslArch}.so.1`,
          ];
        })();
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  const definitions = {
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    mkdirat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    unlinkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    renameat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    dup: {
      args: [FFIType.i32],
      returns: FFIType.i32,
    },
    fdopendir: {
      args: [FFIType.i32],
      returns: FFIType.ptr,
    },
    readdir: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    closedir: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
    [errnoSymbol]: {
      args: [],
      returns: FFIType.ptr,
    },
  } as const;
  for (const libraryPath of libraryPaths) {
    try {
      library = dlopen(libraryPath, definitions);
      break;
    } catch {
      // Try the next known libc soname. Failure remains fail-closed below.
    }
  }
  if (!library) {
    throw new Error("descriptor-relative filesystem isolation is unavailable");
  }
  const linked = library.symbols as Record<string, (...args: never[]) => unknown>;
  symbols = {
    openat: linked.openat as unknown as PosixAtSymbols["openat"],
    mkdirat: linked.mkdirat as unknown as PosixAtSymbols["mkdirat"],
    unlinkat: linked.unlinkat as unknown as PosixAtSymbols["unlinkat"],
    renameat: linked.renameat as unknown as PosixAtSymbols["renameat"],
    flock: linked.flock as unknown as PosixAtSymbols["flock"],
    dup: linked.dup as unknown as PosixAtSymbols["dup"],
    fdopendir: linked.fdopendir as unknown as PosixAtSymbols["fdopendir"],
    readdir: linked.readdir as unknown as PosixAtSymbols["readdir"],
    closedir: linked.closedir as unknown as PosixAtSymbols["closedir"],
    errno: () => ffiRead.i32(linked[errnoSymbol]!() as never, 0),
  };
  return symbols;
}

/** Acquire a non-blocking exclusive advisory lock on one open file description. */
export function tryLockFileExclusive(fd: number): "acquired" | "busy" {
  const linked = requireSymbols();
  const lockExclusive = 2;
  const lockNonBlocking = 4;
  if (linked.flock(fd, lockExclusive | lockNonBlocking) === 0) return "acquired";
  const errno = linked.errno();
  const wouldBlock = process.platform === "darwin" ? 35 : 11;
  if (errno === wouldBlock) return "busy";
  throw new Error(`exclusive file lock failed (errno ${errno})`);
}

function nativeSegment(segment: string): Uint8Array {
  if (
    segment.length === 0 ||
    segment.includes("\0") ||
    segment.includes("/") ||
    segment === "." ||
    segment === ".."
  ) {
    throw new Error("unsafe descriptor-relative path segment");
  }
  return Buffer.from(`${segment}\0`, "utf8");
}

export function openAt(dirfd: number, segment: string, flags: number, mode = 0): number {
  const result = tryOpenAt(dirfd, segment, flags, mode);
  if ("errno" in result) {
    throw new Error("descriptor-relative open failed");
  }
  return result.fd;
}

export function tryOpenAt(
  dirfd: number,
  segment: string,
  flags: number,
  mode = 0,
): { fd: number } | { errno: number } {
  const linked = requireSymbols();
  const fd = linked.openat(dirfd, nativeSegment(segment), flags, mode);
  return fd < 0 ? { errno: linked.errno() } : { fd };
}

export function mkdirAt(dirfd: number, segment: string, mode: number): boolean {
  return requireSymbols().mkdirat(dirfd, nativeSegment(segment), mode) === 0;
}

export function unlinkAt(dirfd: number, segment: string, removeDirectory = false): boolean {
  const atRemoveDir = process.platform === "darwin" ? 0x0080 : 0x0200;
  return (
    requireSymbols().unlinkat(dirfd, nativeSegment(segment), removeDirectory ? atRemoveDir : 0) ===
    0
  );
}

export function renameAt(
  olddirfd: number,
  oldSegment: string,
  newdirfd: number,
  newSegment: string,
): boolean {
  return (
    requireSymbols().renameat(
      olddirfd,
      nativeSegment(oldSegment),
      newdirfd,
      nativeSegment(newSegment),
    ) === 0
  );
}

export function duplicateFd(fd: number): number {
  const duplicated = requireSymbols().dup(fd);
  if (duplicated < 0) throw new Error("could not duplicate descriptor");
  return duplicated;
}

const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;

export function openAbsoluteDirectoryNoFollow(path: string): number {
  if (!isAbsolute(path) || process.platform === "win32") {
    throw new Error("descriptor-relative root path must be absolute");
  }
  let current = openSync("/", DIRECTORY_FLAGS);
  try {
    for (const segment of path.split("/").filter(Boolean)) {
      const child = openAt(current, segment, DIRECTORY_FLAGS);
      closeSync(current);
      current = child;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

function reopenDirectoryFd(fd: number): number {
  const linked = requireSymbols();
  const dot = Buffer.from(".\0", "utf8");
  const reopened = linked.openat(fd, dot, DIRECTORY_FLAGS, 0);
  if (reopened < 0) throw new Error("could not reopen directory descriptor");
  return reopened;
}

export function listDirectoryFd(
  fd: number,
  maxEntries: number,
): { names: string[]; truncated: boolean } {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new Error("directory entry limit must be a non-negative safe integer");
  }
  const linked = requireSymbols();
  // openat(".") creates an independent open file description. dup() would
  // share the directory offset and let one listing blind later callers.
  const reopened = reopenDirectoryFd(fd);
  const directory = linked.fdopendir(reopened);
  if (!directory) {
    closeSync(reopened);
    throw new Error("could not open directory stream");
  }
  const names: string[] = [];
  let truncated = false;
  try {
    while (true) {
      const entry = linked.readdir(directory);
      if (!entry) break;
      const nameOffset = process.platform === "darwin" ? 21 : 19;
      const nameLength =
        process.platform === "darwin" ? ffiRead.u16(entry as never, 18) : undefined;
      const name = new CString(entry as never, nameOffset, nameLength).toString();
      if (name === "." || name === "..") continue;
      if (names.length >= maxEntries) {
        truncated = true;
        break;
      }
      names.push(name);
    }
    return { names, truncated };
  } finally {
    linked.closedir(directory);
  }
}

export function readFileFdBounded(
  fd: number,
  maxBytes: number,
): { buffer: Buffer; exceeded: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("file byte limit must be a non-negative safe integer");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
    if (total > maxBytes) break;
  }
  return {
    buffer: Buffer.concat(chunks, total),
    exceeded: total > maxBytes,
  };
}
