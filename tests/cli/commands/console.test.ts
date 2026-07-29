import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleCommand, runConsole, type ConsoleOpts } from "../../../src/cli/commands/console";
import type { OpenConsoleResult } from "../../../src/cli/console-login";
import type { PidManifest } from "../../../src/cli/types";

const AGENT_ID = "aug1_11111111-1111-4111-8111-111111111111";
const originalWebToken = process.env.AUGGY_WEB_TOKEN;
const tempRoots: string[] = [];

afterEach(() => {
  if (originalWebToken === undefined) delete process.env.AUGGY_WEB_TOKEN;
  else process.env.AUGGY_WEB_TOKEN = originalWebToken;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "auggy-console-command-"));
  tempRoots.push(root);
  return root;
}

function writeAgent(root: string, name = "my-agent", cloudUrl?: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "augments", "webTransport"), { recursive: true });
  writeFileSync(
    join(dir, "agent.yaml"),
    [`id: ${AGENT_ID}`, `name: ${name}`, "augments:", "  - webTransport", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "augments", "webTransport", "augment.yaml"),
    [
      "type: webTransport",
      "config:",
      "  port: 8080",
      "  auth:",
      "    type: bearer",
      "    token: ${AUGGY_WEB_TOKEN}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".env"), "AUGGY_WEB_TOKEN=test-console-token\n");
  if (cloudUrl) {
    writeFileSync(
      join(dir, ".auggy-cloud.json"),
      JSON.stringify({
        version: 1,
        agentId: AGENT_ID,
        provider: "railway",
        projectId: "project-1",
        serviceId: "service-1",
        url: cloudUrl,
        volumeId: "volume-1",
        deployedAt: "2026-07-29T00:00:00.000Z",
      }),
    );
  }
  return dir;
}

function liveManifest(agentDir: string): PidManifest {
  return {
    pid: 123,
    name: "my-agent",
    agentId: AGENT_ID,
    port: 8080,
    configPath: join(agentDir, "agent.yaml"),
    agentDir,
    startedAt: "2026-07-29T00:00:00.000Z",
    mode: "dev",
  };
}

describe("auggy console", () => {
  test("registers local/Railway Console options", () => {
    const command = consoleCommand();
    expect(command.name()).toBe("console");
    expect(command.description()).toContain("Railway Console");
    expect(command.helpInformation()).toContain("[name]");
    expect(command.options.map((option) => option.long)).toEqual(["--config", "--cloud"]);
  });

  test("forwards name and cloud selection", async () => {
    const run = mock(async (_name: string | undefined, _opts: ConsoleOpts) => {});
    const command = consoleCommand({ runConsole: run });
    await command.parseAsync(["my-agent", "--cloud"], { from: "user" });
    expect(run).toHaveBeenCalledWith("my-agent", { config: undefined, cloud: true });
  });

  test("prefers a running local Console and opens it with the configured bearer", async () => {
    const root = makeRoot();
    const agentDir = writeAgent(root);
    const calls: Array<{ baseUrl: string; bearer: string }> = [];
    const messages: string[] = [];
    await runConsole(
      "my-agent",
      { cwd: root },
      {
        readLiveManifest: () => liveManifest(agentDir),
        openConsole: async ({ baseUrl, bearer }) => {
          calls.push({ baseUrl, bearer });
          return {
            opened: true,
            automaticSignIn: true,
            consoleUrl: `${baseUrl}/console`,
          };
        },
        log: (message) => messages.push(message),
      },
    );

    expect(calls).toEqual([{ baseUrl: "http://localhost:8080", bearer: "test-console-token" }]);
    expect(messages).toEqual(['Opened local Console for "my-agent".']);
  });

  test("uses the identity-bound Railway URL and gives a password fallback", async () => {
    const root = makeRoot();
    writeAgent(root, "my-agent", "https://my-agent.up.railway.app");
    const calls: Array<{ baseUrl: string; bearer: string }> = [];
    const logs: string[] = [];
    const warnings: string[] = [];
    await runConsole(
      "my-agent",
      { cwd: root, cloud: true },
      {
        readLiveManifest: () => {
          throw new Error("--cloud must skip local runtime lookup");
        },
        openConsole: async ({ baseUrl, bearer }): Promise<OpenConsoleResult> => {
          calls.push({ baseUrl, bearer });
          return {
            opened: true,
            automaticSignIn: false,
            consoleUrl: `${baseUrl}/console`,
            reason: "automatic sign-in was unavailable",
          };
        },
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
    );

    expect(calls).toEqual([
      { baseUrl: "https://my-agent.up.railway.app", bearer: "test-console-token" },
    ]);
    expect(warnings[0]).toContain("opened the password screen");
    expect(logs[0]).toContain("AUGGY_WEB_TOKEN");
    expect(logs[0]).toContain("my-agent/.env");
  });
});
