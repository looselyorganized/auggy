import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRestartTarget, runRestart } from "../../src/cli/commands/restart";
import { activateLaunchdGeneration } from "../../src/cli/pid-registry";
import type { PidManifest } from "../../src/cli/types";

const roots: string[] = [];
const AGENT_A = "aug1_11111111-1111-4111-8111-111111111111";
const AGENT_B = "aug1_22222222-2222-4222-8222-222222222222";

function configYaml(id: string, name: string): string {
  return `id: ${id}\nname: ${name}\nengine:\n  provider: anthropic\n  model: claude-sonnet-4-6\naugments:\n  - type: webFetch\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(id: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), "restart-target-"));
  roots.push(root);
  const path = join(root, "agent.yaml");
  writeFileSync(path, configYaml(id, name));
  return path;
}

function manifest(configPath: string): PidManifest {
  return {
    pid: process.pid,
    name: "agent-b",
    agentId: AGENT_B,
    claimNonce: "22222222-2222-4222-8222-222222222222",
    processIdentity: "test-process:agent-b",
    resourceClaims: [],
    resourceClaimStore: "sqlite-v1",
    port: null,
    configPath,
    agentDir: resolve(configPath, ".."),
    startedAt: new Date().toISOString(),
    mode: "dev",
  };
}

describe("restart target validation", () => {
  test("rejects disabled coordination before stopping the running generation", async () => {
    const configPath = config(AGENT_B, "agent-b");
    writeFileSync(
      configPath,
      `${configYaml(AGENT_B, "agent-b")}settings:\n  coordination:\n    mode: postgres\n    namespace: 22222222-2222-4222-8222-222222222222\n    fleetCapacity:\n      maxConcurrent: 4\n      maxQueued: 100\n      maxQueuedPerThread: 20\n    retention:\n      terminalRequestRetentionMs: 604800000\n      maxTerminalRequests: 10000\n      eventRetentionMs: 2592000000\n      maxEvents: 50000\n    result:\n      maxReplayBytes: 65536\n    turnState:\n      history:\n        maxSnapshotBytes: 65536\n        maxMessages: 100\n        maxThreads: 1000\n      maxCostMarkersPerTurn: 32\n      outbox:\n        maxIntentsPerTurn: 32\n        maxIntentBytes: 65536\n        maxPendingIntents: 1000\n`,
    );
    const running = manifest(configPath);
    let stopped = false;

    await expect(
      runRestart(AGENT_B, {
        lifecycleOwned: true,
        _readPidManifest: () => running,
        _runStop: async () => {
          stopped = true;
        },
      }),
    ).rejects.toThrow(/runtime-not-enabled/);
    expect(stopped).toBe(false);
  });

  test("fails closed when a display name has no authoritative runtime identity", async () => {
    await expect(
      runRestart("agent-b", {
        _readPidManifest: () => null,
      }),
    ).rejects.toThrow(/no runtime manifest.*immutable aug1_/i);
  });

  test("claims an immutable-id lifecycle before checking unpublished state", async () => {
    let reads = 0;
    await expect(
      runRestart(AGENT_B, {
        _readPidManifest: () => {
          reads++;
          return null;
        },
        _claimAgentLifecycle: () => {
          throw new Error("lifecycle resource is claimed by concurrent start");
        },
      }),
    ).rejects.toThrow(/claimed by concurrent start/i);
    expect(reads).toBe(0);
  });

  test("fails closed on persisted launchd generation state without a manifest", async () => {
    const auggyDir = mkdtempSync(join(tmpdir(), "restart-generation-"));
    roots.push(auggyDir);
    const processIdentityForPid = () => "test-process:restart-generation";
    activateLaunchdGeneration(AGENT_B, "44444444-4444-4444-8444-444444444444", {
      auggyDir,
      processIdentityForPid,
    });

    await expect(runRestart(AGENT_B, { auggyDir, processIdentityForPid })).rejects.toThrow(
      /persisted launchd generation.*auggy stop/i,
    );
  });

  test("rejects another agent's config path before restart side effects", () => {
    const configB = config(AGENT_B, "agent-b");
    const configA = config(AGENT_A, "agent-a");
    expect(() => assertRestartTarget(manifest(configB), configA)).toThrow(
      /config path does not match/i,
    );
  });

  test("rejects an identity change at the exact running config path", () => {
    const configB = config(AGENT_B, "agent-b");
    const running = manifest(configB);
    writeFileSync(configB, configYaml(AGENT_A, "agent-a"));
    expect(() => assertRestartTarget(running, configB)).toThrow(/identity does not match/i);
  });

  test("admits the exact path and immutable identity", () => {
    const configB = config(AGENT_B, "agent-b");
    expect(assertRestartTarget(manifest(configB), configB)).toBe(resolve(configB));
  });

  test("adopts the current generation after acquiring the lifecycle lease", async () => {
    const configA = config(AGENT_B, "agent-a");
    const configB = config(AGENT_B, "agent-b");
    const stale = { ...manifest(configA), name: "agent-a" };
    const replacement = {
      ...manifest(configB),
      name: "agent-b",
      mode: "launchd" as const,
      claimNonce: "33333333-3333-4333-8333-333333333333",
      launchGeneration: "44444444-4444-4444-8444-444444444444",
    };
    let reads = 0;
    let stopped: string | undefined;
    let started: { name: string | undefined; config: string | undefined } | undefined;

    await runRestart("agent-a", {
      _readPidManifest: () => (reads++ === 0 ? stale : replacement),
      _claimAgentLifecycle: () => () => {},
      _runStop: async (identifier) => {
        stopped = identifier;
      },
      _runStart: async (restartName, options) => {
        started = { name: restartName, config: options.config };
      },
      _sleep: async () => {},
    });

    expect(stopped).toBe(AGENT_B);
    expect(started).toEqual({ name: "agent-b", config: resolve(configB) });
  });
});
