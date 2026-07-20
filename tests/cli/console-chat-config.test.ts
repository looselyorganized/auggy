import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { resolveConsoleChatOptions } from "../../src/cli/augment-resolver";
import { parseConfig } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-console-chat-config-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeConfig(consoleChat: unknown): string {
  const path = join(TMP, "agent.yaml");
  writeFileSync(
    path,
    stringify({
      id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      name: "test-agent",
      engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      augments: [
        {
          type: "webTransport",
          options: {
            port: 8080,
            auth: { type: "bearer", token: "test" },
            consoleChat,
          },
        },
      ],
    }),
  );
  return path;
}

describe("webTransport consoleChat config parsing", () => {
  test("accepts an explicit path and the null in-memory opt-out", () => {
    const persisted = parseConfig(writeConfig({ dbPath: "./state/chat.db" }));
    expect(persisted.augments[0]?.options?.consoleChat).toEqual({
      dbPath: "./state/chat.db",
    });

    const inMemory = parseConfig(writeConfig({ dbPath: null }));
    expect(inMemory.augments[0]?.options?.consoleChat).toEqual({ dbPath: null });
  });

  test("rejects malformed storage config before runtime resolution", () => {
    expect(() => parseConfig(writeConfig("./chat.db"))).toThrow(/consoleChat: must be an object/);
    expect(() => parseConfig(writeConfig({ dbPath: "  " }))).toThrow(
      /consoleChat\.dbPath: must be a non-empty string or null/,
    );
    expect(() => parseConfig(writeConfig({ dbPath: 42 }))).toThrow(
      /consoleChat\.dbPath: must be a non-empty string or null/,
    );
  });
});

describe("webTransport consoleChat path resolution", () => {
  test("defaults local persistence under the agent data directory", () => {
    expect(resolveConsoleChatOptions({}, TMP)).toEqual({
      dbPath: join(TMP, "data", "console-chat.db"),
    });
  });

  test("does not synthesize storage when the console is disabled", () => {
    expect(resolveConsoleChatOptions({ adminRoute: false }, TMP)).toBeUndefined();
  });

  test("preserves the explicit in-memory opt-out", () => {
    expect(resolveConsoleChatOptions({ consoleChat: { dbPath: null } }, TMP)).toEqual({
      dbPath: null,
    });
  });

  test("maps defaults and explicit relative paths into the Railway data root", () => {
    const agentDir = join(TMP, "app");
    const runtimeDataRoot = join(agentDir, "data");
    mkdirSync(runtimeDataRoot, { recursive: true });

    expect(resolveConsoleChatOptions({}, agentDir, runtimeDataRoot)).toEqual({
      dbPath: join(runtimeDataRoot, "console-chat.db"),
    });
    expect(
      resolveConsoleChatOptions(
        { consoleChat: { dbPath: "./nested/chat.db" } },
        agentDir,
        runtimeDataRoot,
      ),
    ).toEqual({ dbPath: join(runtimeDataRoot, "nested", "chat.db") });
  });

  test("rejects an explicit Railway path outside the durable root", () => {
    const agentDir = join(TMP, "app");
    const runtimeDataRoot = join(agentDir, "data");
    mkdirSync(runtimeDataRoot, { recursive: true });

    expect(() =>
      resolveConsoleChatOptions(
        { consoleChat: { dbPath: join(TMP, "escaped.db") } },
        agentDir,
        runtimeDataRoot,
      ),
    ).toThrow(/consoleChat\.dbPath must stay within its runtime data root/);
  });
});
