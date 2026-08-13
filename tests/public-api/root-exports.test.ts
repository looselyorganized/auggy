import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { telegramTransport } from "../../src";
import type {
  AgentMailInboundRateLimitOptions,
  AgentMailNotificationOptions,
  TelegramAsyncReplayStore,
  TelegramReplayClaim,
  TelegramReplayClaimOptions,
  TelegramReplayConflict,
  TelegramTransportOptions,
} from "../../src";

interface PackageJson {
  exports?: Record<string, string>;
}

describe("public package exports", () => {
  test("exports the complete public AgentMail configuration boundary", () => {
    const inboundRateLimit = {
      globalMaxPerHour: 100,
      perSenderMaxPerHour: 5,
    } satisfies AgentMailInboundRateLimitOptions;
    const notifications = {
      destination: "creator",
      maxAttempts: 3,
    } satisfies AgentMailNotificationOptions;

    expect(inboundRateLimit.perSenderMaxPerHour).toBe(5);
    expect(notifications.destination).toBe("creator");
  });

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
    const claim: TelegramReplayClaim = "quarantined";
    const conflict: TelegramReplayConflict = {
      id: "incident",
      updateId: 1,
      detectedAt: 1,
    };
    const store: TelegramAsyncReplayStore = {
      async claimAsync() {
        return "claimed";
      },
      async getConflictAsync() {
        return null;
      },
      async resolveConflictAsync() {
        return false;
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
    expect(claim).toBe("quarantined");
    expect(conflict.id).toBe("incident");
    expect(options.replay.store).toBe(store);
  });

  test("exports durable jobs only through its explicit trusted subpath", async () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as PackageJson;
    expect(packageJson.exports?.["./jobs"]).toBe("./src/jobs/index.ts");

    const jobs = await import("../../src/jobs");
    expect(typeof jobs.createSqliteDurableJobStore).toBe("function");
    expect(typeof jobs.createDurableJobRuntime).toBe("function");

    const root = await import("../../src");
    expect("createSqliteDurableJobStore" in root).toBe(false);
    expect("createDurableJobRuntime" in root).toBe(false);
  });
});
