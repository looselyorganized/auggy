import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRuntimeStateInventory,
  mutableFileMemoryRuntimePath,
  resolveRuntimeStatePath,
} from "../../src/cli/runtime-state-inventory";
import type { ParsedConfig } from "../../src/cli/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { agentDir: string; runtimeDataRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "auggy-runtime-inventory-"));
  roots.push(root);
  const agentDir = join(root, "app");
  const runtimeDataRoot = join(agentDir, "data");
  mkdirSync(runtimeDataRoot, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDataRoot, 0o700);
  return { agentDir, runtimeDataRoot };
}

function config(): ParsedConfig {
  return {
    id: "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211",
    name: "inventory-test",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    settings: {
      jobs: {
        enabled: true,
        dbPath: "./data/durable-jobs.sqlite",
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 5_000,
        claimPollMs: 250,
        turnTimeoutMs: 300_000,
        maxAttempts: 3,
        maxTotalRecords: 10_000,
        maxQueuedRecords: 1_000,
        maxPrivateBytes: 134_217_728,
        terminalRetentionMs: 2_592_000_000,
        auditRetentionMs: 7_776_000_000,
        schedules: [
          {
            id: "daily-review",
            cron: "0 9 * * *",
            prompt: "runtime-state-secret-sentinel-prompt",
            enabled: true,
            maxAttempts: 3,
            timeoutMs: 300_000,
          },
        ],
      },
    },
    augments: [
      {
        name: "learned",
        type: "fileMemory",
        options: { mutable: true, source: "./learned-behaviors.md" },
      },
      {
        name: "workspace",
        type: "filesystem",
        options: { mounts: [{ name: "workspace", path: "./data/workspace", writable: true }] },
      },
      { name: "memory", type: "layeredMemory", options: { backend: "sqlite" } },
      { name: "budgets", type: "budgets", options: { retentionDays: 30 } },
      { name: "visitors", type: "visitorAuth", options: {} },
      {
        name: "web",
        type: "webTransport",
        options: { consoleChat: {}, idempotency: {} },
      },
      {
        name: "telegram",
        type: "telegramTransport",
        options: { botToken: "123456:inventory-secret" },
      },
      { name: "mail-a", type: "agentMail", options: {} },
      {
        name: "notify",
        type: "notify",
        options: {
          destinations: [
            { name: "creator", transport: "log-to-file", path: "./notifications.jsonl" },
          ],
        },
      },
    ],
  } as ParsedConfig;
}

describe("runtime state inventory", () => {
  test("classifies all shipped local state with stable ownership and restore metadata", () => {
    const paths = fixture();
    const inventory = buildRuntimeStateInventory(config(), paths);
    const byId = new Map(inventory.stores.map((store) => [store.id, store]));

    expect(inventory.version).toBe(1);
    expect(inventory.configShapeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byId.get("runtime-identity")?.relativePath).toBe(".auggy-state-identity.json");
    expect(byId.get("runtime-singleton-lock")).toMatchObject({
      relativePath: ".auggy-runtime-singleton.lock",
      schema: "posix-flock-anchor/v1",
      replayCritical: false,
      required: false,
    });
    expect(byId.get("file-memory:learned")?.relativePath).toBe("file-memory/learned.md");
    expect(byId.get("filesystem:workspace:workspace")?.relativePath).toBe("workspace");
    expect(byId.get("layered-memory:memory")?.schema).toBe("LMEM/v1");
    expect(byId.get("budgets:budgets")?.schema).toBe("BUDG/v1");
    expect(byId.get("visitor-auth:visitors")?.replayCritical).toBe(true);
    expect(byId.get("web-idempotency:web")?.relativePath).toBe("web-idempotency.db");
    expect(byId.get("console-chat:web")?.relativePath).toBe("console-chat.db");
    expect(byId.get("telegram-replay:telegram")?.schema).toBe("TGRP/v2");
    expect(byId.get("telegram-replay:telegram")?.namespace).toBe("telegram:bot-123456");
    expect(byId.get("agentmail-ledger:mail-a")?.relativePath).toBe(
      "agent-mail/mail-a/agent-mail.db",
    );
    expect(byId.get("agent-mail-rate/v2:mail-a")?.relativePath).toBe(
      "agent-mail/mail-a/agent-mail-state.json",
    );
    expect(byId.get("agent-mail-reviews/v1:mail-a")?.relativePath).toBe(
      "agent-mail/mail-a/agent-mail-reviews.json",
    );
    expect(byId.get("notify-delivery:notify")?.relativePath).toBe("notify-notify.db");
    expect(byId.get("notify-delivery:notify")?.schema).toBe("NTFY/v1");
    expect(byId.get("notify-delivery:notify")?.replayCritical).toBe(true);
    expect(byId.get("durable-jobs")).toMatchObject({
      relativePath: "durable-jobs.sqlite",
      schema: "DJOB/v2",
      replayCritical: true,
      required: true,
      restoreOrder: 15,
    });
    expect(byId.get("notify-log:notify:creator")?.relativePath).toBe("notifications.jsonl");
    expect(byId.get("admin-overrides")?.restoreOrder).toBeLessThan(
      byId.get("web-idempotency:web")!.restoreOrder,
    );
    expect(inventory.externalPrerequisites.map((entry) => entry.id)).toContain(
      "agentmail-provider:mail-a",
    );
  });

  test("records explicit in-memory opt-outs as non-restorable", () => {
    const paths = fixture();
    const value = config();
    const web = value.augments.find((augment) => augment.type === "webTransport")!;
    web.options = { idempotency: { dbPath: null }, consoleChat: { dbPath: null } };
    const inventory = buildRuntimeStateInventory(value, paths);

    for (const id of ["web-idempotency:web", "console-chat:web"]) {
      const store = inventory.stores.find((entry) => entry.id === id)!;
      expect(store.backupPlane).toBe("disabled");
      expect(store.required).toBe(false);
      expect(store.relativePath).toBeUndefined();
    }
  });

  test("preserves Telegram replay identity across Auggy identity upgrades", () => {
    const paths = fixture();
    const first = config();
    const second = config();
    second.id = "aug1_11111111-1111-4111-8111-111111111111";

    const firstReplay = buildRuntimeStateInventory(first, paths).stores.find(
      (entry) => entry.id === "telegram-replay:telegram",
    );
    const secondReplay = buildRuntimeStateInventory(second, paths).stores.find(
      (entry) => entry.id === "telegram-replay:telegram",
    );
    expect(firstReplay?.namespace).toBe("telegram:bot-123456");
    expect(secondReplay?.namespace).toBe(firstReplay?.namespace);

    const telegram = second.augments.find((augment) => augment.type === "telegramTransport")!;
    telegram.options = {
      ...telegram.options,
      replay: { namespace: "operator-stable-bot" },
    };
    expect(
      buildRuntimeStateInventory(second, paths).stores.find(
        (entry) => entry.id === "telegram-replay:telegram",
      )?.namespace,
    ).toBe("operator-stable-bot");
  });

  test("fails closed on escaped state paths and unsafe instance namespaces", () => {
    const paths = fixture();
    expect(() =>
      resolveRuntimeStatePath("../outside.db", paths.agentDir, paths.runtimeDataRoot, "db"),
    ).toThrow("must stay within");
    expect(() => mutableFileMemoryRuntimePath(paths.runtimeDataRoot, "../other")).toThrow(
      "not a safe namespace",
    );
  });

  test("does not include secrets in the configuration shape fingerprint", () => {
    const paths = fixture();
    const value = config();
    value.augments.push({
      name: "remote-memory",
      type: "supabaseMemory",
      options: {
        namespace: "public",
        supabaseUrl: "https://example.invalid",
        supabaseKey: "runtime-state-secret-sentinel",
      },
    });
    const serialized = JSON.stringify(buildRuntimeStateInventory(value, paths));
    expect(serialized).not.toContain("runtime-state-secret-sentinel");
    expect(serialized).not.toContain("runtime-state-secret-sentinel-prompt");
    expect(serialized).not.toContain("example.invalid");
  });

  test("binds durable execution policy and schedule prompts into the recovery fingerprint", () => {
    const paths = fixture();
    const baseline = config();
    const baselineFingerprint = buildRuntimeStateInventory(baseline, paths).configShapeSha256;

    const changedPrompt = config();
    changedPrompt.settings.jobs!.schedules[0]!.prompt = "a different private schedule prompt";
    expect(buildRuntimeStateInventory(changedPrompt, paths).configShapeSha256).not.toBe(
      baselineFingerprint,
    );

    const changedPolicy = config();
    changedPolicy.settings.jobs!.leaseDurationMs += 1_000;
    expect(buildRuntimeStateInventory(changedPolicy, paths).configShapeSha256).not.toBe(
      baselineFingerprint,
    );
  });

  test("binds fleet policy but excludes local coordination polling from the recovery fingerprint", () => {
    const paths = fixture();
    const baseline = config();
    baseline.settings.coordination = {
      mode: "postgres",
      namespace: "8a3d7828-1597-4db4-bd0e-adc1a1036211",
      urlEnv: "DATABASE_URL_A",
      fleetCapacity: { maxConcurrent: 8, maxQueued: 200, maxQueuedPerThread: 25 },
      retention: {
        terminalRequestRetentionMs: 604_800_000,
        maxTerminalRequests: 10_000,
        eventRetentionMs: 2_592_000_000,
        maxEvents: 50_000,
      },
      result: { maxReplayBytes: 65_536 },
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 5_000,
      claimPollMs: 100,
      maxWaitMs: 30_000,
    };
    const baselineFingerprint = buildRuntimeStateInventory(baseline, paths).configShapeSha256;

    const changedFleetPolicy = structuredClone(baseline);
    changedFleetPolicy.settings.coordination!.retention.maxEvents += 1;
    expect(buildRuntimeStateInventory(changedFleetPolicy, paths).configShapeSha256).not.toBe(
      baselineFingerprint,
    );

    const changedLocalPolling = structuredClone(baseline);
    changedLocalPolling.settings.coordination!.urlEnv = "DATABASE_URL_B";
    changedLocalPolling.settings.coordination!.claimPollMs = 250;
    changedLocalPolling.settings.coordination!.maxWaitMs = 5_000;
    expect(buildRuntimeStateInventory(changedLocalPolling, paths).configShapeSha256).toBe(
      baselineFingerprint,
    );
  });
});
