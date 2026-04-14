import { describe, test, expect } from "bun:test";
import {
  generatePlist,
  plistLabel,
  plistStorePath,
  plistInstallPath,
  logDir,
} from "../../src/cli/plist-generator";
import { homedir } from "os";
import { join } from "path";

describe("plist naming", () => {
  test("plistLabel produces com.aug1.agent.<name>", () => {
    expect(plistLabel("zip")).toBe("com.aug1.agent.zip");
  });

  test("plistStorePath is in ~/.auggy/plists/", () => {
    expect(plistStorePath("zip")).toBe(
      join(homedir(), ".auggy", "plists", "com.aug1.agent.zip.plist"),
    );
  });

  test("plistInstallPath is in ~/Library/LaunchAgents/", () => {
    expect(plistInstallPath("zip")).toBe(
      join(homedir(), "Library", "LaunchAgents", "com.aug1.agent.zip.plist"),
    );
  });

  test("logDir is ~/.auggy/logs/", () => {
    expect(logDir()).toBe(join(homedir(), ".auggy", "logs"));
  });
});

describe("generatePlist", () => {
  const plist = generatePlist({
    name: "zip",
    agentDir: "/Users/test/agents/zip",
    configPath: "/Users/test/agents/zip/agent.yaml",
    bunPath: "/Users/test/.bun/bin/bun",
    cliEntryPoint: "/Users/test/augment-1/src/cli/index.ts",
  });

  test("is valid XML with plist doctype", () => {
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain('<plist version="1.0">');
  });

  test("sets the correct label", () => {
    expect(plist).toContain("<string>com.aug1.agent.zip</string>");
  });

  test("invokes auggy dev with --config flag", () => {
    expect(plist).toContain("<string>dev</string>");
    expect(plist).toContain("<string>zip</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).toContain(
      "<string>/Users/test/agents/zip/agent.yaml</string>",
    );
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

  test("routes logs to ~/.auggy/logs/<name>.{log,err}", () => {
    const home = homedir();
    expect(plist).toContain(`${home}/.auggy/logs/zip.log`);
    expect(plist).toContain(`${home}/.auggy/logs/zip.err`);
  });

  test("sets working directory to agent dir", () => {
    expect(plist).toContain(
      "<string>/Users/test/agents/zip</string>",
    );
  });

  test("includes bun in PATH", () => {
    expect(plist).toContain("/Users/test/.bun/bin:");
  });

  test("escapes XML special characters in paths", () => {
    const escaped = generatePlist({
      name: "test&agent",
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
