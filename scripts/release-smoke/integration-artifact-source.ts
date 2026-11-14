/** Verify every packed byte against tracked source or explicit generated console output. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validateAcceptedPackInventory } from "./accepted-main-artifacts";
import { applicationHash } from "./application-consumer";
import { readIntegrationFile } from "./integration-consumer";
import type { HashedIntegrationFile } from "./integration-contracts";

const MAX_BYTES = 256 * 1024 * 1024;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function verifyIntegrationArtifactSource(options: {
  repoRoot: string;
  archive: string;
  packageName: string;
  sourceFiles: readonly HashedIntegrationFile[];
}) {
  check(
    /^(?:auggy|@auggy\/(?:anthropic|openai|openrouter|ollama))$/.test(options.packageName),
    "Unsupported integration package",
  );
  const archiveHash = () =>
    applicationHash(
      readIntegrationFile(dirname(options.archive), basename(options.archive), MAX_BYTES),
    );
  const archiveSHA256 = archiveHash();
  const tar = (flags: string, maxBuffer: number): Buffer => {
    const result = spawnSync("tar", [flags, options.archive], {
      timeout: 30000,
      maxBuffer,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    check(
      !result.error && result.status === 0 && !result.signal,
      "Cannot read bounded integration archive",
    );
    return result.stdout;
  };
  const paths = validateAcceptedPackInventory(
    tar("-tzf", 4 * 1024 * 1024).toString("utf8"),
    tar("-tvzf", 4 * 1024 * 1024).toString("utf8"),
  );
  const core = options.packageName === "auggy";
  const prefix = core ? "" : `packages/${options.packageName.slice("@auggy/".length)}/`;
  const tracked = new Map(options.sourceFiles.map((file) => [file.path, file.sha256]));
  const packed = new Set(paths);
  for (const path of tracked.keys()) {
    if (path.startsWith(`${prefix}src/`))
      check(packed.has(path.slice(prefix.length)), "Packed runtime source inventory is incomplete");
  }
  let size = 0;
  const expected = paths.map((path) => {
    const sourcePath =
      path === "LICENSE" && !existsSync(join(options.repoRoot, prefix, path))
        ? "LICENSE"
        : `${prefix}${path}`;
    const generated = core && path.startsWith("admin/dist/");
    check(tracked.has(sourcePath) || generated, "Packed file is absent from committed source");
    const bytes = readIntegrationFile(options.repoRoot, sourcePath, 32 * 1024 * 1024);
    const sha256 = applicationHash(bytes);
    check(
      generated || tracked.get(sourcePath) === sha256,
      "Tracked source changed before archive verification",
    );
    size += bytes.length;
    check(size <= MAX_BYTES, "Packed source aggregate byte bound exceeded");
    return {
      path,
      sha256,
      bytes: bytes.length,
      origin: generated ? ("generated-console-build" as const) : ("committed-source" as const),
    };
  });
  // After validating every entry is an ordinary unique file, tar's stdout is the
  // concatenation of those files in archive order. No extraction or path writes.
  const payload = tar("-xOzf", Math.min(MAX_BYTES, size + 1));
  check(payload.length === size, "Packed source byte inventory differs");
  let offset = 0;
  for (const file of expected) {
    check(
      applicationHash(payload.subarray(offset, offset + file.bytes)) === file.sha256,
      `Packed file differs from committed source or generated build: ${file.path}`,
    );
    offset += file.bytes;
  }
  check(archiveHash() === archiveSHA256, "Archive changed during full source verification");
  return { packageName: options.packageName, archiveSHA256, files: expected };
}
