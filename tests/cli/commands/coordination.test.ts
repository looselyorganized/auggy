import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  coordinationCommand,
  runCoordinationMigrate,
  type CoordinationMigrationClient,
} from "../../../src/cli/commands/coordination";

const roots: string[] = [];
const SENTINEL_URL =
  "postgres://auggy-secret-sentinel@db.example.invalid/coordination?sslmode=verify-full";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeAgent(withCoordination = true): string {
  const root = mkdtempSync(join(tmpdir(), "coordination-command-test-"));
  roots.push(root);
  const config = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name: "coordination-test",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    augments: [
      {
        name: "identity",
        type: "fileMemory",
        options: {
          label: "self",
          source: "./identity.md",
          mutable: false,
          origin: "operator",
          priority: "required",
          placement: "system",
          eviction: "never",
        },
      },
    ],
    ...(withCoordination
      ? {
          settings: {
            coordination: {
              mode: "postgres",
              namespace: "a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
            },
          },
        }
      : {}),
  };
  writeFileSync(join(root, "agent.yaml"), stringify(config));
  writeFileSync(join(root, "identity.md"), "# Identity\n");
  return root;
}

function fakeClient(onClose?: () => void): CoordinationMigrationClient {
  return {
    begin: async <T>(callback: (transaction: CoordinationMigrationClient) => Promise<T>) =>
      callback(fakeClient(onClose)),
    unsafe: async () => [],
    close: async () => onClose?.(),
  };
}

describe("runCoordinationMigrate", () => {
  test("resolves the agent config, migrates, closes, and returns only schema IDs", async () => {
    const root = writeAgent();
    let receivedUrl: string | undefined;
    let closed = false;
    let migrated = false;

    const result = await runCoordinationMigrate(undefined, {
      cwd: root,
      env: { AUGGY_COORDINATION_DATABASE_URL: SENTINEL_URL },
      createClient: (url) => {
        receivedUrl = url;
        return fakeClient(() => {
          closed = true;
        });
      },
      migrate: async () => {
        migrated = true;
      },
    });

    expect(receivedUrl).toBe(SENTINEL_URL);
    expect(migrated).toBe(true);
    expect(closed).toBe(true);
    expect(result).toEqual(["20260724_01_distributed_turn_coordination"]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_URL);
  });

  test("rejects an agent without coordination configured before reading or connecting", async () => {
    const root = writeAgent(false);
    let connected = false;
    await expect(
      runCoordinationMigrate(undefined, {
        cwd: root,
        env: { AUGGY_COORDINATION_DATABASE_URL: SENTINEL_URL },
        createClient: () => {
          connected = true;
          return fakeClient();
        },
      }),
    ).rejects.toThrow("settings.coordination must be configured");
    expect(connected).toBe(false);
  });

  test("rejects a missing or empty configured environment variable without connecting", async () => {
    const root = writeAgent();
    for (const env of [{}, { AUGGY_COORDINATION_DATABASE_URL: "   " }]) {
      let connected = false;
      await expect(
        runCoordinationMigrate(undefined, {
          cwd: root,
          env,
          createClient: () => {
            connected = true;
            return fakeClient();
          },
        }),
      ).rejects.toThrow("AUGGY_COORDINATION_DATABASE_URL is missing or empty");
      expect(connected).toBe(false);
    }
  });

  test("rejects an insecure remote URL before creating a client without leaking it", async () => {
    const root = writeAgent();
    const insecureUrl = "postgres://auggy-secret-sentinel@db.example.invalid/coordination";
    let connected = false;
    let thrown: Error | undefined;
    try {
      await runCoordinationMigrate(undefined, {
        cwd: root,
        env: { AUGGY_COORDINATION_DATABASE_URL: insecureUrl },
        createClient: () => {
          connected = true;
          return fakeClient();
        },
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(connected).toBe(false);
    expect(thrown?.message).toBe("coordination migration failed");
    expect(String(thrown)).not.toContain("auggy-secret-sentinel");
  });

  test("sanitizes migration and close errors while always closing a created client", async () => {
    const root = writeAgent();
    let closed = false;
    let thrown: Error | undefined;
    try {
      await runCoordinationMigrate(undefined, {
        cwd: root,
        env: { AUGGY_COORDINATION_DATABASE_URL: SENTINEL_URL },
        createClient: () =>
          fakeClient(() => {
            closed = true;
          }),
        migrate: async () => {
          throw new Error(`database refused ${SENTINEL_URL}`);
        },
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(closed).toBe(true);
    expect(thrown?.message).toBe("coordination migration failed");
    expect(String(thrown)).not.toContain(SENTINEL_URL);

    await expect(
      runCoordinationMigrate(undefined, {
        cwd: root,
        env: { AUGGY_COORDINATION_DATABASE_URL: SENTINEL_URL },
        createClient: () => ({
          ...fakeClient(),
          close: async () => {
            throw new Error(SENTINEL_URL);
          },
        }),
        migrate: async () => {},
      }),
    ).rejects.toThrow("coordination migration failed");
  });
});

describe("coordinationCommand", () => {
  test("prints only schema IDs and keeps a sentinel URL out of stdout and stderr", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value: unknown) => stdout.push(String(value));
    console.error = (value: unknown) => stderr.push(String(value));
    try {
      const command = coordinationCommand({
        runCoordinationMigrate: async () => ["20260724_01_distributed_turn_coordination"],
        exit: () => {},
      });
      await command.parseAsync(["node", "auggy", "migrate"]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(stdout).toEqual([
      "Coordination preview schema provisioned: 20260724_01_distributed_turn_coordination. Runtime replicas remain unsupported.",
    ]);
    expect(stderr).toEqual([]);
    expect(`${stdout}\n${stderr}`).not.toContain(SENTINEL_URL);
  });

  test("redacts an injected database error from command stderr", async () => {
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = (value: unknown) => stderr.push(String(value));
    try {
      const command = coordinationCommand({
        runCoordinationMigrate: async () => {
          throw new Error(`database refused ${SENTINEL_URL}`);
        },
        exit: () => {},
      });
      await command.parseAsync(["node", "auggy", "migrate"]);
    } finally {
      console.error = originalError;
    }
    expect(stderr).toEqual(["Error: coordination migration failed"]);
    expect(stderr.join("\n")).not.toContain(SENTINEL_URL);
  });
});
