import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStart } from "../../src/cli/commands/start";
import {
  activateLaunchdGeneration,
  claimAgentLifecycle,
  claimRuntimePidManifest,
  readPidManifest,
  releaseRuntimePidManifest,
} from "../../src/cli/pid-registry";
import type { PidManifest } from "../../src/cli/types";

const AGENT_ID = "aug1_12345678-1234-4123-8123-123456789abc";
const PROCESS_IDENTITY = "test-process:start";
let root: string;
let auggyDir: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "start-test-"));
  auggyDir = join(root, "auggy");
  configPath = join(root, "agent.yaml");
  writeFileSync(
    configPath,
    `id: ${AGENT_ID}\nname: launch-test\nengine:\n  provider: anthropic\n  model: claude-sonnet-4-6\naugments:\n  - type: webFetch\n`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options() {
  return {
    config: configPath,
    auggyDir,
    processIdentityForPid: () => PROCESS_IDENTITY,
    paths: {
      installPath: join(root, "LaunchAgents", "agent.plist"),
      storePath: join(root, "plists", "agent.plist"),
      logDirectory: join(root, "logs"),
    },
    listLaunchd: async () => "",
    sleep: async () => {},
    maxWaitMs: 1,
  };
}

function generationFromPlist(path: string): string {
  const content = readFileSync(path, "utf8");
  const match = content.match(
    /<key>AUGGY_LAUNCH_GENERATION<\/key>\s*<string>([0-9a-f-]+)<\/string>/,
  );
  if (!match?.[1]) throw new Error("missing launch generation in test plist");
  return match[1];
}

describe("runStart launchd generation fencing", () => {
  test("rejects disabled coordination before lifecycle or launchd mutation", async () => {
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}settings:\n  coordination:\n    mode: postgres\n    namespace: 12345678-1234-4123-8123-123456789abc\n`,
    );
    let listed = false;
    const opts = options();

    await expect(
      runStart("launch-test", {
        ...opts,
        listLaunchd: async () => {
          listed = true;
          return "";
        },
      }),
    ).rejects.toThrow(/runtime-not-enabled/);

    expect(listed).toBe(false);
    expect(existsSync(opts.paths.installPath)).toBe(false);
    expect(existsSync(opts.paths.storePath)).toBe(false);
    expect(existsSync(auggyDir)).toBe(false);
  });

  test("closes the previous generation before unloading an installed job", async () => {
    const previousGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    activateLaunchdGeneration(AGENT_ID, previousGeneration, { auggyDir });
    const delayed: PidManifest = {
      pid: process.pid,
      name: "launch-test",
      agentId: AGENT_ID,
      claimNonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [`agent-id:${AGENT_ID}`],
      resourceClaimStore: "sqlite-v1",
      launchGeneration: previousGeneration,
      port: null,
      configPath,
      agentDir: root,
      startedAt: new Date().toISOString(),
      mode: "launchd",
    };
    let unloads = 0;
    const opts = options();
    await expect(
      runStart("launch-test", {
        ...opts,
        listLaunchd: async () => `com.auggy.agent.${AGENT_ID}`,
        unloadLaunchd: async () => {
          unloads++;
          if (unloads === 1) {
            expect(() =>
              claimRuntimePidManifest(delayed, {
                auggyDir,
                processIdentityForPid: () => PROCESS_IDENTITY,
              }),
            ).toThrow(/generation.*closed or superseded/i);
          }
        },
        loadLaunchd: async () => {},
      }),
    ).rejects.toThrow(/did not start/i);
    expect(unloads).toBe(2);
    expect(readPidManifest(AGENT_ID, { auggyDir })).toBeNull();
  });

  test("unloads and removes an armed KeepAlive job when startup times out", async () => {
    let loads = 0;
    let unloads = 0;
    let generation: string | undefined;
    const opts = options();
    await expect(
      runStart("launch-test", {
        ...opts,
        loadLaunchd: async () => {
          loads++;
          generation = generationFromPlist(opts.paths.storePath);
        },
        unloadLaunchd: async () => {
          unloads++;
        },
      }),
    ).rejects.toThrow(/did not start/i);
    expect({ loads, unloads }).toEqual({ loads: 1, unloads: 1 });
    expect(existsSync(opts.paths.installPath)).toBe(false);
    expect(existsSync(opts.paths.storePath)).toBe(false);
    const delayed: PidManifest = {
      pid: process.pid,
      name: "launch-test",
      agentId: AGENT_ID,
      claimNonce: "11111111-1111-4111-8111-111111111111",
      processIdentity: PROCESS_IDENTITY,
      resourceClaims: [`agent-id:${AGENT_ID}`],
      resourceClaimStore: "sqlite-v1",
      launchGeneration: generation,
      port: null,
      configPath,
      agentDir: root,
      startedAt: new Date().toISOString(),
      mode: "launchd",
    };
    expect(() =>
      claimRuntimePidManifest(delayed, {
        auggyDir,
        processIdentityForPid: () => PROCESS_IDENTITY,
      }),
    ).toThrow(/generation.*closed or superseded/i);
  });

  test("attempts fail-closed unload when launchctl load has an unknown outcome", async () => {
    let unloads = 0;
    const opts = options();
    await expect(
      runStart("launch-test", {
        ...opts,
        loadLaunchd: async () => {
          throw new Error("launchctl connection dropped");
        },
        unloadLaunchd: async () => {
          unloads++;
        },
      }),
    ).rejects.toThrow(/connection dropped/i);
    expect(unloads).toBe(1);
    expect(existsSync(opts.paths.installPath)).toBe(false);
    expect(existsSync(opts.paths.storePath)).toBe(false);
  });

  test("preserves recovery state when rollback cannot stop an admitted child", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const opts = options();
    let admitted: PidManifest | undefined;
    try {
      await expect(
        runStart("launch-test", {
          ...opts,
          maxWaitMs: 0,
          loadLaunchd: async () => {
            admitted = {
              pid: child.pid,
              name: "launch-test",
              agentId: AGENT_ID,
              claimNonce: "55555555-5555-4555-8555-555555555555",
              processIdentity: PROCESS_IDENTITY,
              resourceClaims: [`agent-id:${AGENT_ID}`],
              resourceClaimStore: "sqlite-v1",
              launchGeneration: generationFromPlist(opts.paths.storePath),
              port: null,
              configPath,
              agentDir: root,
              startedAt: new Date().toISOString(),
              mode: "launchd",
            };
            expect(claimRuntimePidManifest(admitted, options())).toBe(true);
          },
          unloadLaunchd: async () => {},
        }),
      ).rejects.toThrow(/could not verify.*runtime exited.*artifacts.*preserved/i);

      expect(existsSync(opts.paths.installPath)).toBe(true);
      expect(existsSync(opts.paths.storePath)).toBe(true);
      expect(readPidManifest(AGENT_ID, { auggyDir })?.claimNonce).toBe(admitted?.claimNonce);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      if (admitted) releaseRuntimePidManifest(admitted, true, { auggyDir });
    }
  });

  test("does not admit an unrelated foreground runtime during launchd installation", async () => {
    const opts = options();
    let wrongManifest: PidManifest | undefined;
    await expect(
      runStart("launch-test", {
        ...opts,
        loadLaunchd: async () => {
          wrongManifest = {
            pid: process.pid,
            name: "launch-test",
            agentId: AGENT_ID,
            claimNonce: "22222222-2222-4222-8222-222222222222",
            processIdentity: PROCESS_IDENTITY,
            resourceClaims: [`agent-id:${AGENT_ID}`],
            resourceClaimStore: "sqlite-v1",
            port: null,
            configPath,
            agentDir: root,
            startedAt: new Date().toISOString(),
            mode: "dev",
          };
          claimRuntimePidManifest(wrongManifest, {
            auggyDir,
            processIdentityForPid: () => PROCESS_IDENTITY,
          });
        },
        unloadLaunchd: async () => {},
      }),
    ).rejects.toThrow(/foreground.*active launchd installation/i);
    expect(readPidManifest(AGENT_ID, { auggyDir })).toBeNull();
    if (wrongManifest) releaseRuntimePidManifest(wrongManifest, true, { auggyDir });
  });

  test("accepts only the generation embedded in the installed plist", async () => {
    const opts = options();
    let launched: PidManifest | undefined;
    await runStart("launch-test", {
      ...opts,
      loadLaunchd: async () => {
        launched = {
          pid: process.pid,
          name: "launch-test",
          agentId: AGENT_ID,
          claimNonce: "33333333-3333-4333-8333-333333333333",
          processIdentity: PROCESS_IDENTITY,
          resourceClaims: [`agent-id:${AGENT_ID}`],
          resourceClaimStore: "sqlite-v1",
          launchGeneration: generationFromPlist(opts.paths.storePath),
          port: null,
          configPath,
          agentDir: root,
          startedAt: new Date().toISOString(),
          mode: "launchd",
        };
        claimRuntimePidManifest(launched, {
          auggyDir,
          processIdentityForPid: () => PROCESS_IDENTITY,
        });
      },
      unloadLaunchd: async () => {},
    });
    expect(readPidManifest(AGENT_ID, { auggyDir })?.launchGeneration).toBe(
      launched?.launchGeneration,
    );
    if (launched) releaseRuntimePidManifest(launched, true, { auggyDir });
  });

  test("serializes lifecycle controllers for one immutable agent", () => {
    const release = claimAgentLifecycle(AGENT_ID, "launch-test", {
      auggyDir,
      processIdentityForPid: () => PROCESS_IDENTITY,
    });
    try {
      expect(() =>
        claimAgentLifecycle(AGENT_ID, "launch-test", {
          auggyDir,
          processIdentityForPid: () => PROCESS_IDENTITY,
        }),
      ).toThrow(/resource.*claimed/i);
    } finally {
      release();
    }
  });
});
