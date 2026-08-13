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
  test("requires a display-name restart to resolve an authoritative project config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "restart-empty-"));
    roots.push(cwd);
    await expect(
      runRestart("agent-b", {
        cwd,
        _readPidManifest: () => null,
      }),
    ).rejects.toThrow(/Agent "agent-b" not found.*run this command from inside an agent project/is);
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
      /config path does not match.*Running: agent-b.*Requested config:.*No process was stopped/is,
    );
  });

  test("rejects an identity change at the exact running config path", () => {
    const configB = config(AGENT_B, "agent-b");
    const running = manifest(configB);
    writeFileSync(configB, configYaml(AGENT_A, "agent-a"));
    expect(() => assertRestartTarget(running, configB)).toThrow(
      new RegExp(`${AGENT_B}.*${AGENT_A}.*No process was stopped`, "s"),
    );
  });

  test("admits the exact path and immutable identity", () => {
    const configB = config(AGENT_B, "agent-b");
    expect(assertRestartTarget(manifest(configB), configB)).toBe(resolve(configB));
  });

  test("resolves a named project to its immutable id before reading runtime state", async () => {
    const configB = config(AGENT_B, "agent-b");
    const running = {
      ...manifest(configB),
      mode: "launchd" as const,
      claimNonce: "33333333-3333-4333-8333-333333333333",
      launchGeneration: "44444444-4444-4444-8444-444444444444",
    };
    const events: string[] = [];
    let stopped: string | undefined;
    let started: { name: string | undefined; config: string | undefined } | undefined;

    await runRestart("agent-b", {
      cwd: resolve(configB, ".."),
      _readPidManifest: (identifier) => {
        events.push(`read:${identifier}`);
        expect(identifier).toBe(AGENT_B);
        return running;
      },
      _claimAgentLifecycle: (agentId) => {
        events.push(`claim:${agentId}`);
        return () => events.push(`release:${agentId}`);
      },
      _runStop: async (identifier) => {
        events.push(`stop:${identifier}`);
        stopped = identifier;
      },
      _runStart: async (restartName, options) => {
        events.push(`start:${restartName}`);
        started = { name: restartName, config: options.config };
      },
      _sleep: async () => {},
    });

    expect(stopped).toBe(AGENT_B);
    expect(started).toEqual({ name: "agent-b", config: resolve(configB) });
    expect(events).toEqual([
      `claim:${AGENT_B}`,
      `read:${AGENT_B}`,
      `stop:${AGENT_B}`,
      "start:agent-b",
      `release:${AGENT_B}`,
    ]);
  });

  test("does not adopt an old same-name identity after its project directory is recreated", async () => {
    const replacementConfig = config(AGENT_A, "agent-b");
    const oldRuntime = {
      ...manifest(replacementConfig),
      agentId: AGENT_B,
      name: "agent-b",
    };
    let stopped = false;

    await expect(
      runRestart("agent-b", {
        cwd: resolve(replacementConfig, ".."),
        auggyDir: join(resolve(replacementConfig, ".."), ".auggy-test"),
        _readPidManifest: (identifier) => {
          expect(identifier).toBe(AGENT_A);
          return null;
        },
        _listPidManifests: () => [oldRuntime],
        _claimAgentLifecycle: (agentId) => {
          expect(agentId).toBe(AGENT_A);
          return () => {};
        },
        _runStop: async () => {
          stopped = true;
        },
      }),
    ).rejects.toThrow(
      new RegExp(
        `Target project: ${AGENT_A}.*Running same-name identities:.*${AGENT_B}.*No process was stopped or adopted`,
        "s",
      ),
    );
    expect(stopped).toBe(false);
  });

  test("restarts the exact project even when another running identity shares its name", async () => {
    const configB = config(AGENT_B, "agent-b");
    const exact = manifest(configB);
    const duplicate = { ...manifest(configB), agentId: AGENT_A };
    let listed = false;

    await runRestart("agent-b", {
      cwd: resolve(configB, ".."),
      _readPidManifest: (identifier) => {
        expect(identifier).toBe(AGENT_B);
        return exact;
      },
      _listPidManifests: () => {
        listed = true;
        return [duplicate];
      },
      _claimAgentLifecycle: () => () => {},
      _runStop: async () => {},
      _runDev: async () => {},
      _sleep: async () => {},
    });

    expect(listed).toBe(false);
  });

  test("rejects a command name that disagrees with an explicit config", async () => {
    const configB = config(AGENT_B, "agent-b");
    let read = false;
    await expect(
      runRestart("agent-a", {
        config: configB,
        _readPidManifest: () => {
          read = true;
          return null;
        },
      }),
    ).rejects.toThrow(/Command requested: agent-a.*declares: agent-b.*No process was stopped/s);
    expect(read).toBe(false);
  });

  test("rejects a moved same-id config with current-versus-target guidance", () => {
    const runningConfig = config(AGENT_B, "agent-b");
    const movedConfig = config(AGENT_B, "agent-b");
    expect(() => assertRestartTarget(manifest(runningConfig), movedConfig)).toThrow(
      /Running: agent-b.*Requested config:.*No process was stopped/is,
    );
  });

  test("rejects an explicit config whose id disagrees with an immutable target", async () => {
    const configA = config(AGENT_A, "agent-a");
    let claimed = false;
    await expect(
      runRestart(AGENT_B, {
        config: configA,
        _claimAgentLifecycle: () => {
          claimed = true;
          return () => {};
        },
      }),
    ).rejects.toThrow(
      new RegExp(`Requested immutable ID: ${AGENT_B}.*declares: agent-a \\(${AGENT_A}\\)`, "s"),
    );
    expect(claimed).toBe(false);
  });
});
