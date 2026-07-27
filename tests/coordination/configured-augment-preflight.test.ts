import { describe, expect, test } from "bun:test";
import { BUILTIN_AUGMENT_TYPES, type AugmentConfig } from "../../src/cli/types";
import {
  BUILTIN_REPLICA_TOPOLOGY,
  configuredAugmentReplicaEvidence,
} from "../../src/cli/distributed-coordination-preflight";

const expectedDefinitions = {
  fileMemory: ["unsupported", "local-mutable-state"],
  supabaseMemory: ["shared", "shared-store-unverified"],
  layeredMemory: ["shared", "shared-store-unverified"],
  filesystem: ["unsupported", "local-filesystem-unverified"],
  webTransport: ["shared", "shared-web-state-missing"],
  webFetch: ["stateless", "stateless-verifier-missing"],
  knowledge: ["stateless", "immutable-assets-unverified"],
  skills: ["stateless", "immutable-assets-unverified"],
  bash: ["unsupported", "local-effects-unverified"],
  budgets: ["fence-aware", "shared-budget-store-missing"],
  notify: ["fence-aware", "shared-delivery-store-missing"],
  mcp: ["unsupported", "mcp-topology-unverified"],
  agentMail: ["leader-owned", "shared-inbound-store-missing"],
  telegramTransport: ["leader-owned", "shared-replay-store-missing"],
  turnControl: ["stateless", "stateless-verifier-missing"],
  visitorAuth: ["shared", "shared-session-store-missing"],
  link: ["shared", "shared-link-store-missing"],
} as const;

describe("configured augment distributed preflight evidence", () => {
  test("classifies every built-in through one source-owned verifier", () => {
    expect(Object.isFrozen(BUILTIN_AUGMENT_TYPES)).toBe(true);
    expect(Object.isFrozen(BUILTIN_REPLICA_TOPOLOGY)).toBe(true);
    expect(Object.keys(BUILTIN_REPLICA_TOPOLOGY)).toEqual([...BUILTIN_AUGMENT_TYPES]);
    for (const type of BUILTIN_AUGMENT_TYPES) {
      const definition = BUILTIN_REPLICA_TOPOLOGY[type];
      expect(Object.isFrozen(definition)).toBe(true);
      expect(definition.componentType).toBe(type);
      expect(definition.topologyClass).toBe(expectedDefinitions[type][0]);
      expect(definition.compatibilityVersion).toBe(1);
      expect(definition.compatibilityIdentity({ name: type, type })).toBe(
        `builtin:${type}:blocked:v1`,
      );
      expect(typeof definition.verify).toBe("function");
      const requirements = definition.verify({ name: type, type });
      expect(Object.isFrozen(requirements)).toBe(true);
      expect(requirements).toEqual([expectedDefinitions[type][1]]);
    }

    const evidence = configuredAugmentReplicaEvidence(
      BUILTIN_AUGMENT_TYPES.map((type, index) => ({
        name: `built-in-${index}`,
        type,
      })),
    );
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(evidence).toEqual(
      BUILTIN_AUGMENT_TYPES.map((type, augmentIndex) => ({
        augmentIndex,
        componentType: type,
        topologyClass: expectedDefinitions[type][0],
        compatibilityVersion: 1,
        semanticFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requirements: [expectedDefinitions[type][1]],
      })),
    );
    expect(new Set(evidence.map((entry) => entry.semanticFingerprint)).size).toBe(
      BUILTIN_AUGMENT_TYPES.length,
    );
  });

  test("defaults custom and unknown augment types to unsupported blockers", () => {
    expect(
      configuredAugmentReplicaEvidence([
        { name: "custom", type: "custom", source: "./custom.ts" },
        { name: "hostile", type: "futureUnknown" } as unknown as AugmentConfig,
      ]),
    ).toEqual([
      {
        augmentIndex: 0,
        componentType: "custom",
        topologyClass: "unsupported",
        compatibilityVersion: 1,
        semanticFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requirements: ["custom-augment-unverified"],
      },
      {
        augmentIndex: 1,
        componentType: "unknown",
        topologyClass: "unsupported",
        compatibilityVersion: 1,
        semanticFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requirements: ["unknown-augment-type"],
      },
    ]);
  });

  test("ignores operator topology and backend claims", () => {
    expect(
      configuredAugmentReplicaEvidence([
        {
          name: "budget",
          type: "budgets",
          options: {
            replicaSafety: "fence-aware",
            topologyClass: "stateless",
            verifier: "passed",
            backend: "postgres",
          },
        },
      ]),
    ).toEqual([
      {
        augmentIndex: 0,
        componentType: "budgets",
        topologyClass: "fence-aware",
        compatibilityVersion: 1,
        semanticFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requirements: ["shared-budget-store-missing"],
      },
    ]);
  });

  test("rejects oversized evidence instead of truncating an unsafe tail", () => {
    const augments = Array.from({ length: 257 }, (_, index) => ({
      name: `augment-${index}`,
      type: "webFetch" as const,
    }));
    augments[256] = { name: "unsafe-tail", type: "webFetch" };

    expect(() => configuredAugmentReplicaEvidence(augments)).toThrow(
      "configured augment topology exceeds supported bounds",
    );
  });

  test("fails closed with fixed evidence when configured input access throws", () => {
    const hostile = Object.defineProperty({}, "type", {
      get() {
        throw new Error("SENTINEL_TOPOLOGY_SECRET");
      },
    }) as AugmentConfig;

    const evidence = configuredAugmentReplicaEvidence([hostile]);
    expect(evidence).toEqual([
      {
        augmentIndex: 0,
        componentType: "runtime",
        topologyClass: "unsupported",
        compatibilityVersion: 1,
        semanticFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        requirements: ["runtime-augment-unverified"],
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain("SENTINEL_TOPOLOGY_SECRET");
  });

  test("sanitizes hostile outer-array access without exposing thrown values", () => {
    const hostile = new Proxy([] as AugmentConfig[], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("SENTINEL_ARRAY_SECRET");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => configuredAugmentReplicaEvidence(hostile)).toThrow(
      "configured augment topology cannot be verified",
    );
    try {
      configuredAugmentReplicaEvidence(hostile);
    } catch (error) {
      expect(String(error)).not.toContain("SENTINEL_ARRAY_SECRET");
    }

    const invalidLength = new Proxy([] as AugmentConfig[], {
      get(target, property, receiver) {
        if (property === "length") return -1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => configuredAugmentReplicaEvidence(invalidLength)).toThrow(
      "configured augment topology exceeds supported bounds",
    );
  });
});
