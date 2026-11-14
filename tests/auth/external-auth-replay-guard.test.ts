import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeDataVolume } from "../../src/cli/runtime-volume";
import { pinDirectory } from "../../src/lib/anchored-files";
import type { AdmittedRuntimeVolumeLease } from "../../src/runtime-data-contracts";
import {
  EXTERNAL_AUTH_REPLAY_GUARD_FILE as FINAL,
  EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE as PENDING,
  EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS as MAX_TIME,
  type ExternalAuthReplayGuardV1,
  type ManagedExternalAuthReplay,
} from "../../src/auth/external-auth-replay-contracts";
import {
  ensureRestoredExternalAuthReplayGuard,
  inspectExternalAuthReplayGuard,
  type ExternalAuthReplayTestHooks,
  type ReplayGuardWriteStage,
} from "../../src/auth/external-auth-replay-guard";
import { createManagedExternalAuthReplay } from "../../src/auth/external-auth-replay-store";

const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";
const epoch = { restoreId: "9fb78f48-61f3-41ca-a38f-0be277897f52", restoredAtMs: 1_000_000 };
const roots: string[] = [];
const stores: ManagedExternalAuthReplay[] = [];
const leases: AdmittedRuntimeVolumeLease[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "auggy-replay-guard-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
function pinned<T>(path: string, fn: (fd: number) => T): T {
  const pin = pinDirectory(path, "test root");
  try {
    return fn(pin.fd);
  } finally {
    closeSync(pin.fd);
  }
}
function restored(path: string, now: number, hooks: ExternalAuthReplayTestHooks = {}): void {
  pinned(path, (fd) =>
    ensureRestoredExternalAuthReplayGuard(
      fd,
      { agentId, restore: epoch },
      { now: () => now, ...hooks },
    ),
  );
}
function read(path: string): ExternalAuthReplayGuardV1 {
  return pinned(path, (fd) => inspectExternalAuthReplayGuard(fd, agentId))!;
}
function raw(path: string): ExternalAuthReplayGuardV1 {
  return JSON.parse(readFileSync(join(path, FINAL), "utf8"));
}
function put(path: string, leaf: string, value: unknown): void {
  writeFileSync(join(path, leaf), typeof value === "string" ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}
function lease(path: string): AdmittedRuntimeVolumeLease {
  const owned = prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: path }, agentId);
  leases.push(owned);
  return owned;
}
function store(
  owned: AdmittedRuntimeVolumeLease,
  hooks: ExternalAuthReplayTestHooks,
  name = "replay.db",
  names = [name],
  ttl = 60,
): ManagedExternalAuthReplay {
  const replay = createManagedExternalAuthReplay(
    {
      admission: owned.runtimeDataAdmission,
      dbPath: join(owned.runtimeDataRoot, name),
      managedDbPaths: names.map((name) => join(owned.runtimeDataRoot, name)),
      maxTtlSeconds: ttl,
    },
    hooks,
  );
  stores.push(replay);
  return replay;
}
afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const owned of leases.splice(0)) owned.release();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("offline replay guard restore and inspection", () => {
  test("writes a private permanent epoch and preserves it across resume", () => {
    const path = root();
    restored(path, 1_010_000);
    expect(read(path)).toEqual({
      version: 1,
      agentId,
      latestRestore: epoch,
      highWaterMs: 1_010_000,
    });
    restored(path, 1_020_000);
    expect(read(path).latestRestore).toEqual(epoch);
    expect(read(path).highWaterMs).toBe(1_020_000);
    expect(readdirSync(path)).toEqual([FINAL]);
  });

  test.each([
    "opened",
    "written",
    "file-synced",
    "renamed",
    "directory-synced",
  ] as ReplayGuardWriteStage[])(
    "COPYING resumes an interrupted %s write using only the exact pending leaf",
    (stage) => {
      const path = root();
      expect(() =>
        restored(path, 1_010_000, {
          onGuardWriteStage(current) {
            if (current === stage) throw new Error("crash");
          },
        }),
      ).toThrow("crash");
      expect(readdirSync(path).every((leaf) => leaf === FINAL || leaf === PENDING)).toBe(true);
      restored(path, 1_011_000);
      expect(read(path)).toEqual({
        version: 1,
        agentId,
        latestRestore: epoch,
        highWaterMs: 1_011_000,
      });
      expect(existsSync(join(path, PENDING))).toBe(false);
    },
  );

  test("a higher valid pending watermark survives another repair interruption", () => {
    const path = root();
    restored(path, 1_010_000);
    put(path, PENDING, { ...raw(path), highWaterMs: 1_020_000 });
    expect(() =>
      restored(path, 1_030_000, {
        onGuardWriteStage(stage) {
          if (stage === "opened") throw new Error("again");
        },
      }),
    ).toThrow("again");
    expect(raw(path).highWaterMs).toBe(1_020_000);
    expect(() => restored(path, 1_019_999)).toThrow("clock");
    restored(path, 1_030_001);
    expect(read(path).highWaterMs).toBe(1_030_001);
    expect(read(path).latestRestore).toEqual(epoch);
  });

  test("backup inspection is read-only and always refuses pending state", () => {
    const path = root();
    expect(
      pinned(path, (fd) => inspectExternalAuthReplayGuard(fd, agentId, { allowMissing: true })),
    ).toBeNull();
    expect(() => read(path)).toThrow();
    restored(path, 1_010_000);
    const before = readFileSync(join(path, FINAL));
    expect(read(path).highWaterMs).toBe(1_010_000);
    expect(readFileSync(join(path, FINAL))).toEqual(before);
    put(path, PENDING, raw(path));
    expect(() => read(path)).toThrow();
    expect(() =>
      pinned(path, (fd) => inspectExternalAuthReplayGuard(fd, agentId, { allowMissing: true })),
    ).toThrow();
    expect(readFileSync(join(path, FINAL))).toEqual(before);
    expect(existsSync(join(path, PENDING))).toBe(true);
  });

  test.each(["mode", "symlink", "hardlink", "oversize", "directory"])(
    "COPYING refuses unsafe pending %s metadata",
    (fault) => {
      const path = root();
      restored(path, 1_010_000);
      const before = readFileSync(join(path, FINAL));
      if (fault === "directory") mkdirSync(join(path, PENDING));
      else if (fault === "symlink") symlinkSync(join(path, FINAL), join(path, PENDING));
      else if (fault === "hardlink") linkSync(join(path, FINAL), join(path, PENDING));
      else put(path, PENDING, fault === "oversize" ? "x".repeat(4097) : "partial");
      if (fault === "mode") chmodSync(join(path, PENDING), 0o644);
      expect(() => restored(path, 1_020_000)).toThrow();
      expect(readFileSync(join(path, FINAL))).toEqual(before);
      expect(existsSync(join(path, PENDING))).toBe(true);
    },
  );

  test.each(["malformed", "version", "unknown", "agent", "epoch", "watermark"])(
    "does not reset incompatible final guard %s",
    (fault) => {
      const path = root();
      restored(path, 1_010_000);
      let value: unknown = raw(path);
      if (fault === "malformed") value = "{";
      else if (fault === "version") value = { ...raw(path), version: 2 };
      else if (fault === "unknown") value = { ...raw(path), extra: true };
      else if (fault === "agent")
        value = { ...raw(path), agentId: "aug1_00000000-0000-0000-0000-000000000001" };
      else if (fault === "epoch")
        value = { ...raw(path), latestRestore: { ...epoch, restoredAtMs: epoch.restoredAtMs + 1 } };
      else value = { ...raw(path), highWaterMs: epoch.restoredAtMs - 1 };
      put(path, FINAL, value);
      const before = readFileSync(join(path, FINAL));
      expect(() => restored(path, 1_020_000)).toThrow();
      expect(readFileSync(join(path, FINAL))).toEqual(before);
      expect(existsSync(join(path, PENDING))).toBe(false);
    },
  );

  test("COPYING refuses a valid pending image from another epoch", () => {
    const path = root();
    restored(path, 1_010_000);
    put(path, PENDING, {
      ...raw(path),
      latestRestore: { ...epoch, restoredAtMs: epoch.restoredAtMs + 1 },
    });
    expect(() => restored(path, 1_020_000)).toThrow();
    expect(raw(path).highWaterMs).toBe(1_010_000);
  });
});

describe("live shared guard", () => {
  test.each(["missing", "mode", "symlink", "hardlink", "oversize", "unknown"])(
    "refuses live final guard %s corruption",
    async (fault) => {
      const path = root();
      const owned = lease(path);
      const replay = store(owned, { now: () => 2_000_000 });
      if (fault === "missing") rmSync(join(path, FINAL));
      else if (fault === "mode") chmodSync(join(path, FINAL), 0o644);
      else if (fault === "hardlink") linkSync(join(path, FINAL), join(path, "alias"));
      else if (fault === "symlink") {
        put(path, "other", raw(path));
        rmSync(join(path, FINAL));
        symlinkSync(join(path, "other"), join(path, FINAL));
      } else if (fault === "oversize") put(path, FINAL, " ".repeat(4097));
      else put(path, FINAL, { ...raw(path), unknown: true });
      expect(await replay.checkAvailability(60)).toEqual({
        status: "unavailable",
        reason: "guard",
      });
      expect(existsSync(join(path, PENDING))).toBe(false);
    },
  );

  test("an invalid or throwing clock produces sanitized unavailability without guard mutation", async () => {
    const path = root();
    const owned = lease(path);
    let mode = "valid";
    const replay = store(owned, {
      now() {
        if (mode === "throw") throw new Error("private clock implementation");
        return mode === "invalid" ? NaN : 2_000_000;
      },
    });
    const before = readFileSync(join(path, FINAL));
    for (mode of ["invalid", "throw"]) {
      expect(await replay.checkAvailability(60)).toEqual({
        status: "unavailable",
        reason: "clock",
      });
      expect(readFileSync(join(path, FINAL))).toEqual(before);
    }
  });

  test("an active coordinator rejects valid-shaped rollback or restore-epoch removal", async () => {
    const path = root();
    restored(path, 1_000_000);
    const owned = lease(path);
    let time = 1_010_000;
    const replay = store(owned, { now: () => time });
    expect((await replay.checkAvailability(60)).status).toBe("held");
    const before = raw(path);
    put(path, FINAL, { ...before, highWaterMs: 1_009_999 });
    time++;
    expect(await replay.checkAvailability(60)).toEqual({ status: "unavailable", reason: "guard" });
    expect(raw(path).highWaterMs).toBe(1_009_999);
    put(path, FINAL, { ...before, latestRestore: null });
    expect(await replay.checkAvailability(60)).toEqual({ status: "unavailable", reason: "guard" });
    expect(raw(path).latestRestore).toBeNull();
  });

  test("all configured DBs prevent first-use reset even when the opening DB is new", () => {
    const path = root();
    const owned = lease(path);
    const now = () => 2_000_000;
    const first = store(owned, { now }, "old.db", ["old.db", "new.db"]);
    first.close();
    rmSync(join(path, FINAL));
    expect(() => store(owned, { now }, "new.db", ["old.db", "new.db"])).toThrow("guard");
    expect(existsSync(join(path, FINAL))).toBe(false);
    expect(existsSync(join(path, "new.db"))).toBe(false);
  });

  test("ordinary startup refuses partial pending; valid matching images retain maximum watermark", async () => {
    const path = root();
    const owned = lease(path);
    let time = 2_000_000;
    const now = () => time;
    store(owned, { now }).close();
    put(path, PENDING, "{");
    expect(() => store(owned, { now })).toThrow("guard");
    expect(readFileSync(join(path, PENDING), "utf8")).toBe("{");
    put(path, PENDING, { ...raw(path), highWaterMs: 2_010_000 });
    time = 2_009_999;
    expect(() => store(owned, { now })).toThrow("clock");
    expect(raw(path).highWaterMs).toBe(2_010_000);
    time = 2_010_000;
    const recovered = store(owned, { now });
    expect(await recovered.checkAvailability(60)).toEqual({ status: "ready", nowMs: time });
    expect(read(path).highWaterMs).toBe(time);
  });

  test("an older pending image cannot lower the committed watermark", () => {
    const path = root();
    const owned = lease(path);
    const now = () => 2_010_000;
    store(owned, { now }).close();
    put(path, PENDING, { ...raw(path), highWaterMs: 2_000_000 });
    store(owned, { now });
    expect(read(path).highWaterMs).toBe(2_010_000);
  });

  test("hold expiry is exact, survives restart, and increasing current TTL reopens it", async () => {
    const path = root();
    restored(path, 1_000_000);
    const owned = lease(path);
    let time = 1_089_999;
    const now = () => time;
    let replay = store(owned, { now });
    expect(await replay.checkAvailability(60)).toEqual({ status: "held", retryAfterSeconds: 1 });
    replay.close();
    replay = store(owned, { now });
    time = 1_090_000;
    expect(await replay.checkAvailability(60)).toEqual({ status: "ready", nowMs: time });
    expect(await replay.checkAvailability(120)).toEqual({ status: "held", retryAfterSeconds: 60 });
    expect(await replay.checkAvailability(100_000)).toEqual({
      status: "held",
      retryAfterSeconds: 3600,
    });
    expect(read(path).latestRestore).toEqual(epoch);
  });

  test("clock is sampled inside shared serialization, across handles and DBs", async () => {
    const path = root();
    const owned = lease(path);
    let time = 2_000_000;
    const samples: number[] = [];
    const now = () => {
      samples.push(time);
      return time;
    };
    let advance = false;
    const onGuardWriteStage = (stage: ReplayGuardWriteStage) => {
      if (advance && stage === "directory-synced") time++;
    };
    const hooks = { now, onGuardWriteStage };
    const one = store(owned, hooks, "one.db", ["one.db", "two.db"]);
    const two = store(owned, hooks, "two.db", ["one.db", "two.db"]);
    samples.length = 0;
    advance = true;
    expect(
      await Promise.all([
        one.checkAvailability(60),
        two.checkAvailability(60),
        one.checkAvailability(60),
      ]),
    ).toEqual([
      { status: "ready", nowMs: 2_000_000 },
      { status: "ready", nowMs: 2_000_001 },
      { status: "ready", nowMs: 2_000_002 },
    ]);
    expect(samples).toEqual([2_000_000, 2_000_001, 2_000_002]);
    expect(read(path).highWaterMs).toBe(2_000_002);
    one.close();
    expect((await two.checkAvailability(60)).status).toBe("ready");
  });

  test("inconsistent clocks or inventory cannot replace a live coordinator", () => {
    const path = root();
    const owned = lease(path);
    const now = () => 2_000_000;
    store(owned, { now });
    expect(() => store(owned, { now: () => 2_000_000 })).toThrow("dependencies disagree");
    expect(() => store(owned, { now }, "other.db", ["replay.db", "other.db"])).toThrow(
      "dependencies disagree",
    );
    expect(existsSync(join(path, "other.db"))).toBe(false);
  });

  test("true rollback fails closed without resetting state, then recovers at the watermark", async () => {
    const path = root();
    const owned = lease(path);
    let time = 2_000_000;
    const replay = store(owned, { now: () => time });
    time++;
    expect((await replay.checkAvailability(60)).status).toBe("ready");
    time--;
    expect(await replay.checkAvailability(60)).toEqual({ status: "unavailable", reason: "clock" });
    expect(read(path).highWaterMs).toBe(2_000_001);
    time++;
    expect((await replay.checkAvailability(60)).status).toBe("ready");
  });

  test("failed watermark persistence authorizes nothing and ordinary partial recovery fails closed", async () => {
    const path = root();
    const owned = lease(path);
    let broken = false;
    const replay = store(owned, {
      now: () => 2_000_000,
      onGuardWriteStage(stage) {
        if (broken && stage === "opened") throw new Error("private filesystem detail");
      },
    });
    broken = true;
    expect(await replay.checkAvailability(60)).toEqual({ status: "unavailable", reason: "guard" });
    expect(readFileSync(join(path, PENDING)).byteLength).toBe(0);
    broken = false;
    expect(await replay.checkAvailability(60)).toEqual({ status: "unavailable", reason: "guard" });
    expect(raw(path).highWaterMs).toBe(2_000_000);
  });

  test("timestamp and retry arithmetic remain bounded", async () => {
    const path = root();
    const owned = lease(path);
    const replay = store(owned, { now: () => MAX_TIME - 31_000 }, "replay.db", ["replay.db"], 1);
    expect((await replay.checkAvailability(1)).status).toBe("ready");
    expect(await replay.checkAvailability(2)).toEqual({ status: "unavailable", reason: "clock" });
    for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(await replay.checkAvailability(invalid)).toEqual({
        status: "unavailable",
        reason: "clock",
      });
    }
  });
});
