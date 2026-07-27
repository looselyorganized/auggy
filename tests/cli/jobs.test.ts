import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { Database } from "bun:sqlite";
import { createSqliteDurableJobStore } from "../../src/jobs/sqlite-store";
import {
  DurableJobsCommandError,
  jobsCommand,
  resolveDurableJobsDatabase,
  runDurableJobsCancel,
  runDurableJobsInspect,
  runDurableJobsList,
  runDurableJobsPrune,
} from "../../src/cli/commands/jobs";

const SENTINEL = "operator-secret-never-print";
let fixture: { dir: string; root: string; config: string; db: string };

function configSource(dbPath = "./data/durable-jobs.sqlite"): string {
  return `id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c
name: jobs-test
engine:
  provider: anthropic
  model: claude-sonnet-4-6
augments:
  - name: identity
    type: fileMemory
    options:
      label: self
      source: ./identity.md
      mutable: false
      origin: operator
      priority: required
      placement: system
      eviction: never
settings:
  jobs:
    enabled: true
    dbPath: ${JSON.stringify(dbPath)}
`;
}

function submitFixtureJob() {
  const store = createSqliteDurableJobStore({ dbPath: fixture.db });
  try {
    return store.submit({
      idempotencyKey: "operator-cli-job",
      binding: { peer: "trusted-operator", private: SENTINEL },
      payload: { version: 1, value: { prompt: SENTINEL } },
    }).job;
  } finally {
    store.close();
  }
}

function invoke(args: string[]): { out: string[]; err: string[]; exits: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const program = new Command();
  program.exitOverride();
  program.addCommand(
    jobsCommand({
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      exit: (code) => exits.push(code),
    }),
  );
  program.parse(["bun", "auggy", "jobs", ...args], { from: "node" });
  return { out, err, exits };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "auggy-jobs-cli-"));
  const root = join(dir, "volume");
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "identity.md"), "# operator test");
  const config = join(dir, "agent.yaml");
  writeFileSync(config, configSource());
  fixture = { dir, root, config, db: join(root, "data", "durable-jobs.sqlite") };
});

afterEach(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

describe("auggy jobs", () => {
  test("maps runtime root, reads only redacted summaries, and remains live with a second SQLite handle", () => {
    const submitted = submitFixtureJob();
    const secondHandle = createSqliteDurableJobStore({ dbPath: fixture.db });
    try {
      expect(
        resolveDurableJobsDatabase(undefined, { config: fixture.config, root: fixture.root })
          .dbPath,
      ).toBe(realpathSync.native(fixture.db));
      const listed = runDurableJobsList(undefined, { config: fixture.config, root: fixture.root });
      expect(listed).toHaveLength(1);
      const listedJob = listed[0];
      if (!listedJob) throw new Error("expected fixture job");
      expect(
        runDurableJobsInspect(submitted.id, undefined, {
          config: fixture.config,
          root: fixture.root,
        }),
      ).toEqual(listedJob);

      const cancelled = runDurableJobsCancel(submitted.id, undefined, {
        config: fixture.config,
        root: fixture.root,
        version: submitted.version,
      });
      expect(cancelled.status).toBe("canceled");
      expect(secondHandle.getSummary(submitted.id)?.state).toBe("canceled");

      const result = invoke(["list", "--config", fixture.config, "--root", fixture.root]);
      expect(result.exits).toEqual([]);
      expect(result.err).toEqual([]);
      expect(result.out).toHaveLength(1);
      expect(result.out[0]).toContain(submitted.id);
      expect(result.out.join("\n")).not.toContain(SENTINEL);
      expect(result.out.join("\n")).not.toContain("payload");
      expect(result.out.join("\n")).not.toContain("result");
    } finally {
      secondHandle.close();
    }
  });

  test("uses compare-and-set versions and never exposes evidence or private store data in errors", () => {
    const submitted = submitFixtureJob();
    const first = invoke([
      "cancel",
      submitted.id,
      "--version",
      String(submitted.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(first.out[0]).toContain("canceled");

    const stale = invoke([
      "cancel",
      submitted.id,
      "--version",
      String(submitted.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(stale.out[0]).toContain("version_conflict");
    expect(stale.exits).toEqual([1]);

    const unsafeEvidence = invoke([
      "reconcile",
      submitted.id,
      "--version",
      "1",
      "--disposition",
      "retry",
      "--evidence",
      `${SENTINEL}$`,
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(unsafeEvidence.exits).toEqual([1]);
    expect(unsafeEvidence.out.join("\n")).not.toContain(SENTINEL);
    expect(unsafeEvidence.err.join("\n")).not.toContain(SENTINEL);
    expect(unsafeEvidence.err).toEqual(["Error: durable jobs command input is invalid"]);
  });

  test("retries only definite failures and controls schedules without exposing private definitions", () => {
    const store = createSqliteDurableJobStore({ dbPath: fixture.db });
    const failedJob = store.submit({
      idempotencyKey: "definite-failure",
      binding: { private: SENTINEL },
      payload: { version: 1, value: { prompt: SENTINEL } },
    }).job;
    const failedLease = store.claim({ workerId: "worker", leaseMs: 60_000 })!;
    store.markExecutionStarted({ jobId: failedLease.job.id, token: failedLease.token });
    const failed = store.failDefinite({
      jobId: failedJob.id,
      token: failedLease.token,
      errorCode: "execution-failed",
    });
    const unknownJob = store.submit({
      idempotencyKey: "ambiguous-failure",
      binding: { private: SENTINEL },
      payload: { version: 1, value: { prompt: SENTINEL } },
    }).job;
    const unknownLease = store.claim({ workerId: "worker", leaseMs: 60_000 })!;
    store.markExecutionStarted({ jobId: unknownJob.id, token: unknownLease.token });
    const unknown = store.markOutcomeUnknown({
      jobId: unknownJob.id,
      token: unknownLease.token,
      reasonCode: "execution-outcome-unknown",
    });
    const schedule = store.syncSchedules([
      {
        id: "daily_review",
        cron: "0 9 * * *",
        binding: { private: SENTINEL },
        payload: { version: 1, value: { prompt: SENTINEL } },
      },
    ])[0]!;
    store.close();

    const retried = invoke([
      "retry",
      failedJob.id,
      "--version",
      String(failed.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(retried.exits).toEqual([]);
    expect(retried.out[0]).toContain('"retried":true');
    const refusedUnknown = invoke([
      "retry",
      unknownJob.id,
      "--version",
      String(unknown.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(refusedUnknown.out[0]).toContain('"retried":false');
    expect(refusedUnknown.exits).toEqual([1]);

    const listed = invoke([
      "schedules",
      "list",
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(listed.out[0]).toContain("daily_review");
    expect(listed.out.join("\n")).not.toContain(SENTINEL);
    expect(listed.out.join("\n")).not.toContain("payload");
    const paused = invoke([
      "schedules",
      "pause",
      schedule.id,
      "--version",
      String(schedule.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(paused.out[0]).toContain('"paused":true');
    const pausedOutput = JSON.parse(paused.out[0]!) as { schedule: { version: number } };
    const staleResume = invoke([
      "schedules",
      "resume",
      schedule.id,
      "--version",
      String(schedule.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(staleResume.out[0]).toContain('"resumed":false');
    expect(staleResume.exits).toEqual([1]);
    const resumed = invoke([
      "schedules",
      "resume",
      schedule.id,
      "--version",
      String(pausedOutput.schedule.version),
      "--config",
      fixture.config,
      "--root",
      fixture.root,
    ]);
    expect(resumed.out[0]).toContain('"resumed":true');
    expect(
      [...retried.out, ...refusedUnknown.out, ...listed.out, ...paused.out, ...resumed.out].join(
        "\n",
      ),
    ).not.toContain(SENTINEL);
  });

  test("requires strict bounded input and explicit confirmation for destructive pruning", () => {
    submitFixtureJob();
    expect(() =>
      runDurableJobsList(undefined, {
        config: fixture.config,
        root: fixture.root,
        state: "RUNNING",
      }),
    ).toThrow(DurableJobsCommandError);
    expect(() =>
      runDurableJobsList(undefined, {
        config: fixture.config,
        root: fixture.root,
        limit: "1e2",
      }),
    ).toThrow(DurableJobsCommandError);
    expect(() =>
      runDurableJobsInspect("bad/id", undefined, { config: fixture.config, root: fixture.root }),
    ).toThrow(DurableJobsCommandError);
    expect(() =>
      runDurableJobsPrune(undefined, {
        config: fixture.config,
        root: fixture.root,
        yes: false,
      }),
    ).toThrow(DurableJobsCommandError);
    expect(() =>
      runDurableJobsPrune(undefined, {
        config: fixture.config,
        root: fixture.root,
        yes: true,
        before: "2026-07-26T00:00:00Z",
      }),
    ).toThrow(DurableJobsCommandError);
  });

  test("refuses missing leaves and symlink-parent escapes instead of creating or following them", () => {
    expect(() =>
      runDurableJobsList(undefined, { config: fixture.config, root: fixture.root }),
    ).toThrow("durable jobs database is not available");

    writeFileSync(fixture.db, "");
    expect(() =>
      runDurableJobsList(undefined, { config: fixture.config, root: fixture.root }),
    ).toThrow("durable jobs state is unavailable or unsafe");
    rmSync(fixture.db);

    const outside = join(fixture.dir, "outside");
    mkdirSync(outside, { recursive: true });
    rmSync(join(fixture.root, "data"), { recursive: true });
    symlinkSync(outside, join(fixture.root, "data"));
    expect(lstatSync(join(fixture.root, "data")).isSymbolicLink()).toBe(true);
    expect(() =>
      resolveDurableJobsDatabase(undefined, { config: fixture.config, root: fixture.root }),
    ).toThrow("durable jobs state is unavailable or unsafe");
  });

  test("does not disclose missing database paths or config values through the Commander boundary", () => {
    writeFileSync(fixture.config, configSource(`./${SENTINEL}/jobs.sqlite`));
    const result = invoke(["list", "--config", fixture.config, "--root", fixture.root]);
    expect(result.exits).toEqual([1]);
    expect(result.out.join("\n")).not.toContain(SENTINEL);
    expect(result.err.join("\n")).not.toContain(SENTINEL);
    expect(result.err).toEqual(["Error: durable jobs database is not available"]);
  });

  test("refuses to migrate an exact older database from an operator command", () => {
    submitFixtureJob();
    const database = new Database(fixture.db);
    database.run("DROP TABLE durable_job_schedule_occurrences");
    database.run("DROP TABLE durable_job_schedules");
    database.run("PRAGMA user_version = 1");
    database.close();

    const result = invoke(["list", "--config", fixture.config, "--root", fixture.root]);
    expect(result.exits).toEqual([1]);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual(["Error: durable jobs runtime migration is required"]);
    const unchanged = new Database(fixture.db, { readonly: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(
      unchanged.query("SELECT name FROM sqlite_schema WHERE name = 'durable_job_schedules'").get(),
    ).toBeNull();
    unchanged.close();
  });
});
