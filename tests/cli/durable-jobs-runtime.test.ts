import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfiguredDurableJobsRuntime,
  createDurableJobsRuntimeIfEnabled,
  resolveDurableJobsDatabasePath,
  startAgentWithDurableJobs,
  stopAgentWithDurableJobs,
  type ConfiguredDurableJobsRuntime,
} from "../../src/cli/durable-jobs-runtime";
import type { DurableJobsConfig } from "../../src/cli/types";
import type { DurableJobStore } from "../../src/jobs/types";
import type { AgentHandle } from "../../src/types";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "durable-jobs-runtime-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function jobs(overrides: Partial<DurableJobsConfig> = {}): DurableJobsConfig {
  return {
    enabled: true,
    dbPath: "./data/durable-jobs.sqlite",
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
    claimPollMs: 250,
    turnTimeoutMs: 300_000,
    maxAttempts: 3,
    maxTotalRecords: 100,
    maxQueuedRecords: 10,
    maxPrivateBytes: 64 * 1024,
    terminalRetentionMs: 86_400_000,
    auditRetentionMs: 172_800_000,
    schedules: [],
    ...overrides,
  };
}

describe("durable jobs runtime path boundary", () => {
  test("creates only contained local runtime parents", () => {
    const agentDir = root();
    expect(resolveDurableJobsDatabasePath("./state/jobs.sqlite", agentDir, undefined)).toBe(
      join(realpathSync(agentDir), "state", "jobs.sqlite"),
    );
  });

  test("maps relative deployment state beneath the Railway volume", () => {
    const agentDir = root();
    const volume = join(root(), "data");
    mkdirSync(volume, { recursive: true, mode: 0o700 });
    expect(resolveDurableJobsDatabasePath("./data/jobs.sqlite", agentDir, volume)).toBe(
      join(realpathSync(volume), "data", "jobs.sqlite"),
    );
    expect(resolveDurableJobsDatabasePath(join(volume, "direct.sqlite"), agentDir, volume)).toBe(
      join(realpathSync(volume), "direct.sqlite"),
    );
  });

  test("rejects escapes and existing symlink parents", () => {
    const agentDir = root();
    const outside = root();
    mkdirSync(join(agentDir, "state"));
    symlinkSync(outside, join(agentDir, "state", "redirect"));
    expect(() => resolveDurableJobsDatabasePath("../outside.sqlite", agentDir, undefined)).toThrow(
      /must stay within/i,
    );
    expect(() =>
      resolveDurableJobsDatabasePath(join(outside, "outside.sqlite"), agentDir, undefined),
    ).toThrow(/must stay within/i);
    expect(() =>
      resolveDurableJobsDatabasePath("./state/redirect/jobs.sqlite", agentDir, undefined),
    ).toThrow(/missing or unsafe|symbolic link|symlink/i);
  });
});

describe("durable jobs runtime lifecycle", () => {
  test("omitted settings are a complete runtime no-op", () => {
    let stores = 0;
    const runtime = createDurableJobsRuntimeIfEnabled({
      jobs: undefined,
      agent: {} as Pick<AgentHandle, "inject">,
      agentDir: root(),
      createStore() {
        stores++;
        throw new Error("must not create a store");
      },
    });
    expect(runtime).toBeUndefined();
    expect(stores).toBe(0);
  });

  test("recovers expired leases before polling and passes every bounded option", () => {
    const agentDir = root();
    const events: string[] = [];
    let storeOptions: unknown;
    const store = {
      recoverExpiredLeases() {
        events.push("recover-expired");
        return { requeued: 0, quarantined: 0 };
      },
      close() {
        events.push("close-store");
      },
    } as unknown as DurableJobStore;
    const runtime = createConfiguredDurableJobsRuntime({
      jobs: jobs(),
      agent: {} as Pick<AgentHandle, "inject">,
      agentDir,
      workerId: "worker:test",
      createStore(options) {
        storeOptions = options;
        return store;
      },
      createWorker() {
        return {
          start() {
            events.push("start-worker");
          },
          async stop() {
            events.push("stop-worker");
          },
        };
      },
    });

    runtime.start();
    runtime.close();
    expect(events).toEqual(["recover-expired", "start-worker", "close-store"]);
    expect(storeOptions).toEqual({
      dbPath: join(realpathSync(agentDir), "data", "durable-jobs.sqlite"),
      maxTotalRecords: 100,
      maxQueuedRecords: 10,
      maxPrivateBytes: 65_536,
      terminalRetentionMs: 86_400_000,
      auditRetentionMs: 172_800_000,
    });
  });

  test("agent startup completes before worker admission and failure closes durable state", async () => {
    const events: string[] = [];
    const durable: ConfiguredDurableJobsRuntime = {
      databasePath: "/private/jobs.sqlite",
      start() {
        events.push("start-worker");
      },
      async stop() {
        events.push("stop-worker");
      },
      close() {
        events.push("close-store");
      },
    };
    await startAgentWithDurableJobs(
      {
        async start() {
          events.push("start-agent");
        },
        async stop() {
          events.push("stop-agent");
        },
      },
      durable,
    );
    expect(events).toEqual(["start-agent", "start-worker"]);

    events.splice(0);
    await expect(
      startAgentWithDurableJobs(
        {
          async start() {
            events.push("start-agent");
            throw new Error("agent startup failure");
          },
          async stop() {
            events.push("stop-agent");
          },
        },
        durable,
      ),
    ).rejects.toThrow("agent startup failure");
    expect(events).toEqual(["start-agent", "stop-worker", "stop-agent", "close-store"]);
  });

  test("preserves the startup error when durable-state close also fails", async () => {
    const failures: string[] = [];
    const startupError = new Error("agent startup failure");
    const durable: ConfiguredDurableJobsRuntime = {
      databasePath: "/private/jobs.sqlite",
      start() {},
      async stop() {},
      close() {
        throw new Error("private close failure");
      },
    };

    await expect(
      startAgentWithDurableJobs(
        {
          async start() {
            throw startupError;
          },
          async stop() {},
        },
        durable,
        (code) => failures.push(code),
      ),
    ).rejects.toBe(startupError);
    expect(failures).toEqual(["close-failed"]);
  });

  test("shutdown always stops worker before agent and closes state", async () => {
    const events: string[] = [];
    const durable: ConfiguredDurableJobsRuntime = {
      databasePath: "/private/jobs.sqlite",
      start() {},
      async stop() {
        events.push("stop-worker");
      },
      close() {
        events.push("close-store");
      },
    };
    await stopAgentWithDurableJobs(
      {
        async start() {},
        async stop() {
          events.push("stop-agent");
        },
      },
      durable,
    );
    expect(events).toEqual(["stop-worker", "stop-agent", "close-store"]);
  });
});
