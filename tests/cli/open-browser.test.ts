import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Capture spawn calls so we can assert the platform-correct command shape
// without actually launching anything.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    return {
      on: () => {},
      unref: () => {},
    };
  },
}));

const { openBrowser } = await import("../../src/cli/open-browser");

// Stash and restore process.platform between tests so we can exercise each
// branch on a single host.
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  spawnCalls.length = 0;
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe("openBrowser", () => {
  test("macOS uses the absolute system `open` path", () => {
    setPlatform("darwin");
    const result = openBrowser("http://localhost:8080/admin");
    expect(result.ok).toBe(true);
    expect(result.command).toBe("/usr/bin/open");
    expect(spawnCalls).toEqual([{ cmd: "/usr/bin/open", args: ["http://localhost:8080/admin"] }]);
  });

  test("Linux uses the absolute system `xdg-open` path", () => {
    setPlatform("linux");
    openBrowser("http://localhost:8080/admin");
    expect(spawnCalls).toEqual([
      { cmd: "/usr/bin/xdg-open", args: ["http://localhost:8080/admin"] },
    ]);
  });

  test("Windows uses rundll32 directly without a command shell", () => {
    setPlatform("win32");
    openBrowser("http://localhost:8080/admin");
    expect(spawnCalls).toEqual([
      {
        cmd: "C:\\Windows\\System32\\rundll32.exe",
        args: ["url.dll,FileProtocolHandler", "http://localhost:8080/admin"],
      },
    ]);
  });

  test("rejects non-web and control-character URLs before spawning", () => {
    expect(openBrowser("file:///tmp/secret").ok).toBe(false);
    expect(openBrowser("https://example.test/\nnext").ok).toBe(false);
    expect(spawnCalls).toEqual([]);
  });
});
