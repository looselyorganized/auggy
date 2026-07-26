import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { PidManifest } from "../../src/cli/types";

// We test the core logic by importing the functions and operating on
// temp directories. Production uses ~/.auggy/, but the same code paths
// support an explicit auggyDir override for tests and embedded callers.
import {
  activateLaunchdGeneration,
  closeLaunchdGeneration,
  writePidManifest,
  claimRuntimePidManifest,
  formatAgentAlreadyRunningMessage,
  releaseRuntimePidManifest,
  readLivePidManifest,
  readPidManifest,
  removePidManifest,
  listPidManifests,
  tryClaimName,
  inspectRuntimeProcess,
  isProcessAlive,
  getProcessIdentity,
} from "../../src/cli/pid-registry";

let auggyDir: string;
const PROCESS_IDENTITY = "test-process:current";

function modernRegistryOptions() {
  return { auggyDir, processIdentityForPid: () => PROCESS_IDENTITY };
}

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "pid-registry-test-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("isProcessAlive", () => {
  test("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for a non-existent PID", () => {
    // PID 99999999 is extremely unlikely to exist.
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe("getProcessIdentity", () => {
  test("is stable across caller timezones and never resolves ps through inherited PATH", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "pid-identity-shim-"));
    const marker = join(shimDir, "invoked");
    const shim = join(shimDir, "ps");
    writeFileSync(shim, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(shim, 0o700);
    const oldPath = process.env.PATH;
    const oldTz = process.env.TZ;
    const oldSecret = process.env.AUGGY_IDENTITY_SENTINEL;
    try {
      process.env.PATH = shimDir;
      process.env.AUGGY_IDENTITY_SENTINEL = "must-not-reach-child";
      process.env.TZ = "America/Vancouver";
      const first = getProcessIdentity(process.pid);
      process.env.TZ = "UTC";
      const second = getProcessIdentity(process.pid);
      expect(second).toBe(first);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
      if (oldSecret === undefined) delete process.env.AUGGY_IDENTITY_SENTINEL;
      else process.env.AUGGY_IDENTITY_SENTINEL = oldSecret;
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

describe("PID manifest lifecycle", () => {
  const testName = `test-agent-${Date.now()}`;

  afterEach(() => {
    removePidManifest(testName, { auggyDir });
  });

  test("write + read round-trip", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: testName,
      port: 8080,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    writePidManifest(manifest, { auggyDir });
    const read = readPidManifest(testName, { auggyDir });
    expect(read).not.toBeNull();
    expect(read!.pid).toBe(process.pid);
    expect(read!.name).toBe(testName);
    expect(read!.port).toBe(8080);
    expect(read!.mode).toBe("dev");
  });

  test("read returns null for non-existent manifest", () => {
    expect(readPidManifest("nonexistent-agent-xyz", { auggyDir })).toBeNull();
  });

  test("write throws on duplicate (atomic wx flag)", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: testName,
      port: null,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    writePidManifest(manifest, { auggyDir });
    expect(() => writePidManifest(manifest, { auggyDir })).toThrow();
  });

  test("remove cleans up the manifest", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: testName,
      port: null,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    writePidManifest(manifest, { auggyDir });
    expect(readPidManifest(testName, { auggyDir })).not.toBeNull();
    removePidManifest(testName, { auggyDir });
    expect(readPidManifest(testName, { auggyDir })).toBeNull();
  });

  test("remove is idempotent (doesn't throw if already gone)", () => {
    expect(() => removePidManifest("nonexistent-xyz", { auggyDir })).not.toThrow();
  });
});

describe("runtime PID manifest policy", () => {
  test("Railway boot ignores a stale same-PID manifest without deleting it", () => {
    const name = "railway-stale";
    const manifest = {
      pid: process.pid,
      name,
      port: 8080,
      configPath: "/app/agent.yaml",
      agentDir: "/app",
      startedAt: new Date(0).toISOString(),
      mode: "dev" as const,
    };
    writePidManifest(manifest, { auggyDir });

    const claimed = claimRuntimePidManifest(manifest, {
      auggyDir,
      internalMode: "railway",
    });
    expect(claimed).toBe(false);
    releaseRuntimePidManifest(manifest, claimed, { auggyDir });
    expect(readPidManifest(name, { auggyDir })).toEqual(manifest);
  });

  test("local and launchd boots retain exclusive PID claims", () => {
    const manifest = {
      pid: process.pid,
      name: "exclusive-runtime",
      port: 8080,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp",
      startedAt: new Date().toISOString(),
      mode: "launchd" as const,
    };
    expect(claimRuntimePidManifest(manifest, { auggyDir, internalMode: "launchd" })).toBe(true);
    expect(() =>
      claimRuntimePidManifest(manifest, { auggyDir, internalMode: "launchd" }),
    ).toThrow();
    releaseRuntimePidManifest(manifest, true, { auggyDir });
    expect(readPidManifest(manifest.name, { auggyDir })).toBeNull();
  });

  test("local boots replace a stale manifest and continue", () => {
    const name = "stale-local-runtime";
    writePidManifest(
      {
        pid: 99999999,
        name,
        port: 8083,
        configPath: "/tmp/old-agent.yaml",
        agentDir: "/tmp/old-agent",
        startedAt: new Date(0).toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    const replacement: PidManifest = {
      pid: process.pid,
      name,
      port: 9090,
      configPath: "/tmp/new-agent.yaml",
      agentDir: "/tmp/new-agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    expect(claimRuntimePidManifest(replacement, { auggyDir })).toBe(true);
    expect(readPidManifest(name, { auggyDir })).toEqual(replacement);
  });

  test("distinct immutable identities may use the same display name without aliasing", () => {
    const first: PidManifest = {
      pid: process.pid,
      name: "worker",
      agentId: "aug1_11111111-1111-4111-8111-111111111111",
      claimNonce: "11111111-1111-4111-8111-111111111111",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: ["agent-id:aug1_11111111-1111-4111-8111-111111111111"],
      resourceClaimStore: "sqlite-v1" as const,
      port: 8101,
      configPath: "/tmp/worker-a/agent.yaml",
      agentDir: "/tmp/worker-a",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };
    const second: PidManifest = {
      ...first,
      agentId: "aug1_22222222-2222-4222-8222-222222222222",
      claimNonce: "22222222-2222-4222-8222-222222222222",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: ["agent-id:aug1_22222222-2222-4222-8222-222222222222"],
      resourceClaimStore: "sqlite-v1" as const,
      port: 8102,
      configPath: "/tmp/worker-b/agent.yaml",
      agentDir: "/tmp/worker-b",
    };

    expect(claimRuntimePidManifest(first, modernRegistryOptions())).toBe(true);
    expect(claimRuntimePidManifest(second, modernRegistryOptions())).toBe(true);
    expect(readPidManifest(first.agentId!, { auggyDir })?.configPath).toBe(first.configPath);
    expect(readPidManifest(second.agentId!, { auggyDir })?.configPath).toBe(second.configPath);
    expect(() => readPidManifest("worker", { auggyDir })).toThrow(/ambiguous/i);

    releaseRuntimePidManifest(first, true, { auggyDir });
    releaseRuntimePidManifest(second, true, { auggyDir });
  });

  test("rejects overlap with any live pre-upgrade name-keyed runtime", () => {
    writePidManifest(
      {
        pid: process.pid,
        name: "legacy-orders",
        port: null,
        configPath: "/tmp/legacy-orders/agent.yaml",
        agentDir: "/tmp/legacy-orders",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );
    const modern: PidManifest = {
      pid: process.pid,
      name: "legacy-worker",
      agentId: "aug1_55555555-5555-4555-8555-555555555555",
      claimNonce: "55555555-5555-4555-8555-555555555555",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: ["agent-id:aug1_55555555-5555-4555-8555-555555555555", "telegram-bot:654321"],
      resourceClaimStore: "sqlite-v1" as const,
      port: null,
      configPath: "/tmp/legacy-worker/agent.yaml",
      agentDir: "/tmp/legacy-worker",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    expect(() => claimRuntimePidManifest(modern, { auggyDir })).toThrow(
      /pre-upgrade runtime.*running/i,
    );
    expect(readPidManifest(modern.agentId!, { auggyDir })).toBeNull();
  });

  test("resource claims reject a second agent before it starts using the resource", () => {
    const first: PidManifest = {
      pid: process.pid,
      name: "orders",
      agentId: "aug1_33333333-3333-4333-8333-333333333333",
      claimNonce: "33333333-3333-4333-8333-333333333333",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [
        "agent-id:aug1_33333333-3333-4333-8333-333333333333",
        "telegram-bot:123456",
        "tcp-port:8080",
      ],
      resourceClaimStore: "sqlite-v1" as const,
      port: 8080,
      configPath: "/tmp/orders/agent.yaml",
      agentDir: "/tmp/orders",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };
    const second: PidManifest = {
      ...first,
      name: "concierge",
      agentId: "aug1_44444444-4444-4444-8444-444444444444",
      claimNonce: "44444444-4444-4444-8444-444444444444",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [
        "agent-id:aug1_44444444-4444-4444-8444-444444444444",
        "telegram-bot:123456",
        "tcp-port:8080",
      ],
      configPath: "/tmp/concierge/agent.yaml",
      agentDir: "/tmp/concierge",
    };

    expect(claimRuntimePidManifest(first, modernRegistryOptions())).toBe(true);
    expect(() => claimRuntimePidManifest(second, modernRegistryOptions())).toThrow(
      /resource.*claimed/i,
    );
    expect(readPidManifest(second.agentId!, { auggyDir })).toBeNull();

    releaseRuntimePidManifest(first, true, { auggyDir });
  });

  test("transactionally replaces a stale claim without exposing a lock-file crash state", () => {
    const first: PidManifest = {
      pid: 99999999,
      name: "crashed",
      agentId: "aug1_66666666-6666-4666-8666-666666666666",
      claimNonce: "66666666-6666-4666-8666-666666666666",
      processIdentity: "test-process:crashed",
      resourceClaims: ["agent-id:aug1_66666666-6666-4666-8666-666666666666", "telegram-bot:777777"],
      resourceClaimStore: "sqlite-v1" as const,
      port: null,
      configPath: "/tmp/crashed/agent.yaml",
      agentDir: "/tmp/crashed",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };
    const successor: PidManifest = {
      ...first,
      pid: process.pid,
      name: "successor",
      agentId: "aug1_77777777-7777-4777-8777-777777777777",
      claimNonce: "77777777-7777-4777-8777-777777777777",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: ["agent-id:aug1_77777777-7777-4777-8777-777777777777", "telegram-bot:777777"],
      configPath: "/tmp/successor/agent.yaml",
      agentDir: "/tmp/successor",
    };
    const contender: PidManifest = {
      ...successor,
      name: "contender",
      agentId: "aug1_88888888-8888-4888-8888-888888888888",
      claimNonce: "88888888-8888-4888-8888-888888888888",
      resourceClaims: ["agent-id:aug1_88888888-8888-4888-8888-888888888888", "telegram-bot:777777"],
      configPath: "/tmp/contender/agent.yaml",
      agentDir: "/tmp/contender",
    };

    expect(claimRuntimePidManifest(first, modernRegistryOptions())).toBe(true);
    expect(claimRuntimePidManifest(successor, modernRegistryOptions())).toBe(true);
    expect(() => claimRuntimePidManifest(contender, modernRegistryOptions())).toThrow(
      /resource.*claimed/i,
    );
    expect(
      readdirSync(join(auggyDir, "runtime-claims"), { withFileTypes: true }).some((entry) =>
        entry.name.endsWith(".lock"),
      ),
    ).toBe(false);
    releaseRuntimePidManifest(successor, true, { auggyDir });
  });

  test("SQLite rolls back an interrupted claim transaction before restart", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: "rollback-successor",
      agentId: "aug1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      claimNonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [
        "agent-id:aug1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "telegram-bot:rollback",
      ],
      resourceClaimStore: "sqlite-v1",
      port: null,
      configPath: "/tmp/rollback-successor/agent.yaml",
      agentDir: "/tmp/rollback-successor",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    expect(claimRuntimePidManifest(manifest, modernRegistryOptions())).toBe(true);
    releaseRuntimePidManifest(manifest, true, modernRegistryOptions());

    const raw = new Database(join(auggyDir, "runtime-claims.sqlite"));
    raw.run("BEGIN IMMEDIATE");
    raw.run(
      `INSERT INTO runtime_resource_claims
         (claim, agent_id, agent_name, pid, claim_nonce, process_identity)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "telegram-bot:rollback",
        "aug1_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "interrupted",
        process.pid,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        PROCESS_IDENTITY,
      ],
    );
    raw.close();

    const restarted = {
      ...manifest,
      claimNonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    expect(claimRuntimePidManifest(restarted, modernRegistryOptions())).toBe(true);
    releaseRuntimePidManifest(restarted, true, modernRegistryOptions());
  });

  test("a stale shutdown cannot delete a replacement manifest or its claims", () => {
    const original: PidManifest = {
      pid: process.pid,
      name: "restart-generation",
      agentId: "aug1_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      claimNonce: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [
        "agent-id:aug1_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "telegram-bot:generation",
      ],
      resourceClaimStore: "sqlite-v1",
      port: null,
      configPath: "/tmp/restart-generation/agent.yaml",
      agentDir: "/tmp/restart-generation",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };
    const replacement: PidManifest = {
      ...original,
      claimNonce: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      startedAt: new Date(Date.now() + 1).toISOString(),
    };
    const contender: PidManifest = {
      ...replacement,
      name: "third-process",
      agentId: "aug1_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      claimNonce: "33333333-cccc-4ccc-8ccc-cccccccccccc",
      resourceClaims: [
        "agent-id:aug1_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "telegram-bot:generation",
      ],
      configPath: "/tmp/third-process/agent.yaml",
      agentDir: "/tmp/third-process",
    };

    expect(claimRuntimePidManifest(original, modernRegistryOptions())).toBe(true);
    releaseRuntimePidManifest(original, true, modernRegistryOptions());
    expect(claimRuntimePidManifest(replacement, modernRegistryOptions())).toBe(true);

    releaseRuntimePidManifest(original, true, modernRegistryOptions());

    expect(readPidManifest(replacement.agentId!, { auggyDir })?.claimNonce).toBe(
      replacement.claimNonce,
    );
    expect(() => claimRuntimePidManifest(contender, modernRegistryOptions())).toThrow(
      /resource.*claimed/i,
    );
    releaseRuntimePidManifest(replacement, true, modernRegistryOptions());
  });

  test("distinguishes a reused PID from the recorded runtime incarnation", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: "incarnation-a",
      agentId: "aug1_99999999-9999-4999-8999-999999999999",
      claimNonce: "99999999-9999-4999-8999-999999999999",
      processIdentity: "test-process:first",
      resourceClaims: ["agent-id:aug1_99999999-9999-4999-8999-999999999999"],
      resourceClaimStore: "sqlite-v1" as const,
      port: null,
      configPath: "/tmp/incarnation-a/agent.yaml",
      agentDir: "/tmp/incarnation-a",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };
    expect(
      inspectRuntimeProcess(manifest, {
        processIdentityForPid: () => "test-process:second",
      }),
    ).toBe("reused");

    writePidManifest(manifest, { auggyDir });
    expect(
      readLivePidManifest(manifest.agentId!, {
        auggyDir,
        processIdentityForPid: () => "test-process:second",
      }),
    ).toBeNull();
    expect(readPidManifest(manifest.agentId!, { auggyDir })).toBeNull();
  });

  test("admits only the active launchd generation across publication races", () => {
    const agentId = "aug1_77777777-7777-4777-8777-777777777777";
    const generationOne = "11111111-1111-4111-8111-111111111111";
    const generationTwo = "22222222-2222-4222-8222-222222222222";
    const base: PidManifest = {
      pid: process.pid,
      name: "generation-fenced",
      agentId,
      claimNonce: "77777777-7777-4777-8777-777777777777",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [`agent-id:${agentId}`],
      resourceClaimStore: "sqlite-v1",
      launchGeneration: generationOne,
      port: null,
      configPath: "/tmp/generation-fenced/agent.yaml",
      agentDir: "/tmp/generation-fenced",
      startedAt: new Date().toISOString(),
      mode: "launchd",
    };

    expect(() => claimRuntimePidManifest(base, modernRegistryOptions())).toThrow(
      /generation.*closed or superseded/i,
    );
    activateLaunchdGeneration(agentId, generationOne, { auggyDir });
    expect(() =>
      claimRuntimePidManifest(base, {
        ...modernRegistryOptions(),
        __testHooks: {
          afterManifestPublished() {
            closeLaunchdGeneration(agentId, generationOne, { auggyDir });
          },
        },
      }),
    ).toThrow(/generation.*closed or superseded/i);
    expect(readPidManifest(agentId, { auggyDir })).toBeNull();

    activateLaunchdGeneration(agentId, generationTwo, { auggyDir });
    expect(() =>
      claimRuntimePidManifest(
        {
          ...base,
          mode: "dev",
          launchGeneration: undefined,
          claimNonce: "99999999-9999-4999-8999-999999999999",
        },
        modernRegistryOptions(),
      ),
    ).toThrow(/foreground.*active launchd installation/i);
    expect(() => claimRuntimePidManifest(base, modernRegistryOptions())).toThrow(
      /generation.*closed or superseded/i,
    );
    const successor = {
      ...base,
      claimNonce: "88888888-8888-4888-8888-888888888888",
      launchGeneration: generationTwo,
    };
    expect(claimRuntimePidManifest(successor, modernRegistryOptions())).toBe(true);
    releaseRuntimePidManifest(successor, true, { auggyDir });
  });

  test("migrates the exact version-one claim database before generation activation", () => {
    const path = join(auggyDir, "runtime-claims.sqlite");
    const raw = new Database(path);
    raw.run(`CREATE TABLE runtime_resource_claims (
      claim            TEXT PRIMARY KEY,
      agent_id         TEXT NOT NULL,
      agent_name       TEXT NOT NULL,
      pid              INTEGER NOT NULL,
      claim_nonce      TEXT NOT NULL,
      process_identity TEXT NOT NULL
    )`);
    raw.run("PRAGMA application_id = 1096106828");
    raw.run("PRAGMA user_version = 1");
    raw.close();

    activateLaunchdGeneration(
      "aug1_99999999-9999-4999-8999-999999999999",
      "99999999-9999-4999-8999-999999999999",
      { auggyDir },
    );
    const migrated = new Database(path, { readonly: true });
    expect(
      migrated.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
    ).toEqual([{ name: "launchd_generation_state" }, { name: "runtime_resource_claims" }]);
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    migrated.close();
  });
});

describe("running agent diagnostics", () => {
  test("includes the existing PID, port, and console URL", () => {
    const manifest: PidManifest = {
      pid: 12345,
      name: "order-support",
      port: 8083,
      configPath: "/tmp/order-support/agent.yaml",
      agentDir: "/tmp/order-support",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    expect(formatAgentAlreadyRunningMessage(manifest.name, manifest)).toBe(
      'Agent "order-support" is already running (PID 12345, port 8083).\n' +
        "Console: http://localhost:8083/console\n" +
        "Stop it with: auggy stop order-support",
    );
  });

  test("omits port details when the existing runtime has no web transport", () => {
    const manifest: PidManifest = {
      pid: 12345,
      name: "worker",
      port: null,
      configPath: "/tmp/worker/agent.yaml",
      agentDir: "/tmp/worker",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    const message = formatAgentAlreadyRunningMessage(manifest.name, manifest);
    expect(message).toContain('Agent "worker" is already running (PID 12345).');
    expect(message).not.toContain("port");
    expect(message).not.toContain("Console:");
  });

  test("readLivePidManifest preserves corrupt records and fails closed", () => {
    const name = "corrupt-runtime";
    writeFileSync(join(auggyDir, `${name}.json`), "not json");

    expect(() => readLivePidManifest(name, { auggyDir })).toThrow(/Invalid Auggy runtime manifest/);
    expect(existsSync(join(auggyDir, `${name}.json`))).toBe(true);
  });
});

describe("listPidManifests", () => {
  const name1 = `list-test-1-${Date.now()}`;
  const name2 = `list-test-2-${Date.now()}`;

  afterEach(() => {
    removePidManifest(name1, { auggyDir });
    removePidManifest(name2, { auggyDir });
  });

  test("lists manifests with alive processes", () => {
    writePidManifest(
      {
        pid: process.pid,
        name: name1,
        port: null,
        configPath: "/tmp/a.yaml",
        agentDir: "/tmp/a",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    const list = listPidManifests({ auggyDir });
    const found = list.find((m) => m.name === name1);
    expect(found).toBeDefined();
  });
});

describe("tryClaimName", () => {
  const testName = `claim-test-${Date.now()}`;

  afterEach(() => {
    removePidManifest(testName, { auggyDir });
  });

  test("returns true when no manifest exists", () => {
    expect(tryClaimName(testName, { auggyDir })).toBe(true);
  });

  test("returns false when agent is alive and recent", () => {
    writePidManifest(
      {
        pid: process.pid,
        name: testName,
        port: null,
        configPath: "/tmp/a.yaml",
        agentDir: "/tmp/a",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    expect(tryClaimName(testName, { auggyDir })).toBe(false);
  });

  test("returns true and cleans up when process is dead", () => {
    writePidManifest(
      {
        pid: 99999999, // dead PID
        name: testName,
        port: null,
        configPath: "/tmp/a.yaml",
        agentDir: "/tmp/a",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    expect(tryClaimName(testName, { auggyDir })).toBe(true);
    expect(readPidManifest(testName, { auggyDir })).toBeNull();
  });
});
