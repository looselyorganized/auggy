import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentMailInboundCoordinator,
  type AgentMailInboundCoordinatorOptions,
} from "../../../src/augments/agentMail/inbound";
import {
  AgentMailProviderError,
  type AgentMailMessageSummary,
  type AgentMailProvider,
  type AgentMailProviderEvent,
} from "../../../src/augments/agentMail/provider";
import { createAgentMailOrchestrationStore } from "../../../src/augments/agentMail/store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function message(id: string, timestamp: number): AgentMailMessageSummary {
  return {
    inboxId: "support@agentmail.to",
    threadId: `thread_${id}`,
    messageId: id,
    sender: `${id}@example.com`,
    to: ["support@agentmail.to"],
    cc: [],
    labels: ["received"],
    timestamp,
    updatedAt: timestamp,
    size: 100,
    classification: "received",
    attachmentCount: 0,
  };
}

class FakeProvider implements AgentMailProvider {
  readonly sequence: string[] = [];
  pages: Array<{ messages: AgentMailMessageSummary[]; nextPageToken?: string }> = [
    { messages: [] },
  ];
  liveDuringConnect?: AgentMailProviderEvent;
  handlers?: Parameters<AgentMailProvider["connect"]>[0];
  listCalls = 0;
  closed = false;

  async verifyAccess() {
    this.sequence.push("verify");
    return {
      scopeType: "organization",
      scopeId: "org_1",
      organizationId: "org_1",
      configuredInboxId: "support@agentmail.to",
    };
  }

  async listMessages() {
    this.sequence.push("list");
    const page = this.pages[Math.min(this.listCalls, this.pages.length - 1)]!;
    this.listCalls += 1;
    return page;
  }

  async connect(handlers: Parameters<AgentMailProvider["connect"]>[0]) {
    this.sequence.push("connect");
    this.handlers = handlers;
    handlers.onOpen?.();
    if (this.liveDuringConnect) await handlers.onEvent(this.liveDuringConnect);
    return {
      close: () => {
        this.closed = true;
      },
    };
  }

  async emit(event: AgentMailProviderEvent) {
    await this.handlers?.onEvent(event);
  }

  reconnect() {
    this.handlers?.onClose?.({ code: 1006 });
    this.handlers?.onOpen?.();
  }

  async getMessage(): Promise<never> {
    throw new Error("unused");
  }
  async getThread(): Promise<never> {
    throw new Error("unused");
  }
  async listDrafts(): Promise<never> {
    throw new Error("unused");
  }
  async createReplyDraft(): Promise<never> {
    throw new Error("unused");
  }
  async getDraft(): Promise<never> {
    throw new Error("unused");
  }
  async updateDraft(): Promise<never> {
    throw new Error("unused");
  }
  async sendDraft(): Promise<never> {
    throw new Error("unused");
  }
  async sendMessage(): Promise<never> {
    throw new Error("unused");
  }
}

function fixture(
  provider: FakeProvider,
  overrides: Partial<AgentMailInboundCoordinatorOptions> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-inbound-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const store = createAgentMailOrchestrationStore({
    dbPath: join(root, "orchestration.db"),
    inboxId: "support@agentmail.to",
  });
  const woken: string[] = [];
  const coordinator = createAgentMailInboundCoordinator({
    provider,
    store,
    policyVersion: 1,
    onWorkAvailable: (messageId) => {
      woken.push(messageId);
    },
    repairIntervalMs: 24 * 60 * 60_000,
    ...overrides,
  });
  return { coordinator, store, woken };
}

function receivedEvent(summary: AgentMailMessageSummary, eventId = `event_${summary.messageId}`) {
  return {
    type: "message.received" as const,
    eventId,
    classification: summary.classification,
    message: summary,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function permissionFailure(): AgentMailProviderError {
  return new AgentMailProviderError({
    code: "permission_missing",
    operation: "list_messages",
    phase: "catch_up",
    retryable: false,
    httpStatus: 403,
    nextAction: "Check inbox access.",
  });
}

describe("AgentMail inbound wake and recovery coordinator", () => {
  test("recovers failed catch-up once per episode and keeps persistent failures degraded", async () => {
    const provider = new FakeProvider();
    const recovered: Error[] = [];
    const errors: Error[] = [];
    const f = fixture(provider, {
      onRecovered: (error) => recovered.push(error),
      onError: (error) => errors.push(error),
    });
    try {
      await f.coordinator.start();
      await f.coordinator.repair();
      expect(recovered).toEqual([]);
      const failed = permissionFailure();
      const listMessages = provider.listMessages.bind(provider);
      provider.listMessages = async () => {
        throw failed;
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(f.coordinator.repair()).rejects.toBe(failed);
        expect(f.coordinator.status()).toMatchObject({
          state: "degraded",
          lastErrorCode: "permission_missing",
        });
        expect(recovered).toEqual([]);
      }
      expect(errors).toEqual([failed, failed]);
      provider.listMessages = listMessages;
      await f.coordinator.repair();
      expect(f.coordinator.status().state).toBe("ready");
      expect(f.coordinator.status().lastErrorCode).toBeUndefined();
      expect(recovered).toEqual([failed]);
      await f.coordinator.repair();
      expect(recovered).toEqual([failed]);
      provider.handlers?.onError?.(failed);
      await f.coordinator.repair();
      expect(recovered).toEqual([failed, failed]);
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("does not let older catch-up success clear a newer live error", async () => {
    const provider = new FakeProvider();
    const recovered: Error[] = [];
    const f = fixture(provider, { onRecovered: (error) => recovered.push(error) });
    const pending = deferred<Awaited<ReturnType<FakeProvider["listMessages"]>>>();
    try {
      await f.coordinator.start();
      const first = permissionFailure();
      provider.handlers?.onError?.(first);
      const listMessages = provider.listMessages.bind(provider);
      provider.listMessages = () => pending.promise;
      const repair = f.coordinator.repair();
      const newer = new AgentMailProviderError({
        ...permissionFailure().details,
        code: "provider_unavailable",
      });
      provider.handlers?.onError?.(newer);
      pending.resolve({ messages: [] });
      await repair;
      expect(f.coordinator.status()).toMatchObject({
        state: "degraded",
        lastErrorCode: "provider_unavailable",
      });
      expect(recovered).toEqual([]);
      provider.listMessages = listMessages;
      await f.coordinator.repair();
      expect(f.coordinator.status().state).toBe("ready");
      expect(recovered).toEqual([newer]);
    } finally {
      pending.resolve({ messages: [] });
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("only reports recovery after pending work has been signaled successfully", async () => {
    const provider = new FakeProvider();
    const recovered: Error[] = [];
    const failed = new Error("could not schedule work");
    let failWork = true;
    const f = fixture(provider, {
      onRecovered: (error) => recovered.push(error),
      onWorkAvailable() {
        if (failWork) throw failed;
      },
    });
    try {
      await f.coordinator.start();
      provider.handlers?.onError?.(permissionFailure());
      provider.pages = [{ messages: [message("pending_1", 1_000)] }];
      await f.coordinator.repair();
      expect(f.coordinator.status()).toMatchObject({
        state: "degraded",
        lastErrorCode: "inbound_failure",
      });
      expect(recovered).toEqual([]);
      failWork = false;
      await f.coordinator.repair();
      expect(recovered).toEqual([failed]);
      expect(f.coordinator.status().state).toBe("ready");
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  for (const lateMessages of [[], [message("late_1", 2_000)]]) {
    test(`ignores catch-up completion after shutdown with ${lateMessages.length} messages`, async () => {
      const provider = new FakeProvider();
      const recovered: Error[] = [];
      const f = fixture(provider, { onRecovered: (error) => recovered.push(error) });
      const pending = deferred<Awaited<ReturnType<FakeProvider["listMessages"]>>>();
      try {
        await f.coordinator.start();
        const lastCatchUpAt = f.coordinator.status().lastCatchUpAt;
        provider.handlers?.onError?.(permissionFailure());
        provider.listMessages = () => pending.promise;
        const repair = f.coordinator.repair();
        const stopping = f.coordinator.stop();
        pending.resolve({ messages: lateMessages });
        await Promise.all([repair, stopping]);
        expect(f.coordinator.status()).toEqual({
          state: "stopped",
          lastCatchUpAt,
          lastErrorCode: "permission_missing",
        });
        expect(recovered).toEqual([]);
        expect(f.woken).toEqual([]);
        expect(f.store.getMessage("late_1")).toBeUndefined();
        provider.handlers?.onOpen?.();
        provider.handlers?.onError?.(permissionFailure());
        expect(f.coordinator.status().state).toBe("stopped");
      } finally {
        pending.resolve({ messages: [] });
        await f.coordinator.stop();
        f.store.close();
      }
    });
  }

  test("does not connect when access verification finishes after shutdown", async () => {
    const provider = new FakeProvider();
    const pending = deferred<Awaited<ReturnType<FakeProvider["verifyAccess"]>>>();
    const verifyAccess = provider.verifyAccess.bind(provider);
    provider.verifyAccess = () => pending.promise;
    const f = fixture(provider);
    try {
      const starting = f.coordinator.start();
      await f.coordinator.stop();
      pending.resolve(await verifyAccess());
      await starting;
      expect(provider.sequence).toEqual(["verify"]);
      expect(f.coordinator.status()).toEqual({ state: "stopped" });
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("does not publish readiness when initial catch-up finishes after shutdown", async () => {
    const provider = new FakeProvider();
    const entered = deferred<void>();
    const pending = deferred<Awaited<ReturnType<FakeProvider["listMessages"]>>>();
    const recovered: Error[] = [];
    provider.listMessages = async () => {
      entered.resolve();
      return pending.promise;
    };
    const f = fixture(provider, { onRecovered: (error) => recovered.push(error) });
    try {
      const starting = f.coordinator.start();
      await entered.promise;
      const stopping = f.coordinator.stop();
      pending.resolve({ messages: [] });
      await Promise.all([starting, stopping]);
      expect(f.coordinator.status()).toEqual({ state: "stopped" });
      expect(recovered).toEqual([]);
      expect(provider.closed).toBe(true);
    } finally {
      pending.resolve({ messages: [] });
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("closes a subscription that finishes connecting after shutdown", async () => {
    const provider = new FakeProvider();
    const entered = deferred<void>();
    const pending = deferred<Awaited<ReturnType<FakeProvider["connect"]>>>();
    provider.connect = async () => {
      entered.resolve();
      return pending.promise;
    };
    const f = fixture(provider);
    try {
      const starting = f.coordinator.start();
      await entered.promise;
      await f.coordinator.stop();
      pending.resolve({
        close: () => {
          provider.closed = true;
        },
      });
      await starting;
      expect(provider.closed).toBe(true);
      expect(provider.listCalls).toBe(0);
      expect(f.coordinator.status()).toEqual({ state: "stopped" });
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("subscribes before REST catch-up and wakes for offline mail", async () => {
    const provider = new FakeProvider();
    provider.pages = [{ messages: [message("offline_1", 1_000)] }];
    const f = fixture(provider);
    try {
      await f.coordinator.start();
      expect(provider.sequence).toEqual(["verify", "connect", "list"]);
      expect(f.store.getMessage("offline_1")?.state).toBe("pending");
      expect(f.store.getCheckpoint()).toEqual({ timestamp: 1_000, messageId: "offline_1" });
      expect(f.woken).toEqual(["offline_1"]);
      expect(f.coordinator.status().state).toBe("ready");
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("deduplicates live/catch-up overlap and wakes exactly once", async () => {
    const provider = new FakeProvider();
    const overlapping = message("overlap_1", 2_000);
    provider.liveDuringConnect = receivedEvent(overlapping);
    provider.pages = [{ messages: [overlapping] }];
    const f = fixture(provider);
    try {
      await f.coordinator.start();
      expect(f.woken).toEqual(["overlap_1"]);
      expect(f.store.getMessage("overlap_1")).toMatchObject({ state: "pending" });
      expect(f.store.claimNext()).toMatchObject({ messageId: "overlap_1", attemptCount: 1 });
      expect(f.store.claimNext()).toBeUndefined();
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("runs catch-up again after reconnect", async () => {
    const provider = new FakeProvider();
    provider.pages = [{ messages: [] }, { messages: [message("reconnected_1", 3_000)] }];
    const f = fixture(provider);
    try {
      await f.coordinator.start();
      provider.reconnect();
      await f.coordinator.repair();
      expect(provider.listCalls).toBe(2);
      expect(f.store.getMessage("reconnected_1")?.state).toBe("pending");
      expect(f.woken).toEqual(["reconnected_1"]);
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("records delivery lifecycle events without creating inbound work", async () => {
    const provider = new FakeProvider();
    const f = fixture(provider);
    try {
      await f.coordinator.start();
      const delivered = {
        type: "message.delivered" as const,
        eventId: "delivery_1",
        inboxId: "support@agentmail.to",
        threadId: "thread_sent",
        messageId: "message_sent",
        timestamp: 4_000,
      };
      await provider.emit(delivered);
      await provider.emit(delivered);
      expect(f.store.hasPendingWork()).toBe(false);
      expect(f.woken).toEqual([]);
    } finally {
      await f.coordinator.stop();
      f.store.close();
    }
  });

  test("fails bounded catch-up closed and closes the live subscription", async () => {
    const provider = new FakeProvider();
    provider.pages = [
      { messages: [], nextPageToken: "page_2" },
      { messages: [], nextPageToken: "page_3" },
    ];
    const errors: Error[] = [];
    const f = fixture(provider, {
      maxCatchUpPages: 1,
      onError: (error) => errors.push(error),
    });
    await expect(f.coordinator.start()).rejects.toThrow(/page bound/);
    expect(f.coordinator.status()).toMatchObject({
      state: "degraded",
      lastErrorCode: "inbound_failure",
    });
    expect(errors).toHaveLength(1);
    await f.coordinator.stop();
    expect(provider.closed).toBe(true);
    f.store.close();
  });
});
