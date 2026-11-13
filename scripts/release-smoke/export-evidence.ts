import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** Publish only bounded text diagnostics; never copy an agent directory or headers. */
export function redactEvidence(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/(\/console\/cli-login\/)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/((?:set-cookie|cookie|authorization):)[^\r\n]+/gi, "$1 [REDACTED]")
    .replace(/(sk-ant-|sk-proj-|am_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(
      /(\/console\/[^\s"']*(?:ticket|login)[^\s"']*[?&](?:token|ticket)=)[^\s"'&]+/gi,
      "$1[REDACTED]",
    );
}

export function readBoundedLog(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 2_000_000);
    const buffer = Buffer.alloc(Math.min(size, 2_000_000));
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, read).toString("utf8");
    return start > 0 ? (text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "") : text;
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const [smokeDir, outputDir, status, sourceRevision, packDir, repoRoot] = process.argv.slice(2);
  if (!smokeDir || !outputDir) throw new Error("expected smoke directory and evidence directory");
  mkdirSync(outputDir, { recursive: true });
  const envPath = join(smokeDir, "smoke-agent", ".env");
  const secrets = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = line.match(/^[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=(.+)$/);
          return match?.[1] ? [match[1].replace(/^["']|["']$/g, "")] : [];
        })
    : [];
  const logDir = join(smokeDir, "logs");
  for (const file of existsSync(logDir) ? readdirSync(logDir) : []) {
    if (!file.endsWith(".log")) continue;
    const path = join(logDir, file);
    if (!statSync(path).isFile()) continue;
    const text = readBoundedLog(path);
    writeFileSync(join(outputDir, basename(file)), redactEvidence(text, secrets));
  }
  const packs = packDir ?? join(smokeDir, "packs");
  const hashes = Object.fromEntries(
    (existsSync(packs) ? readdirSync(packs) : [])
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(packs, name)))
          .digest("hex"),
      ]),
  );
  const records: Record<string, string> = {};
  function hashRecords(directory: string, prefix = "", depth = 0): void {
    if (depth > 4) throw new Error("Evidence directory nesting exceeded");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) hashRecords(join(directory, entry.name), `${name}/`, depth + 1);
      else if (entry.isFile() && name !== "release.json" && /\.(log|json|jsonl)$/.test(name)) {
        if (Object.keys(records).length >= 1_000) throw new Error("Evidence record limit exceeded");
        records[name] = createHash("sha256")
          .update(readFileSync(join(directory, entry.name)))
          .digest("hex");
      }
    }
  }
  hashRecords(outputDir);
  const lockfileSHA256 = repoRoot
    ? createHash("sha256")
        .update(readFileSync(join(repoRoot, "bun.lock")))
        .digest("hex")
    : undefined;
  const changes = repoRoot
    ? Bun.spawnSync(["git", "diff", "HEAD", "--binary"], { cwd: repoRoot })
    : undefined;
  if (changes && changes.exitCode !== 0) throw new Error("Could not identify source changes");
  const sourceChangesSHA256 = changes
    ? createHash("sha256").update(changes.stdout).digest("hex")
    : undefined;
  writeFileSync(
    join(outputDir, "release.json"),
    JSON.stringify(
      {
        sourceRevision,
        sourceChangesSHA256,
        lockfileSHA256,
        records,
        exitCode: Number(status),
        bun: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        tarballs: hashes,
      },
      null,
      2,
    ),
  );
}
