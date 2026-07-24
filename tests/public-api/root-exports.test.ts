import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { telegramTransport } from "../../src";
import type {
  TelegramAsyncReplayStore,
  TelegramReplayClaimOptions,
  TelegramTransportOptions,
} from "../../src";

interface PackageJson {
  exports?: Record<string, string>;
}

describe("public package exports", () => {
  test("does not export generated route-client helpers from the package", () => {
    const root = process.cwd();
    const indexSource = readFileSync(join(root, "src", "index.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
    const exportTargets = Object.values(packageJson.exports ?? {}).join("\n");

    expect(indexSource).not.toContain("createAuggyClient");
    expect(indexSource).not.toContain("routes-client");
    expect(packageJson.exports?.["./client"]).toBeUndefined();
    expect(packageJson.exports?.["./routes-client"]).toBeUndefined();
    expect(exportTargets).not.toContain("routes-client");
  });

  test("exports the programmatic Telegram shared-replay boundary", () => {
    const claimOptions: TelegramReplayClaimOptions = { signal: new AbortController().signal };
    const store: TelegramAsyncReplayStore = {
      async claimAsync() {
        return "claimed";
      },
    };
    const options = {
      botToken: "1:test",
      inbound: { mode: "polling" },
      auth: {},
      replay: { namespace: "public-api-test", store },
    } satisfies TelegramTransportOptions;

    expect(typeof telegramTransport).toBe("function");
    expect(claimOptions.signal.aborted).toBe(false);
    expect(options.replay.store).toBe(store);
  });
});
