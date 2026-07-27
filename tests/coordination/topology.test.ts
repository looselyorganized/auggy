import { describe, expect, test } from "bun:test";
import {
  assertDistributedCoordinationStartupAllowed,
  distributedCoordinationPreflightReport,
  enumerateDistributedCoordinationBlockers,
} from "../../src/coordination/topology";

describe("distributed coordination topology preflight contract", () => {
  test("enumerates every current process-local blocker", () => {
    expect(enumerateDistributedCoordinationBlockers()).toEqual([
      "process-local-fleet-admission",
      "process-local-thread-serialization",
      "unfenced-thread-history",
      "process-local-idempotency-store",
      "process-local-quarantine-and-health",
      "process-local-mutable-stores",
      "unfenced-delivery-outbox",
    ]);
  });

  test("reports the disabled profile without reading configuration values", () => {
    expect(
      distributedCoordinationPreflightReport({
        augmentEvidence: [{ augmentIndex: 0, requirement: "shared-budget-store-missing" }],
      }),
    ).toEqual({
      profile: "disabled",
      ready: false,
      blockers: [
        "runtime-not-enabled",
        "process-local-fleet-admission",
        "process-local-thread-serialization",
        "unfenced-thread-history",
        "process-local-idempotency-store",
        "process-local-quarantine-and-health",
        "process-local-mutable-stores",
        "unfenced-delivery-outbox",
        "configured-augment-state-unverified",
      ],
      components: [{ augmentIndex: 0, requirement: "shared-budget-store-missing" }],
    });
  });

  test("sanitizes malformed caller evidence to bounded code-owned vocabulary", () => {
    const report = distributedCoordinationPreflightReport({
      augmentEvidence: [
        {
          augmentIndex: -1,
          requirement: "postgres://sentinel-secret@example.invalid" as never,
        },
      ],
    });

    expect(report.components).toEqual([
      { augmentIndex: 0, requirement: "runtime-augment-unverified" },
    ]);
    expect(JSON.stringify(report)).not.toContain("sentinel-secret");
  });

  test("does not let caller-supplied topology claims erase runtime blockers", () => {
    const hostileCall = enumerateDistributedCoordinationBlockers as unknown as (
      topology: Record<string, string>,
    ) => string[];

    expect(
      hostileCall({
        fleetAdmission: "shared-fenced",
        threadSerialization: "shared-fenced",
        threadHistory: "fenced",
        idempotency: "shared",
        quarantineAndHealth: "shared",
        mutableStores: "shared-fenced",
        delivery: "shared-outbox",
      }),
    ).toEqual([
      "process-local-fleet-admission",
      "process-local-thread-serialization",
      "unfenced-thread-history",
      "process-local-idempotency-store",
      "process-local-quarantine-and-health",
      "process-local-mutable-stores",
      "unfenced-delivery-outbox",
    ]);
  });

  test("allows local startup and emits secret-free distributed errors", () => {
    expect(() => assertDistributedCoordinationStartupAllowed(undefined)).not.toThrow();

    const hostileConfig = {
      urlEnv: "SENTINEL_COORDINATION_SECRET_ENV",
      url: "postgres://sentinel-secret@example.invalid/database",
    };
    expect(() => assertDistributedCoordinationStartupAllowed(hostileConfig)).toThrow(
      "runtime-not-enabled",
    );
    try {
      assertDistributedCoordinationStartupAllowed(hostileConfig);
    } catch (error) {
      expect(String(error)).not.toContain("SENTINEL_COORDINATION_SECRET_ENV");
      expect(String(error)).not.toContain("sentinel-secret");
    }
  });
});
