/**
 * Offline, operator-only control plane for the local Durable Jobs v1 store.
 *
 * This command deliberately exposes summaries only. Prompts, canonical
 * bindings, results, reconciliation evidence, and raw SQLite diagnostics are
 * private runtime data and must not reach a terminal by way of this CLI.
 */

import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import { createSqliteDurableJobStore } from "../../jobs/sqlite-store";
import type { DurableJobState, DurableJobStore, DurableJobSummary } from "../../jobs/types";
import { parseConfig } from "../config-parser";
import { resolveOwnedStatePath } from "../owned-state-path";
import { resolveConfigPath } from "../resolve-config";
import { resolveRuntimeStatePath } from "../runtime-state-inventory";
import type { DurableJobsConfig } from "../types";

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const STRICT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const JOB_STATES = new Set<DurableJobState>([
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "canceled",
  "outcome_unknown",
]);

export interface DurableJobsCommandOptions {
  config?: string;
  root?: string;
  cwd?: string;
  /** Test seam. Production reads the Railway mount from process.env. */
  env?: Record<string, string | undefined>;
}

export interface DurableJobsListOptions extends DurableJobsCommandOptions {
  state?: string;
  limit?: string | number;
}

export interface DurableJobsMutationOptions extends DurableJobsCommandOptions {
  version: string | number;
}

export interface DurableJobsReconcileOptions extends DurableJobsMutationOptions {
  disposition: string;
  evidence: string;
}

export interface DurableJobsPruneOptions extends DurableJobsCommandOptions {
  before?: string;
  limit?: string | number;
  yes?: boolean;
}

export interface DurableJobsCommandDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  exit?: (code: number) => void;
}

/** A deliberately non-diagnostic error safe to show to an operator. */
export class DurableJobsCommandError extends Error {}

function inputError(): DurableJobsCommandError {
  return new DurableJobsCommandError("durable jobs command input is invalid");
}

function unavailableError(): DurableJobsCommandError {
  return new DurableJobsCommandError("durable jobs state is unavailable or unsafe");
}

function databaseMissingError(): DurableJobsCommandError {
  return new DurableJobsCommandError("durable jobs database is not available");
}

function operationError(): DurableJobsCommandError {
  return new DurableJobsCommandError("durable jobs operation could not be completed");
}

function assertJobId(value: string): string {
  if (!JOB_ID_RE.test(value)) throw inputError();
  return value;
}

function parsePositiveVersion(value: string | number): number {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value)) throw inputError();
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw inputError();
  return parsed;
}

function parseBoundedLimit(
  value: string | number | undefined,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value)) throw inputError();
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw inputError();
  return parsed;
}

function parseState(value: string | undefined): DurableJobState | undefined {
  if (value === undefined) return undefined;
  if (!JOB_STATES.has(value as DurableJobState)) throw inputError();
  return value as DurableJobState;
}

function parseStrictIso(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!STRICT_ISO_RE.test(value)) throw inputError();
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || new Date(parsed).toISOString() !== value) {
    throw inputError();
  }
  return parsed;
}

function parseEvidence(value: string): string {
  if (!EVIDENCE_RE.test(value)) throw inputError();
  return value;
}

function parseDisposition(value: string): "retry" | "cancel" | "confirm_completed" {
  switch (value) {
    case "retry":
    case "cancel":
      return value;
    case "confirm-completed":
      return "confirm_completed";
    default:
      throw inputError();
  }
}

function durableStoreOptions(dbPath: string, jobs: DurableJobsConfig) {
  return {
    dbPath,
    maxTotalRecords: jobs.maxTotalRecords,
    maxQueuedRecords: jobs.maxQueuedRecords,
    maxPrivateBytes: jobs.maxPrivateBytes,
    terminalRetentionMs: jobs.terminalRetentionMs,
    auditRetentionMs: jobs.auditRetentionMs,
  };
}

/**
 * Resolve a jobs database without creating any directory or database leaf.
 * When a runtime root is supplied, a relative config path maps into that
 * root exactly as it does in runtime-state inventory. The owned-path walk
 * then rejects symlink parents and absolute/root escapes.
 */
export function resolveDurableJobsDatabase(
  name: string | undefined,
  options: DurableJobsCommandOptions = {},
): { dbPath: string; jobs: DurableJobsConfig } {
  try {
    const configPath = resolveConfigPath(name, options.config, { cwd: options.cwd });
    const config = parseConfig(configPath);
    const jobs = config.settings.jobs;
    if (!jobs) {
      throw new DurableJobsCommandError("durable jobs are not enabled for this agent");
    }

    const agentDir = dirname(configPath);
    const rootValue = options.root ?? (options.env ?? process.env).RAILWAY_VOLUME_MOUNT_PATH;
    if (rootValue !== undefined && !isAbsolute(rootValue)) throw unavailableError();
    const runtimeRoot = rootValue === undefined ? undefined : resolve(rootValue);
    const mapped = resolveRuntimeStatePath(
      jobs.dbPath,
      agentDir,
      runtimeRoot,
      "durable jobs database",
    );
    const ownedRoot = runtimeRoot ?? agentDir;
    const dbPath = resolveOwnedStatePath(mapped, agentDir, ownedRoot, "durable jobs database");
    const stat = lstatSync(dbPath, { throwIfNoEntry: false });
    if (!stat) throw databaseMissingError();
    // A zero-byte leaf is only the secure precreation marker used immediately
    // before a runtime initializes the store. An offline read/control command
    // must never turn that marker into a newly initialized database.
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) throw unavailableError();
    return { dbPath, jobs };
  } catch (error) {
    if (error instanceof DurableJobsCommandError) throw error;
    // Config parsers, path resolvers, and SQLite can carry paths or input
    // fragments in their native diagnostics. Do not turn the operator CLI
    // into a disclosure endpoint.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      throw databaseMissingError();
    }
    throw unavailableError();
  }
}

function withDurableJobStore<T>(
  name: string | undefined,
  options: DurableJobsCommandOptions,
  action: (store: DurableJobStore) => T,
): T {
  let store: DurableJobStore | undefined;
  try {
    const resolved = resolveDurableJobsDatabase(name, options);
    store = createSqliteDurableJobStore(durableStoreOptions(resolved.dbPath, resolved.jobs));
    return action(store);
  } catch (error) {
    if (error instanceof DurableJobsCommandError) throw error;
    throw operationError();
  } finally {
    try {
      store?.close();
    } catch {
      // The operation's result/error is already the safe public outcome.
    }
  }
}

/** Explicit projection: adding a private field to a store summary cannot leak it here. */
export function durableJobSummaryOutput(summary: DurableJobSummary): Record<string, unknown> {
  return {
    id: summary.id,
    state: summary.state,
    attempt: summary.attempt,
    version: summary.version,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    availableAt: summary.availableAt,
    cancelRequested: summary.cancelRequested,
    ...(summary.incident
      ? {
          incident: {
            id: summary.incident.id,
            version: summary.incident.version,
            reasonCode: summary.incident.reasonCode,
          },
        }
      : {}),
  };
}

export function runDurableJobsList(
  name: string | undefined,
  options: DurableJobsListOptions = {},
): DurableJobSummary[] {
  const state = parseState(options.state);
  const limit = parseBoundedLimit(options.limit, 100);
  return withDurableJobStore(name, options, (store) => store.list({ state, limit }));
}

export function runDurableJobsInspect(
  jobId: string,
  name: string | undefined,
  options: DurableJobsCommandOptions = {},
): DurableJobSummary | null {
  return withDurableJobStore(name, options, (store) => store.getSummary(assertJobId(jobId)));
}

export function runDurableJobsCancel(
  jobId: string,
  name: string | undefined,
  options: DurableJobsMutationOptions,
) {
  const expectedVersion = parsePositiveVersion(options.version);
  return withDurableJobStore(name, options, (store) =>
    store.cancel({ jobId: assertJobId(jobId), expectedVersion, reasonCode: "operator-requested" }),
  );
}

export function runDurableJobsReconcile(
  jobId: string,
  name: string | undefined,
  options: DurableJobsReconcileOptions,
) {
  const expectedVersion = parsePositiveVersion(options.version);
  const disposition = parseDisposition(options.disposition);
  const evidence = parseEvidence(options.evidence);
  return withDurableJobStore(name, options, (store) =>
    store.reconcile({ jobId: assertJobId(jobId), expectedVersion, disposition, evidence }),
  );
}

function requirePruneConfirmation(options: DurableJobsPruneOptions): void {
  if (options.yes !== true) throw inputError();
}

export function runDurableJobsPrune(
  name: string | undefined,
  options: DurableJobsPruneOptions,
): number {
  requirePruneConfirmation(options);
  const before = parseStrictIso(options.before);
  const limit = parseBoundedLimit(options.limit, 1_000);
  return withDurableJobStore(name, options, (store) => store.prune({ before, limit }));
}

export function runDurableJobsPruneAudit(
  name: string | undefined,
  options: DurableJobsPruneOptions,
): number {
  requirePruneConfirmation(options);
  const before = parseStrictIso(options.before);
  const limit = parseBoundedLimit(options.limit, 1_000);
  return withDurableJobStore(name, options, (store) => store.pruneAudit({ before, limit }));
}

function printJson(log: (line: string) => void, value: unknown): void {
  log(JSON.stringify(value));
}

function commandOptions(command: Command): Command {
  return command
    .option("--config <path>", "path to agent.yaml")
    .option("--root <path>", "runtime data root (or RAILWAY_VOLUME_MOUNT_PATH)");
}

function runAction(
  run: () => unknown,
  error: (line: string) => void,
  exit: (code: number) => void,
): void {
  try {
    run();
  } catch (caught) {
    const message =
      caught instanceof DurableJobsCommandError ? caught.message : operationError().message;
    error(`Error: ${message}`);
    exit(1);
  }
}

export function jobsCommand(deps: DurableJobsCommandDeps = {}): Command {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const exit =
    deps.exit ??
    ((code: number) => {
      process.exitCode = code;
    });
  const command = new Command("jobs").description(
    "Inspect and recover the local, single-replica durable jobs store",
  );

  commandOptions(command.command("list [name]").description("List redacted durable job summaries"))
    .option(
      "--state <state>",
      "queued, leased, running, completed, failed, canceled, or outcome_unknown",
    )
    .option("--limit <count>", "maximum summaries (1-100)")
    .action((name: string | undefined, options: DurableJobsListOptions) =>
      runAction(
        () =>
          printJson(log, { jobs: runDurableJobsList(name, options).map(durableJobSummaryOutput) }),
        error,
        exit,
      ),
    );

  commandOptions(
    command.command("inspect <job-id> [name]").description("Inspect one redacted job summary"),
  ).action((jobId: string, name: string | undefined, options: DurableJobsCommandOptions) =>
    runAction(
      () => {
        const job = runDurableJobsInspect(jobId, name, options);
        printJson(log, { job: job ? durableJobSummaryOutput(job) : null });
      },
      error,
      exit,
    ),
  );

  commandOptions(
    command.command("cancel <job-id> [name]").description("Compare-and-set cancel one durable job"),
  )
    .requiredOption("--version <version>", "current job version")
    .action((jobId: string, name: string | undefined, options: DurableJobsMutationOptions) =>
      runAction(
        () => {
          const result = runDurableJobsCancel(jobId, name, options);
          printJson(log, {
            status: result.status,
            job: result.job ? durableJobSummaryOutput(result.job) : null,
          });
        },
        error,
        exit,
      ),
    );

  commandOptions(
    command
      .command("reconcile <job-id> [name]")
      .description("Record an evidence-backed outcome-unknown job reconciliation"),
  )
    .requiredOption("--version <version>", "current job version")
    .requiredOption("--disposition <disposition>", "retry, cancel, or confirm-completed")
    .requiredOption("--evidence <reference>", "non-secret external evidence reference")
    .action((jobId: string, name: string | undefined, options: DurableJobsReconcileOptions) =>
      runAction(
        () => {
          const result = runDurableJobsReconcile(jobId, name, options);
          printJson(log, {
            reconciled: result.reconciled,
            job: result.job ? durableJobSummaryOutput(result.job) : null,
          });
        },
        error,
        exit,
      ),
    );

  commandOptions(
    command.command("prune [name]").description("Permanently prune retained terminal jobs"),
  )
    .option("--before <iso>", "strict UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)")
    .option("--limit <count>", "maximum jobs to prune (1-1000)")
    .option("--yes", "confirm permanent deletion")
    .action((name: string | undefined, options: DurableJobsPruneOptions) =>
      runAction(() => printJson(log, { pruned: runDurableJobsPrune(name, options) }), error, exit),
    );

  commandOptions(
    command
      .command("prune-audit [name]")
      .description("Permanently prune expired reconciliation audit records"),
  )
    .option("--before <iso>", "strict UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)")
    .option("--limit <count>", "maximum audit records to prune (1-1000)")
    .option("--yes", "confirm permanent deletion")
    .action((name: string | undefined, options: DurableJobsPruneOptions) =>
      runAction(
        () => printJson(log, { pruned: runDurableJobsPruneAudit(name, options) }),
        error,
        exit,
      ),
    );

  return command;
}
