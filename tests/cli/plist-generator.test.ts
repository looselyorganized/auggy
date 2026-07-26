import { describe, test, expect } from "bun:test";
import {
  generatePlist,
  plistLabel,
  plistStorePath,
  plistInstallPath,
  logDir,
} from "../../src/cli/plist-generator";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_ID = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";

describe("plist naming", () => {
  test("plistLabel produces com.auggy.agent.<immutable-id>", () => {
    expect(plistLabel(AGENT_ID)).toBe(`com.auggy.agent.${AGENT_ID}`);
  });

  test("plistStorePath is in ~/.auggy/plists/", () => {
    expect(plistStorePath(AGENT_ID)).toBe(
      join(homedir(), ".auggy", "plists", `com.auggy.agent.${AGENT_ID}.plist`),
    );
  });

  test("plistInstallPath is in ~/Library/LaunchAgents/", () => {
    expect(plistInstallPath(AGENT_ID)).toBe(
      join(homedir(), "Library", "LaunchAgents", `com.auggy.agent.${AGENT_ID}.plist`),
    );
  });

  test("logDir is ~/.auggy/logs/", () => {
    expect(logDir()).toBe(join(homedir(), ".auggy", "logs"));
  });
});

describe("generatePlist", () => {
  const plist = generatePlist({
    name: "zip",
    agentId: AGENT_ID,
    agentDir: "/Users/test/agents/zip",
    configPath: "/Users/test/agents/zip/agent.yaml",
    bunPath: "/Users/test/.bun/bin/bun",
    cliEntryPoint: "/Users/test/auggy/src/cli/index.ts",
  });

  test("is valid XML with plist doctype", () => {
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain('<plist version="1.0">');
  });

  test("sets the correct label", () => {
    expect(plist).toContain(`<string>com.auggy.agent.${AGENT_ID}</string>`);
  });

  test("invokes auggy dev with --config flag", () => {
    expect(plist).toContain("<string>dev</string>");
    expect(plist).toContain("<string>zip</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).toContain("<string>/Users/test/agents/zip/agent.yaml</string>");
  });

  test("sets KeepAlive to true", () => {
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
  });

  test("sets ThrottleInterval to 10", () => {
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>10</integer>");
  });

  test("sets RunAtLoad to true", () => {
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  test("routes logs to ~/.auggy/logs/<immutable-id>.{log,err}", () => {
    const home = homedir();
    expect(plist).toContain(`${home}/.auggy/logs/${AGENT_ID}.log`);
    expect(plist).toContain(`${home}/.auggy/logs/${AGENT_ID}.err`);
  });

  test("sets working directory to agent dir", () => {
    expect(plist).toContain("<string>/Users/test/agents/zip</string>");
  });

  test("includes bun in PATH", () => {
    expect(plist).toContain("/Users/test/.bun/bin:");
  });

  test("escapes XML special characters in paths", () => {
    const escaped = generatePlist({
      name: "test&agent",
      agentId: AGENT_ID,
      agentDir: "/path/with <angle>/brackets",
      configPath: "/path/with <angle>/agent.yaml",
      bunPath: "/usr/bin/bun",
      cliEntryPoint: "/cli/index.ts",
    });
    expect(escaped).toContain("test&amp;agent");
    expect(escaped).toContain("&lt;angle&gt;");
    expect(escaped).not.toContain("<angle>");
  });
});
