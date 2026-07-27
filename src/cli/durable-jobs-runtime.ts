import { randomUUID } from "node:crypto";
import type { AgentHandle } from "../types";
import { createDurableJobRuntime, type DurableJobRuntimeOptions } from "../jobs/runtime";
import { createSqliteDurableJobStore } from "../jobs/sqlite-store";
import type {
  DurableJobScheduleDefinition,
  DurableJobStore,
  SqliteDurableJobStoreOptions,
} from "../jobs/types";
import type { DurableJobsConfig } from "./types";
import { resolveOwnedStatePath } from "./owned-state-path";
import { resolveRuntimeStatePath } from "./runtime-state-inventory";

/**
 * Resolve the durable-jobs database through both the pure deployment mapping
 * and the descriptor-walked owned-state boundary. Runtime startup is the only
 * caller allowed to create missing parent directories.
 */
export function resolveDurableJobsDatabasePath(
  configuredPath: string,
  agentDir: string,
  runtimeDataRoot: string | undefined,
): string {
  const ownedRoot = runtimeDataRoot ?? agentDir;
  const deploymentPath = resolveRuntimeStatePath(
    configuredPath,
    agentDir,
    runtimeDataRoot,
    "durable jobs database",
  );
  return resolveOwnedStatePath(deploymentPath, agentDir, ownedRoot, "durable jobs database", {
    createParents: true,
  });
}

type DurableJobWorker = Pick<ReturnType<typeof createDurableJobRuntime>, "start" | "stop">;

export interface ConfiguredDurableJobsRuntime {
  readonly databasePath: string;
  /** Recover only expired work, then admit polling. Must run after agent.start(). */
  start(): void;
  /** Stop admission and cooperative work before the owning agent stops. */
  stop(): Promise<void>;
  /** Close SQLite before the runtime releases its PID and volume lease. */
  close(): void;
}

export interface CreateConfiguredDurableJobsRuntimeOptions {
  jobs: DurableJobsConfig;
  agent: Pick<AgentHandle, "inject">;
  agentDir: string;
  runtimeDataRoot?: string;
  /** Test seam; production creates a fresh server-minted worker identity. */
  workerId?: string;
  createStore?: (options: SqliteDurableJobStoreOptions) => DurableJobStore;
  createWorker?: (options: DurableJobRuntimeOptions) => DurableJobWorker;
  /** Receives fixed operational classifications only, never caught error text. */
  onOperationalError?: (code: "poll-failed" | "settlement-failed" | "schedule-tick-failed") => void;
  /** Deterministic scheduler seams; production uses the process timers. */
  setScheduleTimeout?: (callback: () => void, ms: number) => unknown;
  clearScheduleTimeout?: (handle: unknown) => void;
}

/** Map trusted parsed configuration to the write-only persisted schedule contract. */
export function durableScheduleDefinitions(
  jobs: DurableJobsConfig,
): DurableJobScheduleDefinition[] {
  return jobs.schedules.map((schedule) => {
    const threadId = schedule.threadId ?? `durable-schedule:${schedule.id}`;
    return {
      id: schedule.id,
      cron: schedule.cron,
      enabled: schedule.enabled,
      binding: {
        version: 1,
        kind: "configured-agent-turn",
        scheduleId: schedule.id,
        threadId,
        timeoutMs: schedule.timeoutMs,
        maxAttempts: schedule.maxAttempts,
      },
      payload: {
        version: 1,
        value: {
          version: 1,
          kind: "agent-turn",
          threadId,
          prompt: schedule.prompt,
          timeoutMs: schedule.timeoutMs,
          maxAttempts: schedule.maxAttempts,
        },
      },
    };
  });
}

/** Explicit absence means no database, worker, route, or model authority is created. */
export function createDurableJobsRuntimeIfEnabled(
  options: Omit<CreateConfiguredDurableJobsRuntimeOptions, "jobs"> & {
    jobs: DurableJobsConfig | undefined;
  },
): ConfiguredDurableJobsRuntime | undefined {
  if (!options.jobs) return undefined;
  return createConfiguredDurableJobsRuntime({
    ...options,
    jobs: options.jobs,
  });
}

type ManagedAgent = Pick<AgentHandle, "start" | "stop">;

/**
 * Start ordering is a security boundary: a job worker must never invoke
 * `inject` while the agent's transports, scheduler, and augments are only
 * partially initialized. Every startup failure tears down both sides.
 */
export async function startAgentWithDurableJobs(
  agent: ManagedAgent,
  durableJobs: ConfiguredDurableJobsRuntime | undefined,
  onCleanupFailure: (code: "stop-failed" | "agent-stop-failed" | "close-failed") => void = () => {},
): Promise<void> {
  try {
    await agent.start();
    durableJobs?.start();
  } catch (error) {
    try {
      await durableJobs?.stop();
    } catch {
      onCleanupFailure("stop-failed");
    }
    try {
      await agent.stop();
    } catch {
      onCleanupFailure("agent-stop-failed");
    }
    try {
      durableJobs?.close();
    } catch {
      onCleanupFailure("close-failed");
    }
    throw error;
  }
}

/** Stop worker admission before agent teardown, then close the private store. */
export async function stopAgentWithDurableJobs(
  agent: ManagedAgent,
  durableJobs: ConfiguredDurableJobsRuntime | undefined,
  onFailure: (code: "stop-failed" | "agent-stop-failed" | "close-failed") => void = () => {},
): Promise<void> {
  try {
    await durableJobs?.stop();
  } catch {
    onFailure("stop-failed");
  }
  try {
    await agent.stop();
  } catch {
    onFailure("agent-stop-failed");
  }
  try {
    durableJobs?.close();
  } catch {
    onFailure("close-failed");
  }
}

/**
 * Construct the runtime-owned job facility. This is deliberately not exposed
 * to augments, HTTP transports, or model tools: it only accepts trusted parsed
 * configuration and an already-defined agent handle.
 */
export function createConfiguredDurableJobsRuntime(
  options: CreateConfiguredDurableJobsRuntimeOptions,
): ConfiguredDurableJobsRuntime {
  const databasePath = resolveDurableJobsDatabasePath(
    options.jobs.dbPath,
    options.agentDir,
    options.runtimeDataRoot,
  );
  const createStore = options.createStore ?? createSqliteDurableJobStore;
  const store = createStore({
    dbPath: databasePath,
    maxTotalRecords: options.jobs.maxTotalRecords,
    maxQueuedRecords: options.jobs.maxQueuedRecords,
    maxPrivateBytes: options.jobs.maxPrivateBytes,
    // Payload/schedule maxAttempts controls automatic retry. The store keeps
    // its separate hardened history ceiling so an operator can reconcile a
    // job after its policy is exhausted without silently truncating history.
    terminalRetentionMs: options.jobs.terminalRetentionMs,
    auditRetentionMs: options.jobs.auditRetentionMs,
  });
  const createWorker = options.createWorker ?? createDurableJobRuntime;
  let closed = false;
  let started = false;
  try {
    // Reconcile declarations even when the configured list is empty so a
    // removed schedule becomes durably disabled before the agent can admit
    // background work.
    store.syncSchedules(durableScheduleDefinitions(options.jobs));
    const worker = createWorker({
      agent: options.agent,
      store,
      workerId: options.workerId ?? `durable-job-worker:${randomUUID()}`,
      leaseMs: options.jobs.leaseDurationMs,
      heartbeatIntervalMs: options.jobs.heartbeatIntervalMs,
      pollIntervalMs: options.jobs.claimPollMs,
      defaultTimeoutMs: options.jobs.turnTimeoutMs,
      onOperationalError: (code) => options.onOperationalError?.(code),
    });
    const setScheduleTimeout =
      options.setScheduleTimeout ??
      ((callback: () => void, ms: number): unknown => globalThis.setTimeout(callback, ms));
    const clearScheduleTimeout =
      options.clearScheduleTimeout ??
      ((handle: unknown): void => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    const schedulePollMs = Math.max(1_000, options.jobs.claimPollMs);
    let scheduleTimer: unknown;
    let scheduleTimerSet = false;
    const clearScheduleTimer = () => {
      if (!scheduleTimerSet) return;
      clearScheduleTimeout(scheduleTimer);
      scheduleTimer = undefined;
      scheduleTimerSet = false;
    };
    const scheduleNextTick = () => {
      if (!started || closed || scheduleTimerSet) return;
      scheduleTimer = setScheduleTimeout(() => {
        scheduleTimer = undefined;
        scheduleTimerSet = false;
        if (!started || closed) return;
        try {
          store.materializeDueSchedules();
        } catch {
          try {
            options.onOperationalError?.("schedule-tick-failed");
          } catch {
            // Observability callbacks cannot stop scheduling or disclose the
            // caught database/configuration error through another path.
          }
        } finally {
          scheduleNextTick();
        }
      }, schedulePollMs);
      scheduleTimerSet = true;
    };
    return Object.freeze({
      databasePath,
      start(): void {
        if (started) return;
        // Leases are fenced and this transition is expired-only. Running work
        // is quarantined rather than replayed before polling can start.
        store.recoverExpiredLeases();
        store.materializeDueSchedules();
        worker.start();
        started = true;
        scheduleNextTick();
      },
      async stop(): Promise<void> {
        started = false;
        clearScheduleTimer();
        await worker.stop();
      },
      close(): void {
        if (closed) return;
        closed = true;
        started = false;
        clearScheduleTimer();
        store.close();
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }
}
