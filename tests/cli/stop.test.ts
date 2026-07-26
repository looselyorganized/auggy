import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "../../src/cli/commands/stop";
import {
  claimRuntimePidManifest,
  readPidManifest,
  removePidManifest,
} from "../../src/cli/pid-registry";
import type { PidManifest } from "../../src/cli/types";

const PROCESS_IDENTITY = "test-process:stop-owner";
let auggyDir: string;

function registryOptions() {
  return { auggyDir, processIdentityForPid: () => PROCESS_IDENTITY };
}

function manifest(mode: "dev" | "launchd", suffix: "a" | "b"): PidManifest {
  const ids = {
    a: {
      agentId: "aug1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "claim-owner",
    },
    b: {
      agentId: "aug1_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "claim-contender",
    },
  } as const;
  const identity = ids[suffix];
  return {
    pid: process.pid,
    name: identity.name,
    agentId: identity.agentId,
    claimNonce: identity.nonce,
    processIdentity: PROCESS_IDENTITY,
    resourceClaims: [`agent-id:${identity.agentId}`, "telegram-bot:stop-regression"],
    resourceClaimStore: "sqlite-v1",
    port: null,
    configPath: `/tmp/${identity.name}/agent.yaml`,
    agentDir: `/tmp/${identity.name}`,
    startedAt: new Date().toISOString(),
    mode,
  };
}

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "stop-test-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("stop preserves ownership until the recorded process exits", () => {
  test("launchd unload that leaves the process alive preserves manifest and claims", async () => {
    const owner = manifest("launchd", "a");
    expect(claimRuntimePidManifest(owner, registryOptions())).toBe(true);

    await expect(
      runStop(owner.agentId!, {
        ...registryOptions(),
        unloadLaunchd: async () => {},
        sleep: async () => {},
      }),
    ).rejects.toThrow(/did not exit.*claims were preserved/i);

    expect(readPidManifest(owner.agentId!, { auggyDir })).not.toBeNull();
    expect(() => claimRuntimePidManifest(manifest("dev", "b"), registryOptions())).toThrow(
      /resource.*claimed/i,
    );
    removePidManifest(owner.agentId!, { auggyDir });
  });

  test("dev process that remains alive after SIGKILL preserves manifest and claims", async () => {
    const owner = manifest("dev", "a");
    expect(claimRuntimePidManifest(owner, registryOptions())).toBe(true);
    const signals: NodeJS.Signals[] = [];

    await expect(
      runStop(owner.agentId!, {
        ...registryOptions(),
        killProcess(_pid, signal) {
          signals.push(signal);
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(/remained alive.*claims were preserved/i);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(readPidManifest(owner.agentId!, { auggyDir })).not.toBeNull();
    expect(() => claimRuntimePidManifest(manifest("launchd", "b"), registryOptions())).toThrow(
      /resource.*claimed/i,
    );
    removePidManifest(owner.agentId!, { auggyDir });
  });

  test("launchd unload failure preserves ownership even when the old PID is gone", async () => {
    const owner = manifest("launchd", "a");
    owner.pid = 99_999_999;
    expect(claimRuntimePidManifest(owner, registryOptions())).toBe(true);

    await expect(
      runStop(owner.agentId!, {
        auggyDir,
        processIdentityForPid: (pid) => (pid === process.pid ? PROCESS_IDENTITY : null),
        unloadLaunchd: async () => {
          throw new Error("launchctl refused unload");
        },
      }),
    ).rejects.toThrow(/could not unload.*preserved/i);
    expect(readPidManifest(owner.agentId!, { auggyDir })?.claimNonce).toBe(owner.claimNonce);
  });

  test("launchd artifact cleanup failure is surfaced and preserves ownership", async () => {
    const owner = manifest("launchd", "a");
    owner.pid = 99_999_999;
    expect(claimRuntimePidManifest(owner, registryOptions())).toBe(true);

    await expect(
      runStop(owner.agentId!, {
        auggyDir,
        processIdentityForPid: (pid) => (pid === process.pid ? PROCESS_IDENTITY : null),
        unloadLaunchd: async () => {},
        unlinkFile: () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      }),
    ).rejects.toThrow(/control artifacts.*manifest and claims were preserved/i);
    expect(readPidManifest(owner.agentId!, { auggyDir })?.claimNonce).toBe(owner.claimNonce);
  });
});
