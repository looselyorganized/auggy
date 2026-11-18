import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { stripVTControlCharacters } from "node:util";

type AuditFailure =
  | "command-failed"
  | "timeout"
  | "output-limit"
  | "malformed-json"
  | "unexpected-shape"
  | "advisories"
  | "lockfile-changed";

export interface AuditOptions {
  cwd: string;
  evidencePath?: string;
  workspaceException?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Test seam; the CLI always executes this Bun binary with audit --json. */
  command?: readonly [string, ...string[]];
}

const SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function inspectAuditOutput(stdout: string): {
  failure: AuditFailure | null;
  advisoryPackages: number | null;
  advisories: Array<{ id: string | null; severity: string }>;
} {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { failure: "malformed-json", advisoryPackages: null, advisories: [] };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { failure: "unexpected-shape", advisoryPackages: null, advisories: [] };
  }
  const entries = Object.values(data);
  const advisories: Array<{ id: string | null; severity: string }> = [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    for (const advisory of entry) {
      if (typeof advisory !== "object" || advisory === null) continue;
      // Never publish raw registry bodies, package keys, titles, URLs or stderr:
      // failures can contain credentials. Retain only strict public identifiers.
      const id =
        typeof advisory.url === "string"
          ? (/^https:\/\/github\.com\/advisories\/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})$/.exec(
              advisory.url,
            )?.[1] ?? null)
          : null;
      advisories.push({
        id,
        severity: SEVERITIES.has(advisory.severity) ? advisory.severity : "unknown",
      });
    }
  }
  return {
    failure: entries.length === 0 ? null : "advisories",
    advisoryPackages: entries.length,
    advisories,
  };
}

// These fingerprints cover the reviewed M6 and v0.6 release graphs, including
// the sole picomatch resolution (4.0.5) and its console build dependency path.
const reviewedWorkspaceLocks = new Set([
  "cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7",
  "d4549b87ba5f47d5caf350437635459eb61e5e8cf45ad1bdee1b1ba2cfa73160",
]);
const picomatchException = {
  id: "GHSA-fc5q-39xc-vjpf",
  expiresAt: "2026-12-01T23:59:00.000Z",
};

export function matchesWorkspaceException(stdout: string, lockHash: string, now: number): boolean {
  if (!reviewedWorkspaceLocks.has(lockHash) || now >= Date.parse(picomatchException.expiresAt))
    return false;
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (
    !report ||
    typeof report !== "object" ||
    !("picomatch" in report) ||
    Object.keys(report).length !== 1
  )
    return false;
  const rows = report.picomatch;
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0];
  return (
    row?.url === `https://github.com/advisories/${picomatchException.id}` &&
    row.severity === "high" &&
    row.vulnerable_versions === "<=4.0.7"
  );
}

/** Full dependency graph, all severities. Errors are failures, never clean audits. */
export function acceptsWorkspaceAudit(
  options: Pick<AuditOptions, "cwd" | "workspaceException">,
  result: { status: number | null; signal: NodeJS.Signals | null; error?: Error },
  failure: AuditFailure | null,
  stdout: string,
  stderr: string,
  lockHash: string,
  now: number,
): boolean {
  return (
    options.workspaceException === true &&
    resolve(options.cwd) === resolve(import.meta.dir, "..") &&
    failure === "command-failed" &&
    result.status === 1 &&
    !result.signal &&
    !result.error &&
    // Bun 1.3.14 writes only its version banner to stderr on an advisory exit.
    /^bun audit v1\.3\.14 \([a-f0-9]+\)$/.test(stripVTControlCharacters(stderr).trim()) &&
    matchesWorkspaceException(stdout, lockHash, now)
  );
}

export function runDependencyAudit(options: AuditOptions) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("Audit timeout must be between 1 and 120000 milliseconds");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 4 * 1024 * 1024
  ) {
    throw new Error("Audit output limit must be between 1 and 4194304 bytes");
  }
  const lockPath = join(resolve(options.cwd), "bun.lock");
  const lockfileSHA256 = hash(readFileSync(lockPath));
  const source = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4096,
  });
  const revision = source.stdout?.trim();
  const command = options.command ?? [process.execPath, "audit", "--json"];
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    killSignal: "SIGKILL",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const inspection = inspectAuditOutput(stdout);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  let failure: AuditFailure | null =
    errorCode === "ETIMEDOUT"
      ? "timeout"
      : errorCode === "ENOBUFS"
        ? "output-limit"
        : result.error || result.status !== 0 || result.signal
          ? "command-failed"
          : inspection.failure;
  if (hash(readFileSync(lockPath)) !== lockfileSHA256) failure = "lockfile-changed";
  const finishedAt = new Date();
  const acceptedException = acceptsWorkspaceAudit(
    options,
    result,
    failure,
    stdout,
    stderr,
    lockfileSHA256,
    finishedAt.getTime(),
  );
  if (acceptedException) failure = null;
  const evidence = {
    ...(acceptedException ? { acceptedException: picomatchException } : {}),
    schema: 1,
    status: failure ? ("failed" as const) : ("passed" as const),
    failure,
    startedAt,
    finishedAt: finishedAt.toISOString(),
    sourceRevision: revision && /^[a-f0-9]{40}$/.test(revision) ? revision : null,
    helperSHA256: hash(readFileSync(import.meta.path)),
    lockfileSHA256,
    bun: Bun.version,
    platform: process.platform,
    timeoutMs,
    maxOutputBytes,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    stdoutSHA256: hash(stdout),
    stderrSHA256: hash(stderr),
    advisoryPackages: inspection.advisoryPackages,
    advisories: inspection.advisories,
  };
  if (options.evidencePath) {
    mkdirSync(dirname(resolve(options.evidencePath)), { recursive: true });
    writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  return evidence;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options: AuditOptions = { cwd: process.cwd() };
    const seen = new Set<string>();
    while (args.length) {
      const flag = args.shift()!;
      if (flag === "--workspace-exception" && !seen.has(flag)) {
        seen.add(flag);
        options.workspaceException = true;
        continue;
      }
      const value = args.shift();
      if ((flag !== "--cwd" && flag !== "--evidence") || !value || seen.has(flag)) {
        throw new Error("Expected optional --workspace-exception, --cwd and --evidence arguments");
      }
      seen.add(flag);
      if (flag === "--cwd") options.cwd = resolve(value);
      else options.evidencePath = resolve(value);
    }
    const result = runDependencyAudit(options);
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch {
    // Do not echo filesystem/registry errors that might contain credentials.
    console.error("Dependency audit could not produce a verified result");
    process.exitCode = 1;
  }
}
