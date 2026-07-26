import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "../../src/cli/commands/stop";
import {
  activateLaunchdGeneration,
  claimRuntimePidManifest,
  readPidManifest,
  removePidManifest,
  removePidManifestIfOwned,
} from "../../src/cli/pid-registry";
import type { PidManifest } from "../../src/cli/types";

const PROCESS_IDENTITY = "test-process:stop-owner";
const LAUNCH_GENERATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
  const result: PidManifest = {
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
  if (mode === "launchd") {
    result.launchGeneration = LAUNCH_GENERATION;
    activateLaunchdGeneration(identity.agentId, LAUNCH_GENERATION, registryOptions());
  }
  return result;
}

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "stop-test-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("stop preserves ownership until the recorded process exits", () => {
  test("closes and unloads an active launchd generation without a manifest", async () => {
    const owner = manifest("launchd", "a");
    let unloads = 0;
    await runStop(owner.agentId!, {
      ...registryOptions(),
      paths: {
        installPath: join(auggyDir, "manifestless.install.plist"),
        storePath: join(auggyDir, "manifestless.store.plist"),
      },
      unloadLaunchd: async () => {
        unloads++;
      },
    });
    expect(unloads).toBe(1);
    expect(() => claimRuntimePidManifest(owner, registryOptions())).toThrow(
      /generation.*closed or superseded/i,
    );
  });

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
    removePidManifest(owner.agentId!, { auggyDir });
    expect(() =>
      claimRuntimePidManifest(
        { ...owner, pid: process.pid, claimNonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        registryOptions(),
      ),
    ).toThrow(/generation.*closed or superseded/i);
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

  test("launchd stop rejects same-generation publication during and after unload", async () => {
    const owner = manifest("launchd", "a");
    owner.pid = 99_999_999;
    expect(
      claimRuntimePidManifest(owner, {
        auggyDir,
        processIdentityForPid: () => PROCESS_IDENTITY,
      }),
    ).toBe(true);
    const replacement = {
      ...owner,
      pid: process.pid,
      claimNonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      processIdentity: PROCESS_IDENTITY,
    };

    await runStop(owner.agentId!, {
      auggyDir,
      processIdentityForPid: (pid) => (pid === process.pid ? PROCESS_IDENTITY : null),
      unloadLaunchd: async () => {
        expect(removePidManifestIfOwned(owner, { auggyDir })).toBe(true);
        expect(() =>
          claimRuntimePidManifest(replacement, {
            auggyDir,
            processIdentityForPid: () => PROCESS_IDENTITY,
          }),
        ).toThrow(/generation.*closed or superseded/i);
      },
      sleep: async () => {},
    });

    expect(readPidManifest(owner.agentId!, { auggyDir })).toBeNull();
    expect(() =>
      claimRuntimePidManifest(replacement, {
        auggyDir,
        processIdentityForPid: () => PROCESS_IDENTITY,
      }),
    ).toThrow(/generation.*closed or superseded/i);
  });
});
