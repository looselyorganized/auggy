import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createAgentMailInboundLedger } from "../../src/augments/agentMail/inbound-ledger";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
} from "../../src/augments/agentMail/provider";

const CHILD = resolve("tests/fixtures/agent-mail-sqlite-child.ts");
const roots: string[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();

afterEach(async () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await withTimeout(child.exited, "killed child cleanup");
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-sqlite-process-"));
  roots.push(root);
  return join(root, "ledger.sqlite");
}

function envelope(messageId: string) {
  return agentMailRestEnvelope(
    normalizeAgentMailMessage({
      inbox_id: "support@agentmail.to",
      thread_id: "thread_parent",
      message_id: messageId,
      labels: ["received"],
      timestamp: "2026-07-16T12:00:00.000Z",
      from: "sender@example.com",
      to: ["support@agentmail.to"],
      subject: "Parent process",
      text: "durability probe",
      size: 16,
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function spawnChild(mode: string, dbPath: string, worker?: string) {
  const child = Bun.spawn([process.execPath, CHILD, mode, dbPath, ...(worker ? [worker] : [])], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  let buffered = "";
  async function line(): Promise<Record<string, unknown>> {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const value = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return JSON.parse(value) as Record<string, unknown>;
      }
      const chunk = await withTimeout(reader.read(), `${mode} output`);
      if (chunk.done) {
        throw new Error(`${mode} exited before handshake: ${await stderr}`);
      }
      buffered += new TextDecoder().decode(chunk.value, { stream: true });
    }
  }
  return { child, line, stderr };
}

async function expectCleanExit(
  process: ReturnType<typeof spawnChild>,
  label: string,
): Promise<void> {
  const code = await withTimeout(process.child.exited, `${label} exit`);
  expect(code, await process.stderr).toBe(0);
  children.delete(process.child);
}

function release(child: ReturnType<typeof Bun.spawn>): void {
  const stdin = child.stdin;
  if (!stdin || typeof stdin === "number") throw new Error("child stdin is not writable");
  stdin.write("GO\n");
  stdin.end();
}

describe("AgentMail SQLite process durability", () => {
  test("serializes simultaneous claims across independent processes", async () => {
    const dbPath = tempDb();
    const seed = createAgentMailInboundLedger({ dbPath, now: () => 1_000 });
    seed.enqueue(envelope("one_claim"));
    seed.close();

    const first = spawnChild("claim", dbPath, "worker_a");
    const second = spawnChild("claim", dbPath, "worker_b");
    expect(await first.line()).toEqual({ event: "READY" });
    expect(await second.line()).toEqual({ event: "READY" });
    release(first.child);
    release(second.child);
    const results = await Promise.all([first.line(), second.line()]);
    await Promise.all([
      expectCleanExit(first, "first claimant"),
      expectCleanExit(second, "second claimant"),
    ]);

    expect(results.filter((result) => result.messageId === "one_claim")).toHaveLength(1);
    expect(results.filter((result) => result.messageId === null)).toHaveLength(1);
    const verify = createAgentMailInboundLedger({ dbPath, now: () => 1_000 });
    expect(verify.get("support@agentmail.to", "one_claim")).toMatchObject({
      state: "processing",
      attemptCount: 1,
    });
    verify.close();
  });

  test("deduplicates simultaneous enqueue across independent processes", async () => {
    const dbPath = tempDb();
    const first = spawnChild("enqueue", dbPath, "writer_a");
    const second = spawnChild("enqueue", dbPath, "writer_b");
    expect(await first.line()).toEqual({ event: "READY" });
    expect(await second.line()).toEqual({ event: "READY" });
    release(first.child);
    release(second.child);
    const results = await Promise.all([first.line(), second.line()]);
    await Promise.all([
      expectCleanExit(first, "first enqueuer"),
      expectCleanExit(second, "second enqueuer"),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "enqueued"]);
    const verify = createAgentMailInboundLedger({ dbPath });
    expect(verify.counts()).toEqual({ pending: 1, processing: 0, processed: 0, discarded: 0 });
    verify.close();
  });

  test("bounds cross-process writer contention and recovers after rollback", async () => {
    const dbPath = tempDb();
    const seed = createAgentMailInboundLedger({ dbPath });
    seed.close();
    const holder = spawnChild("hold-write", dbPath);
    expect(await holder.line()).toEqual({ event: "LOCKED" });

    const contender = spawnChild("try-write", dbPath);
    expect(await contender.line()).toMatchObject({ event: "RESULT", result: "SQLITE_BUSY" });
    await expectCleanExit(contender, "writer contender");
    release(holder.child);
    expect(await holder.line()).toEqual({ event: "RELEASED" });
    await expectCleanExit(holder, "writer holder");

    const recovered = createAgentMailInboundLedger({ dbPath });
    recovered.enqueue(envelope("after_writer_rollback"));
    expect(recovered.counts().pending).toBe(1);
    recovered.close();
  });

  test("recovers committed WAL state and lease semantics after SIGKILL", async () => {
    if (process.platform === "win32") return;
    const dbPath = tempDb();
    const crashed = spawnChild("crash-committed", dbPath);
    expect(await crashed.line()).toEqual({ event: "COMMITTED", attemptCount: 1 });
    crashed.child.kill("SIGKILL");
    expect(await withTimeout(crashed.child.exited, "committed crash exit")).not.toBe(0);
    children.delete(crashed.child);
    for (const suffix of ["-wal", "-shm"]) {
      const stat = statSync(`${dbPath}${suffix}`);
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    let now = 1_000;
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => now,
      leaseToken: () => "recovered_token",
    });
    expect(ledger.claimNext({ workerId: "recovery", leaseMs: 100 })).toBeNull();
    now = 1_100;
    const recovered = ledger.claimNext({ workerId: "recovery", leaseMs: 100 });
    expect(recovered).toMatchObject({ attemptCount: 2, leaseToken: "recovered_token" });
    expect(ledger.complete(recovered!)).toBe(true);
    ledger.close();
  });

  test("rolls back an in-flight transaction after SIGKILL and remains writable", async () => {
    if (process.platform === "win32") return;
    const dbPath = tempDb();
    const crashed = spawnChild("crash-uncommitted", dbPath);
    const handshake = await crashed.line();
    expect(handshake.event).toBe("UNCOMMITTED");
    expect(Number(handshake.uncommittedWalSize)).toBeGreaterThan(Number(handshake.baselineWalSize));
    crashed.child.kill("SIGKILL");
    expect(await withTimeout(crashed.child.exited, "uncommitted crash exit")).not.toBe(0);
    children.delete(crashed.child);

    const ledger = createAgentMailInboundLedger({ dbPath, now: () => 1_000 });
    expect(ledger.get("support@agentmail.to", "rollback_after_kill")).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
    ledger.enqueue(envelope("write_after_recovery"));
    expect(ledger.counts().pending).toBe(2);
    const probe = new Database(dbPath, { readwrite: true });
    expect(
      probe
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM agentmail_inbound_messages WHERE message_id LIKE 'uncommitted_%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(probe.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get()).toEqual({
      quick_check: "ok",
    });
    probe.close();
    ledger.close();
  });
});
