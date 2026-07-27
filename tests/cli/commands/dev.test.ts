import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  formatDevReadyMessage,
  formatRunDisplayPath,
  resolveRuntimeDataRoot,
  runDev,
} from "../../../src/cli/commands/dev";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveRuntimeDataRoot", () => {
  test("selects the Railway volume root only for the exact Railway mode", () => {
    expect(resolveRuntimeDataRoot("railway")).toBe("/app/data");
    expect(resolveRuntimeDataRoot(undefined)).toBeUndefined();
    expect(resolveRuntimeDataRoot("dev")).toBeUndefined();
    expect(resolveRuntimeDataRoot("launchd")).toBeUndefined();
    expect(resolveRuntimeDataRoot("Railway")).toBeUndefined();
    expect(resolveRuntimeDataRoot("railway-preview")).toBeUndefined();
  });
});

describe("formatDevReadyMessage", () => {
  test("prints the local run success banner with extension and Railway deploy guidance", () => {
    const out = formatDevReadyMessage({
      agentName: "my-agent",
      port: 8080,
      configPath: "/tmp/my-agent/agent.yaml",
      deployCommand: "auggy deploy",
    });

    expect(out).toContain('Agent "my-agent" is live.');
    expect(out).toContain("  Chat:     http://localhost:8080/console/chat");
    expect(out).toContain("  Console:  http://localhost:8080/console");
    expect(out).toContain("  Health:   http://localhost:8080/health");
    expect(out).toContain("  Home:     http://localhost:8080/");
    expect(out).toContain("Extend it:");
    expect(out).toContain("  auggy augment list");
    expect(out).toContain("  auggy augment add <name>");
    expect(out).toContain("  auggy augment create <name>");
    expect(out).toContain("Deploy it:");
    expect(out).toMatch(/ {2}auggy deploy\s+Deploy to Railway/);
    expect(out).toContain("Config: /tmp/my-agent/agent.yaml");
    expect(out).toContain("Press Ctrl-C to stop.");
  });

  test("uses named deploy command when the agent was run by name", () => {
    const out = formatDevReadyMessage({
      agentName: "zip",
      port: 8080,
      configPath: "/tmp/zip/agent.yaml",
      deployCommand: "auggy deploy zip",
    });

    expect(out).toMatch(/ {2}auggy deploy zip\s+Deploy to Railway/);
  });

  test("prints a cloud boot banner without local next steps", () => {
    const out = formatDevReadyMessage({
      agentName: "zip",
      port: 8080,
      configPath: "agent.yaml",
      deployCommand: "auggy deploy zip",
      runtime: "railway",
      publicUrl: "https://zip-production.up.railway.app",
    });

    expect(out).toContain('Agent "zip" is live.');
    expect(out).toContain("  Chat:     https://zip-production.up.railway.app/console/chat");
    expect(out).toContain("  Console:  https://zip-production.up.railway.app/console");
    expect(out).toContain("  Health:   https://zip-production.up.railway.app/health");
    expect(out).toContain("  Home:     https://zip-production.up.railway.app");
    expect(out).toContain("Config: agent.yaml");
    expect(out).toContain("Runtime: Railway");
    expect(out).not.toContain("http://localhost:8080");
    expect(out).not.toContain("Extend it:");
    expect(out).not.toContain("Deploy it:");
    expect(out).not.toContain("Press Ctrl-C to stop.");
  });

  test("falls back to container-local URLs when Railway public URL is unavailable", () => {
    const out = formatDevReadyMessage({
      agentName: "zip",
      port: 8080,
      configPath: "agent.yaml",
      deployCommand: "auggy deploy zip",
      runtime: "railway",
      publicUrl: "",
    });

    expect(out).toContain("  Health:   http://localhost:8080/health");
    expect(out).toContain("Runtime: Railway");
  });

  test("formats config paths relative to the command cwd", () => {
    expect(formatRunDisplayPath("/repo/dx-agent/agent.yaml", "/repo")).toBe("dx-agent/agent.yaml");
    expect(formatRunDisplayPath("/repo/dx-agent/agent.yaml", "/repo/dx-agent")).toBe("agent.yaml");
  });
});

describe("runDev distributed startup ordering", () => {
  test("rejects disabled coordination before importing custom code or opening job state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auggy-disabled-coordination-"));
    tempDirectories.push(directory);
    const markerPath = join(directory, "custom-imported");
    const jobsPath = join(directory, "durable-jobs.sqlite");
    const configPath = join(directory, "agent.yaml");
    writeFileSync(join(directory, "identity.md"), "# Test identity\n");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: { auggy: "0.5.0", "@auggy/ollama": "0.5.0" },
      }),
    );
    symlinkSync(join(import.meta.dir, "../../../node_modules"), join(directory, "node_modules"));
    writeFileSync(
      join(directory, "probe.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(markerPath)}, "imported");\n` +
        `export default function probe() { return { name: "probe" }; }\n`,
    );
    writeFileSync(
      configPath,
      stringify({
        id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
        name: "distributed-ordering-test",
        identity: "./identity.md",
        engine: { provider: "ollama", model: "qwen3.5" },
        settings: {
          coordination: {
            mode: "postgres",
            namespace: "a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
            fleetCapacity: {
              maxConcurrent: 4,
              maxQueued: 100,
              maxQueuedPerThread: 20,
            },
          },
          jobs: { enabled: true, dbPath: jobsPath },
        },
        augments: [{ name: "probe", type: "custom", source: "./probe.ts" }],
      }),
    );

    const before = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
      exit: new Set(process.listeners("exit")),
    };
    let error: Error | undefined;
    try {
      await runDev(undefined, {
        config: configPath,
        cwd: directory,
        auggyDir: join(directory, ".auggy-test"),
      });
    } catch (caught) {
      error = caught as Error;
    } finally {
      for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].has(listener)) process.removeListener(signal, listener);
        }
      }
    }

    expect(error?.message).toContain("process-local-fleet-admission");
    expect(error?.message).not.toContain("AUGGY_COORDINATION_DATABASE_URL");
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(jobsPath)).toBe(false);
    expect(existsSync(join(directory, ".auggy-test"))).toBe(false);
  });
});
