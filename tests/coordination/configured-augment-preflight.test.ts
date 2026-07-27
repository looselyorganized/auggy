import { describe, expect, test } from "bun:test";
import { BUILTIN_AUGMENT_TYPES, type AugmentConfig } from "../../src/cli/types";
import {
  BUILTIN_DISTRIBUTED_REQUIREMENTS,
  configuredAugmentReplicaEvidence,
} from "../../src/cli/distributed-coordination-preflight";

describe("configured augment distributed preflight evidence", () => {
  test("classifies every built-in exactly once from trusted source", () => {
    expect(Object.keys(BUILTIN_DISTRIBUTED_REQUIREMENTS)).toEqual([...BUILTIN_AUGMENT_TYPES]);
    expect(
      configuredAugmentReplicaEvidence(
        BUILTIN_AUGMENT_TYPES.map((type, index) => ({
          name: `built-in-${index}`,
          type,
        })),
      ),
    ).toEqual(
      BUILTIN_AUGMENT_TYPES.map((type, index) => ({
        augmentIndex: index,
        requirement: BUILTIN_DISTRIBUTED_REQUIREMENTS[type],
      })),
    );
  });

  test("defaults custom and unknown augment types to unverified blockers", () => {
    expect(
      configuredAugmentReplicaEvidence([
        { name: "custom", type: "custom", source: "./custom.ts" },
        { name: "hostile", type: "futureUnknown" } as unknown as AugmentConfig,
      ]),
    ).toEqual([
      { augmentIndex: 0, requirement: "custom-augment-unverified" },
      { augmentIndex: 1, requirement: "unknown-augment-type" },
    ]);
  });

  test("ignores operator options that claim a built-in is replica safe", () => {
    expect(
      configuredAugmentReplicaEvidence([
        {
          name: "budget",
          type: "budgets",
          options: { replicaSafety: "fence-aware", backend: "postgres" },
        },
      ]),
    ).toEqual([{ augmentIndex: 0, requirement: "shared-budget-store-missing" }]);
  });
});
