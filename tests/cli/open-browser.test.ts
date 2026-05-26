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
  test("macOS uses `open <url>`", () => {
    setPlatform("darwin");
    const result = openBrowser("http://localhost:8080/admin");
    expect(result.ok).toBe(true);
    expect(result.command).toBe("open");
    expect(spawnCalls).toEqual([{ cmd: "open", args: ["http://localhost:8080/admin"] }]);
  });

  test("Linux uses `xdg-open <url>`", () => {
    setPlatform("linux");
    openBrowser("http://localhost:8080/admin");
    expect(spawnCalls).toEqual([{ cmd: "xdg-open", args: ["http://localhost:8080/admin"] }]);
  });

  test('Windows uses `cmd /c start "" <url>`', () => {
    setPlatform("win32");
    openBrowser("http://localhost:8080/admin");
    expect(spawnCalls).toEqual([
      { cmd: "cmd", args: ["/c", "start", "", "http://localhost:8080/admin"] },
    ]);
  });
});
