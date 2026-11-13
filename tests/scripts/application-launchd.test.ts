import { describe, expect, test } from "bun:test";
import {
  applicationLaunchdAvailability,
  applicationLaunchdListedPid,
  inspectApplicationLaunchdManifest,
  inspectApplicationLaunchdPlist,
} from "../../scripts/release-smoke/application-launchd";

const expected = {
  agentId: "aug1_11111111-2222-4333-8444-555555555555",
  name: "inspectable-agent",
  consumer: "/isolated/agent",
  configPath: "/isolated/agent/agent.yaml",
  home: "/isolated/home",
  cli: "/isolated/agent/node_modules/auggy/src/cli/index.ts",
  bun: "/tools/bun",
  port: 47219,
};
const generation = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const label = `com.auggy.agent.${expected.agentId}`;
function plist() {
  return {
    Label: label,
    ProgramArguments: [
      expected.bun,
      "run",
      expected.cli,
      "dev",
      expected.name,
      "--config",
      expected.configPath,
      "--internal-mode",
      "launchd",
    ],
    WorkingDirectory: expected.consumer,
    KeepAlive: true,
    RunAtLoad: true,
    ThrottleInterval: 10,
    StandardOutPath: `${expected.home}/.auggy/logs/${expected.agentId}.log`,
    StandardErrorPath: `${expected.home}/.auggy/logs/${expected.agentId}.err`,
    EnvironmentVariables: {
      HOME: expected.home,
      PATH: "/tools:/usr/bin:/bin",
      AUGGY_LAUNCH_GENERATION: generation,
    },
  };
}
function manifest() {
  return {
    agentId: expected.agentId,
    name: expected.name,
    mode: "launchd",
    launchGeneration: generation,
    configPath: expected.configPath,
    agentDir: expected.consumer,
    port: expected.port,
    pid: 81234,
    claimNonce: "11111111-2222-4333-8444-555555555555",
    processIdentity: `ps-sha256:${"a".repeat(64)}`,
    resourceClaimStore: "sqlite-v1",
  };
}

describe("launchd evidence validators, not actual macOS service acceptance", () => {
  test("non-macOS is explicitly unavailable", () => {
    expect(applicationLaunchdAvailability("linux")).toEqual({
      available: false,
      reason: "macos-launchd-required",
    });
    expect(applicationLaunchdAvailability("win32").available).toBe(false);
    expect(applicationLaunchdAvailability("darwin").available).toBe(true);
  });
  test("binds exact installed local CLI/config/identity, generation and isolated HOME", () => {
    expect(inspectApplicationLaunchdPlist(plist(), expected).generation).toBe(generation);
    for (const changed of [
      { Label: `${label}.other` },
      { WorkingDirectory: "/other" },
      { KeepAlive: false },
      { ProgramArguments: [expected.bun, "run", "/global/auggy", "dev", expected.name] },
      { StandardOutPath: "/real-user/service.log" },
      { EnvironmentVariables: { ...plist().EnvironmentVariables, HOME: "/real-user" } },
      { EnvironmentVariables: { ...plist().EnvironmentVariables, API_SECRET: "unwanted" } },
      {
        EnvironmentVariables: {
          ...plist().EnvironmentVariables,
          AUGGY_LAUNCH_GENERATION: "forged",
        },
      },
    ])
      expect(() => inspectApplicationLaunchdPlist({ ...plist(), ...changed }, expected)).toThrow();
  });
  test("requires actual manifest incarnation and matching generation rather than a naked PID", () => {
    expect(inspectApplicationLaunchdManifest(manifest(), expected, generation).pid).toBe(81234);
    for (const changed of [
      { agentId: "aug1_other" },
      { mode: "dev" },
      { launchGeneration: "previous" },
      { configPath: "/other/agent.yaml" },
      { agentDir: "/other" },
      { port: 8080 },
      { pid: 0 },
      { pid: 1.5 },
      { processIdentity: undefined },
      { claimNonce: undefined },
      { resourceClaimStore: undefined },
    ])
      expect(() =>
        inspectApplicationLaunchdManifest({ ...manifest(), ...changed }, expected, generation),
      ).toThrow("manifest");
  });
  test("requires successful listing format and exact service label, preserving loaded-but-idle distinction", () => {
    const header = "PID\tStatus\tLabel\n";
    expect(applicationLaunchdListedPid(`${header}81234\t0\t${label}\n`, label)).toBe(81234);
    expect(applicationLaunchdListedPid(`${header}-\t0\t${label}\n`, label)).toBeNull();
    expect(
      applicationLaunchdListedPid(`${header}81234\t0\t${label}.other\n`, label),
    ).toBeUndefined();
    expect(() => applicationLaunchdListedPid("permission denied", label)).toThrow("header");
    expect(() =>
      applicationLaunchdListedPid(`${header}81234\t0\t${label}\n81235\t0\t${label}\n`, label),
    ).toThrow("Duplicate");
    expect(() => applicationLaunchdListedPid(`${header}bad\t0\t${label}\n`, label)).toThrow("PID");
    expect(() =>
      applicationLaunchdListedPid(`${header}99999999999999999999\t0\t${label}\n`, label),
    ).toThrow("PID");
  });
});
