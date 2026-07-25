import { describe, expect, test } from "bun:test";
import {
  PROCESS_LOCAL_COORDINATION_TOPOLOGY,
  enumerateDistributedCoordinationBlockers,
} from "../../src/coordination/topology";

describe("distributed coordination topology preflight contract", () => {
  test("enumerates every current process-local blocker", () => {
    expect(enumerateDistributedCoordinationBlockers()).toEqual([
      "process-local-turn-scheduler",
      "process-local-thread-serialization",
      "unfenced-thread-history",
      "process-local-idempotency-store",
      "process-local-quarantine-and-health",
    ]);
  });

  test("reports no blockers only for a fully shared, fenced topology", () => {
    expect(
      enumerateDistributedCoordinationBlockers({
        ...PROCESS_LOCAL_COORDINATION_TOPOLOGY,
        turnScheduler: "shared-fenced",
        threadSerialization: "shared-fenced",
        threadHistory: "fenced",
        idempotency: "shared",
        quarantineAndHealth: "shared",
      }),
    ).toEqual([]);
  });
});
