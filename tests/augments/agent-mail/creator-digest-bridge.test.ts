import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Augment } from "../../../src/types";
import type {
  AgentMailCreatorDigestBatch,
  AgentMailCreatorDigestStore,
} from "../../../src/augments/agentMail/creator-digest";
import {
  AGENTMAIL_CREATOR_DIGEST_SOURCE,
  createAgentMailCreatorDigestBridge,
  renderAgentMailCreatorDigestSummary,
  type AgentMailCreatorDigestController,
  type AgentMailCreatorDigestSource,
} from "../../../src/augments/agentMail/creator-digest-bridge";
import { createAgentMailInboundLedger } from "../../../src/augments/agentMail/inbound-ledger";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
} from "../../../src/augments/agentMail/provider";
import { notify } from "../../../src/augments/notify";

function batch(): AgentMailCreatorDigestBatch {
  return {
    id: "digest_1",
    inboxId: "inbox_1",
    baseGeneration: 0,
    deliveryTargetSha256: "a".repeat(64),
    contentSha256: "b".repeat(64),
    createdAt: 1_000,
    items: [
      {
        ordinal: 0,
        inboxId: "inbox_1",
        messageId: "message_secret",
        attentionVersion: 2,
        attentionState: "pending_review",
        reviewId: "review_secret",
        incidentVersion: 0,
        sourceAt: 900,
      },
      {
        ordinal: 1,
        inboxId: "inbox_1",
        messageId: "message_ambiguous",
        attentionVersion: 1,
        attentionState: "ambiguous",
        incidentId: "incident_secret",
        incidentVersion: 1,
        incidentReasonCode: "turn-outcome-unknown",
        sourceAt: 950,
      },
    ],
  };
}

function fixture(
  result: Record<string, unknown>,
  options: {
    current?: boolean;
    inspection?: Record<string, unknown>;
    prepareEmpty?: boolean;
    settled?: AgentMailCreatorDigestBatch[];
    throwOnCurrent?: boolean;
  } = {},
) {
  const prepared = batch();
  const settlements: Array<Record<string, unknown>> = [];
  const retryAuthorizations: Array<Record<string, unknown>> = [];
  let settledBatch: AgentMailCreatorDigestBatch | undefined;
  let controller: AgentMailCreatorDigestController | undefined;
  const store = {
    prepare: (input: { deliveryTargetSha256: string }) => {
      prepared.deliveryTargetSha256 = input.deliveryTargetSha256;
      return options.prepareEmpty ? null : prepared;
    },
    getPending: () => prepared,
    get: () => settledBatch ?? prepared,
    listSettled: () => options.settled ?? (settledBatch ? [settledBatch] : []),
    isCurrent: () => {
      if (options.throwOnCurrent) throw new Error("sqlite unavailable");
      return options.current ?? true;
    },
    settle: (input: Record<string, unknown>) => {
      settlements.push(input);
      settledBatch = {
        ...prepared,
        settlement: {
          generation: 1,
          disposition: input.disposition as "presented" | "dismissed" | "confirmed-no-effect",
          evidenceSha256: "e".repeat(64),
          advancedAt: 1_001,
        },
      };
      return { status: "settled", generation: 1 };
    },
  } as unknown as AgentMailCreatorDigestStore;
  const source: AgentMailCreatorDigestSource = {
    inboxId: "inbox_1",
    config: {
      enabled: true,
      destination: "creator",
      intervalMs: 60_000,
      maxItems: 20,
      maxAttempts: 5,
    },
    attach: (value) => {
      if (controller) throw new Error("already attached");
      controller = value;
    },
    store: () => store,
  };
  const dispatches: Array<Record<string, unknown>> = [];
  const acknowledgements: Array<Record<string, unknown>> = [];
  let destinationBinding = "c".repeat(64);
  const mail = {
    name: "company-mail",
    [AGENTMAIL_CREATOR_DIGEST_SOURCE]: source,
  } as Augment;
  const notify = {
    name: "operator-notify",
    dispatchHost: {
      destinationBindingSha256: () => destinationBinding,
      inspectInternal: () => options.inspection ?? { status: "not_found", attemptCount: 0 },
      dispatchInternal: async (input: Record<string, unknown>) => {
        dispatches.push(input);
        return result;
      },
      acknowledgeInternalSettlement: (input: Record<string, unknown>) => {
        acknowledgements.push(input);
        return { status: "acknowledged" };
      },
      authorizeInternalRetry: (input: Record<string, unknown>) => {
        retryAuthorizations.push(input);
        return { status: "authorized", attemptCount: 5, authorizedAttempt: 6 };
      },
    },
  } as unknown as Augment;
  return {
    bridge: createAgentMailCreatorDigestBridge({ agentMail: mail, notify }),
    acknowledgements,
    controller: () => controller,
    dispatches,
    mail,
    notify,
    retryAuthorizations,
    setDestinationBinding: (value: string) => {
      destinationBinding = value;
    },
    settlements,
  };
}

describe("AgentMail creator digest bridge", () => {
  it("renders deterministic metadata-only creator summaries", () => {
    const itemBatch = batch() as AgentMailCreatorDigestBatch & {
      subject?: string;
      sender?: string;
      body?: string;
    };
    itemBatch.subject = "TOP SECRET acquisition";
    itemBatch.sender = "private@example.com";
    itemBatch.body = "raw customer body";

    const rendered = renderAgentMailCreatorDigestSummary(itemBatch);

    expect(rendered).toBe(
      "AgentMail has 1 quarantined email, 1 ambiguous reply, 1 reply awaiting review needing creator attention. Open the creator console to review them.",
    );
    expect(rendered).not.toContain("TOP SECRET");
    expect(rendered).not.toContain("private@example.com");
    expect(rendered).not.toContain("message_secret");
    expect(rendered).not.toContain("review_secret");
    expect(rendered).not.toContain("incident_secret");
  });

  it("recovers a settlement acknowledgement backlog larger than one page exactly once", async () => {
    const settled = Array.from({ length: 101 }, (_, index) => ({
      ...batch(),
      id: `digest_backlog_${index + 1}`,
      baseGeneration: index,
      contentSha256: (index % 16).toString(16).repeat(64),
      settlement: {
        generation: index + 1,
        disposition: "presented" as const,
        evidenceSha256: "e".repeat(64),
        advancedAt: 2_000 + index,
      },
    }));
    const f = fixture(
      { status: "sent", replayed: false, attemptCount: 1 },
      { prepareEmpty: true, settled },
    );

    await f.bridge.onBoot?.();
    expect(f.acknowledgements).toHaveLength(101);
    expect(f.controller()?.status().lastPresentedAt).toBe(2_100);
    await f.controller()?.runNow();
    expect(f.acknowledgements).toHaveLength(101);
    await f.bridge.onShutdown?.();
  });

  it("uses Notify replay protection and settles a sent batch exactly once", async () => {
    const f = fixture({ status: "sent", replayed: false, attemptCount: 1 });

    await f.bridge.onBoot?.();
    await f.bridge.onShutdown?.();

    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]).toMatchObject({
      source: "agentmail.creator-digest",
      destination: "creator",
      maxAttempts: 5,
    });
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({
      batchId: "digest_1",
      disposition: "presented",
      expectedContentSha256: "b".repeat(64),
    });
    expect(f.controller()?.status()).toMatchObject({
      state: "idle",
      attemptCount: 1,
    });
  });

  it("replays across real AMIL and NTFY stores after a crash between settlements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmail-digest-integration-"));
    const mailDbPath = join(dir, "mail.sqlite");
    const notifyDbPath = join(dir, "notify.sqlite");
    let deliveries = 0;
    const createNotifications = () =>
      notify({
        dbPath: notifyDbPath,
        destinations: [
          {
            name: "creator",
            transport: "webhook",
            url: "https://example.com/creator",
            allowedTrustLevels: ["creator"],
          },
        ],
        rateLimit: { cooldownMs: 0, dedupWindowMs: 0, globalMaxPerHour: 10 },
        adapters: {
          webhook: {
            async deliver() {
              deliveries++;
              return { status: "sent" };
            },
          },
        },
      });
    const sourceFor = (store: AgentMailCreatorDigestStore) => {
      let attached: AgentMailCreatorDigestController | undefined;
      return {
        source: {
          inboxId: "inbox_1",
          config: {
            enabled: true,
            destination: "creator",
            intervalMs: 60_000,
            maxItems: 20,
            maxAttempts: 5,
          },
          attach(controller: AgentMailCreatorDigestController) {
            attached = controller;
          },
          store: () => store,
        } satisfies AgentMailCreatorDigestSource,
        controller: () => attached,
      };
    };

    try {
      let ledger = createAgentMailInboundLedger({
        dbPath: mailDbPath,
        now: () => 5_000,
        digestBatchId: () => "cross_store_batch",
      });
      ledger.enqueue(
        agentMailRestEnvelope(
          normalizeAgentMailMessage({
            inbox_id: "inbox_1",
            thread_id: "thread_1",
            message_id: "message_1",
            labels: ["received"],
            timestamp: "2026-07-14T10:20:30.000Z",
            from: "sender@example.com",
            to: ["inbox_1"],
            subject: "private",
            text: "private",
            size: 32,
          }),
        ),
      );
      const claim = ledger.claimNext({ workerId: "worker_1", leaseMs: 1_000 })!;
      ledger.creatorAttention.reserve({
        inboxId: "inbox_1",
        messageId: "message_1",
        allowReopen: false,
      });
      expect(ledger.complete(claim)).toBe(true);

      let rejectSettlement = true;
      const crashingStore = new Proxy(ledger.creatorDigest, {
        get(target, property, receiver) {
          if (property === "settle" && rejectSettlement) {
            return () => {
              rejectSettlement = false;
              throw new Error("simulated process loss after Notify commit");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const firstSource = sourceFor(crashingStore);
      const firstNotify = createNotifications();
      const firstBridge = createAgentMailCreatorDigestBridge({
        agentMail: {
          name: "mail",
          [AGENTMAIL_CREATOR_DIGEST_SOURCE]: firstSource.source,
        } as Augment,
        notify: firstNotify,
      });
      await firstNotify.onBoot?.();
      await firstBridge.onBoot?.();
      expect(firstSource.controller()?.status()).toMatchObject({
        state: "degraded",
        reasonCode: "digest-store-unavailable",
      });
      await firstBridge.onShutdown?.();
      await firstNotify.onShutdown?.();
      ledger.close();

      ledger = createAgentMailInboundLedger({ dbPath: mailDbPath, now: () => 5_001 });
      const secondSource = sourceFor(ledger.creatorDigest);
      const secondNotify = createNotifications();
      const secondBridge = createAgentMailCreatorDigestBridge({
        agentMail: {
          name: "mail",
          [AGENTMAIL_CREATOR_DIGEST_SOURCE]: secondSource.source,
        } as Augment,
        notify: secondNotify,
      });
      await secondNotify.onBoot?.();
      await secondBridge.onBoot?.();

      expect(deliveries).toBe(1);
      expect(ledger.creatorDigest.getPending("inbox_1")).toBeNull();
      expect(ledger.creatorDigest.listSettled("inbox_1")).toHaveLength(1);
      expect(secondSource.controller()?.status().state).toBe("idle");

      await secondBridge.onShutdown?.();
      await secondNotify.onShutdown?.();
      ledger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains an outcome-unknown batch without settlement or blind resend", async () => {
    const f = fixture({ status: "outcome_unknown", attemptCount: 1 });

    await f.bridge.onBoot?.();
    await f.controller()?.runNow();
    await f.bridge.onShutdown?.();

    expect(f.dispatches).toHaveLength(2);
    expect(f.dispatches[1]?.operationKey).toBe(f.dispatches[0]?.operationKey);
    expect(f.settlements).toHaveLength(0);
    expect(f.controller()?.status()).toMatchObject({
      state: "outcome_unknown",
      reasonCode: "operator-reconciliation-required",
    });
  });

  it("retires stale source generations before any provider dispatch", async () => {
    const f = fixture({ status: "sent", replayed: false, attemptCount: 1 }, { current: false });

    await f.bridge.onBoot?.();
    await f.bridge.onShutdown?.();

    expect(f.dispatches).toHaveLength(0);
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({
      batchId: "digest_1",
      disposition: "confirmed-no-effect",
      evidence: "digest-source-generation-stale-no-effect",
    });
    expect(f.controller()?.status()).toMatchObject({
      state: "idle",
      reasonCode: "stale-batch-retired",
    });
  });

  it("settles a stale crash-recovered batch as presented when Notify already sent it", async () => {
    const f = fixture(
      { status: "sent", replayed: false, attemptCount: 1 },
      {
        current: false,
        inspection: { status: "sent", attemptCount: 1 },
      },
    );

    await f.bridge.onBoot?.();
    await f.bridge.onShutdown?.();

    expect(f.dispatches).toHaveLength(0);
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({
      disposition: "presented",
      evidence: "notify-probe-confirmed-sent",
    });
    expect(f.controller()?.status()).toMatchObject({
      state: "idle",
      attemptCount: 1,
      reasonCode: "stale-batch-confirmed-presented",
    });
  });

  it("degrades without dispatch on store failure or runtime destination drift", async () => {
    const unavailable = fixture(
      { status: "sent", replayed: false, attemptCount: 1 },
      { throwOnCurrent: true },
    );
    await expect(unavailable.bridge.onBoot?.()).resolves.toBeUndefined();
    expect(unavailable.dispatches).toHaveLength(0);
    expect(unavailable.controller()?.status()).toMatchObject({
      state: "degraded",
      reasonCode: "digest-store-unavailable",
    });
    await unavailable.bridge.onShutdown?.();

    const drifted = fixture({ status: "sent", replayed: false, attemptCount: 1 });
    drifted.setDestinationBinding("d".repeat(64));
    await drifted.bridge.onBoot?.();
    expect(drifted.dispatches).toHaveLength(0);
    expect(drifted.controller()?.status()).toMatchObject({
      state: "degraded",
      reasonCode: "delivery-target-changed",
    });
    await drifted.bridge.onShutdown?.();
  });

  it("requires exact exhaustion CAS for a creator retry and dismisses only the digest", async () => {
    const f = fixture({ status: "attempts_exhausted", attemptCount: 5 });
    await f.bridge.onBoot?.();

    expect(
      f.controller()?.authorizeRetry({
        batchId: "digest_1",
        expectedAttemptCount: 5,
        evidence: "destination repaired",
      }),
    ).toEqual({
      ok: true,
      message: "Creator digest attempt 6 is authorized.",
    });
    expect(f.retryAuthorizations).toHaveLength(1);
    expect(f.retryAuthorizations[0]).toMatchObject({
      source: "agentmail.creator-digest",
      expectedAttemptCount: 5,
      evidence: "destination repaired",
    });

    expect(
      f.controller()?.dismiss({
        batchId: "digest_1",
        evidence: "creator reviewed the console",
      }),
    ).toMatchObject({ ok: true });
    expect(f.settlements.at(-1)).toMatchObject({
      batchId: "digest_1",
      disposition: "dismissed",
      evidence: "creator reviewed the console",
    });
    await f.bridge.onShutdown?.();
  });

  it("rejects disabled sources and duplicate attachment", () => {
    const disabledSource: AgentMailCreatorDigestSource = {
      inboxId: "inbox_1",
      config: {
        enabled: false,
        intervalMs: 60_000,
        maxItems: 20,
        maxAttempts: 5,
      },
      attach: () => undefined,
      store: () => {
        throw new Error("not booted");
      },
    };
    const mail = {
      name: "mail",
      [AGENTMAIL_CREATOR_DIGEST_SOURCE]: disabledSource,
    } as Augment;
    const notify = {
      name: "notify",
      dispatchHost: {
        destinationBindingSha256: () => "c".repeat(64),
        inspectInternal: () => ({ status: "not_found", attemptCount: 0 }),
        dispatchInternal: async () => ({ status: "sent" }),
      },
    } as unknown as Augment;
    expect(() => createAgentMailCreatorDigestBridge({ agentMail: mail, notify })).toThrow(
      "is not enabled",
    );

    let unsafeAttached = false;
    const enabledMail = {
      name: "mail",
      [AGENTMAIL_CREATOR_DIGEST_SOURCE]: {
        ...disabledSource,
        config: {
          enabled: true,
          destination: "creator",
          intervalMs: 60_000,
          maxItems: 20,
          maxAttempts: 5,
        },
        attach: () => {
          unsafeAttached = true;
        },
      },
    } as Augment;
    const unsafeNotify = {
      name: "notify",
      dispatchHost: {
        destinationBindingSha256: () => undefined,
        inspectInternal: () => ({ status: "not_found", attemptCount: 0 }),
        dispatchInternal: async () => ({ status: "sent" }),
      },
    } as unknown as Augment;
    expect(() =>
      createAgentMailCreatorDigestBridge({
        agentMail: enabledMail,
        notify: unsafeNotify,
      }),
    ).toThrow(/destination "creator" is unavailable/);
    expect(unsafeAttached).toBe(false);

    const f = fixture({ status: "in_flight" });
    expect(() =>
      createAgentMailCreatorDigestBridge({ agentMail: f.mail, notify: f.notify }),
    ).toThrow("already attached");
  });
});
