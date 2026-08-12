import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentMailInboundCoordinator,
  type AgentMailInboundCoordinatorOptions,
} from "../../../src/augments/agentMail/inbound";
import type {
  AgentMailMessageSummary,
  AgentMailProvider,
  AgentMailProviderEvent,
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

describe("AgentMail inbound wake and recovery coordinator", () => {
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
