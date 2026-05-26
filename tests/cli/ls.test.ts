import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLs } from "../../src/cli/commands/ls";
import { seedAgentForTest } from "../../src/cli/agent-index";

let auggyDir: string;
let logSpy: ReturnType<typeof spyOn>;
let logged: string[];

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "ls-test-auggy-"));
  logged = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("runLs", () => {
  test("prints message when no agents exist", async () => {
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toMatch(/no agents registered/i);
  });

  test("lists agents found on disk", async () => {
    const dir = seedAgentForTest("zip", { auggyDir });
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toContain("zip");
    expect(output).toContain(dir);
  });

  test("URL column shows /admin URL for agents with webTransport", async () => {
    seedAgentForTest("zip", {
      auggyDir,
      yaml:
        "id: aug1_zip\nname: zip\n" +
        "augments:\n" +
        "  - name: web\n    type: webTransport\n    options:\n      port: 8085\n",
    });
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toContain("URL");
    expect(output).toContain("http://localhost:8085/admin");
  });

  test("URL column shows dash for agents without webTransport", async () => {
    seedAgentForTest("headless", { auggyDir });
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toContain("headless");
    expect(output).toMatch(/—\s*$/m);
  });
});
