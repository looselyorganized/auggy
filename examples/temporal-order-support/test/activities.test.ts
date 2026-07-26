import { describe, expect, it } from "bun:test";

import {
  createOrderSupportActivities,
  type OrderSupportActivityDependencies,
  type OrderSupportActivityOutcome,
} from "../src/activities.ts";
import { AuggyRunError, type AuggyRunClient } from "../src/auggy-client.ts";
import { refundResultForOrderSupportOutcome } from "../src/workflow-result.ts";

const config = {
  target: "https://auggy.example.com",
  bearerToken: "test-only-secret",
  maxSseBytes: 1_024,
  maxSseEvents: 10,
};

const input = {
  idempotencyKey: "stable-key",
  threadId: "stable-thread",
  message: "bounded message",
};

function rejectingClient(error: AuggyRunError): AuggyRunClient {
  return {
    async run() {
      throw error;
    },
  };
}

function dependencies(error: AuggyRunError, aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  let cancelledRead = false;
  let heartbeats = 0;
  const injected: OrderSupportActivityDependencies = {
    client: rejectingClient(error),
    currentContext: () => ({
      cancellationSignal: controller.signal,
      get cancelled() {
        cancelledRead = true;
        return Promise.reject(new Error("temporal-cancelled"));
      },
      heartbeat() {
        heartbeats += 1;
      },
    }),
    now: () => 10_000,
  };
  return {
    activities: createOrderSupportActivities(config, injected),
    wasCancelledRead: () => cancelledRead,
    heartbeats: () => heartbeats,
  };
}

describe("Temporal order-support Activity mapping", () => {
  it.each([
    ["auth-required", "auth-required"],
    ["binding-conflict", "binding-conflict"],
    ["input-required", "input-required"],
    ["task-failed", "failed"],
    ["rejected", "rejected"],
    ["remote-canceled", "remote-canceled"],
    ["run-error", "outcome-unknown"],
    ["task-working", "outcome-unknown"],
    ["task-status-unknown", "outcome-unknown"],
    ["local-canceled", "outcome-unknown"],
  ] as const)("maps %s to a non-completed Activity outcome", async (kind, expectedState) => {
    const harness = dependencies(new AuggyRunError(kind, false));
    const outcome = await harness.activities.requestOrderSupportReview(input);
    expect(outcome.state).toBe(expectedState);
    expect(outcome.state).not.toBe("completed");
    expect(refundResultForOrderSupportOutcome(outcome).state).toBe("manual-reconciliation-required");
    expect(harness.wasCancelledRead()).toBe(false);
    expect(harness.heartbeats()).toBe(1);
  });

  it("awaits Temporal cancellation only for a local abort with an aborted signal", async () => {
    const harness = dependencies(new AuggyRunError("local-canceled", false), true);
    await expect(harness.activities.requestOrderSupportReview(input)).rejects.toThrow("temporal-cancelled");
    expect(harness.wasCancelledRead()).toBe(true);
  });

  it("allows only the completed Activity outcome to advance the refund sequence", () => {
    const nonCompleted: OrderSupportActivityOutcome[] = [
      { state: "auth-required" },
      { state: "binding-conflict" },
      { state: "failed" },
      { state: "input-required" },
      { state: "outcome-unknown" },
      { state: "rejected" },
      { state: "remote-canceled" },
    ];
    for (const outcome of nonCompleted) {
      expect(refundResultForOrderSupportOutcome(outcome).state).toBe("manual-reconciliation-required");
    }
    expect(refundResultForOrderSupportOutcome({ state: "completed", runId: "run_123" })).toEqual({
      state: "ready-for-deterministic-refund",
      auggyRunId: "run_123",
    });
  });
});
