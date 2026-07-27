import type {
  DistributedBudgetCapsV1,
  DistributedBudgetPolicyV1,
  DistributedCoordinationBudgetConfig,
} from "../types";

const MAX_CAPACITY = 1_000_000;
const MAX_POLICIES = 16;
const MAX_RETENTION_MS = 31_536_000_000;
const MAX_RETENTION_DAYS = 3_650;
const MAX_USD = 1_000_000_000;
const MAX_THRESHOLDS = 16;
const MIN_DAILY_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DISTRIBUTED_BUDGET_COST_SCALE = 1_000_000_000n;
export const MAX_DISTRIBUTED_BUDGET_COST_USD = 1_000_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function integer(name: string, value: number, minimum: number, maximum = MAX_CAPACITY): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function money(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > Math.min(MAX_USD, MAX_DISTRIBUTED_BUDGET_COST_USD) ||
    !isCanonicalDistributedBudgetCostUsd(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function scaledDecimalCeiling(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > MAX_DISTRIBUTED_BUDGET_COST_USD) {
    throw new Error("distributed budget cost is invalid");
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) throw new Error("distributed budget cost is invalid");
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new Error("distributed budget cost is invalid");
  }
  const digits = BigInt(`${whole}${fraction}`);
  const decimalPlaces = fraction.length - exponent;
  const scalePlaces = 9;
  if (decimalPlaces <= scalePlaces) {
    return digits * 10n ** BigInt(scalePlaces - decimalPlaces);
  }
  const divisor = 10n ** BigInt(decimalPlaces - scalePlaces);
  const quotient = digits / divisor;
  return quotient + (digits % divisor === 0n ? 0n : 1n);
}

export function canonicalizeDistributedBudgetCostUsd(value: number): number {
  return Number(scaledDecimalCeiling(value)) / Number(DISTRIBUTED_BUDGET_COST_SCALE);
}

export function isCanonicalDistributedBudgetCostUsd(value: number): boolean {
  try {
    return canonicalizeDistributedBudgetCostUsd(value) === value;
  } catch {
    return false;
  }
}

export function distributedBudgetCostNanos(value: number): bigint {
  if (!isCanonicalDistributedBudgetCostUsd(value)) {
    throw new Error("distributed budget cost must use canonical nano-USD precision");
  }
  return scaledDecimalCeiling(value);
}

export function formatDistributedBudgetCostNanos(value: bigint): string {
  if (value < 0n) throw new Error("distributed budget cost is invalid");
  const whole = value / DISTRIBUTED_BUDGET_COST_SCALE;
  const fraction = (value % DISTRIBUTED_BUDGET_COST_SCALE).toString().padStart(9, "0");
  return `${whole}.${fraction}`;
}

export function parseDistributedBudgetCostNanos(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new Error("persisted distributed budget cost is invalid");
  if (match[1]!.length > 18) {
    throw new Error("persisted distributed budget cost exceeds database bounds");
  }
  const fraction = (match[2] ?? "").padEnd(12, "0");
  if (!/^\d{12}$/.test(fraction) || /[1-9]/.test(fraction.slice(9))) {
    throw new Error("persisted distributed budget cost exceeds nano-USD precision");
  }
  return BigInt(match[1]!) * DISTRIBUTED_BUDGET_COST_SCALE + BigInt(fraction.slice(0, 9));
}

function identifier(name: string, value: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function caps(name: string, value: DistributedBudgetCapsV1 | undefined) {
  if (value === undefined) return undefined;
  const normalized = {
    ...(money(`${name}.maxUsdPerDay`, value.maxUsdPerDay) === undefined
      ? {}
      : { maxUsdPerDay: value.maxUsdPerDay }),
    ...(value.maxTurnsPerThread === undefined
      ? {}
      : {
          maxTurnsPerThread: integer(`${name}.maxTurnsPerThread`, value.maxTurnsPerThread, 1),
        }),
    ...(value.maxTurnsPerDay === undefined
      ? {}
      : { maxTurnsPerDay: integer(`${name}.maxTurnsPerDay`, value.maxTurnsPerDay, 1) }),
  };
  return Object.keys(normalized).length === 0 ? undefined : Object.freeze(normalized);
}

export function normalizeDistributedBudgetPolicy(
  value: DistributedBudgetPolicyV1,
  terminalRequestRetentionMs?: number,
): DistributedBudgetPolicyV1 {
  const thresholds = [...(value.notifications?.thresholds ?? [])];
  if (
    thresholds.length > MAX_THRESHOLDS ||
    thresholds.some((threshold) => !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
  ) {
    throw new Error("budgets.notifications.thresholds is invalid");
  }
  const thresholdPpms = thresholds.map((threshold) => threshold * 1_000_000);
  if (thresholdPpms.some((threshold) => !Number.isSafeInteger(threshold))) {
    throw new Error("budgets.notifications.thresholds must use at most six decimal places");
  }
  thresholdPpms.sort((left, right) => left - right);
  if (new Set(thresholdPpms).size !== thresholdPpms.length) {
    throw new Error("budgets.notifications.thresholds must have unique ppm identities");
  }
  const normalizedThresholds = thresholdPpms.map((threshold) => threshold / 1_000_000);
  const reservationRetentionMs = integer(
    "budgets.reservationRetentionMs",
    value.reservationRetentionMs,
    MIN_DAILY_RESERVATION_RETENTION_MS,
    MAX_RETENTION_MS,
  );
  if (
    terminalRequestRetentionMs !== undefined &&
    reservationRetentionMs < terminalRequestRetentionMs
  ) {
    throw new Error("budget reservation retention cannot be shorter than request replay retention");
  }
  const aggregateRetentionDays = integer(
    "budgets.aggregateRetentionDays",
    value.aggregateRetentionDays,
    1,
    MAX_RETENTION_DAYS,
  );
  const maxThresholdIntents = integer(
    "budgets.maxThresholdIntents",
    value.maxThresholdIntents,
    normalizedThresholds.length === 0 ? 0 : 1,
  );
  if (maxThresholdIntents < normalizedThresholds.length * aggregateRetentionDays) {
    throw new Error("budget threshold intent capacity is smaller than its retention window");
  }
  const agent = caps("budgets.caps.agent", value.caps?.agent);
  const anonymous = caps("budgets.caps.public.anonymous", value.caps?.public?.anonymous);
  const recognized = caps("budgets.caps.public.recognized", value.caps?.public?.recognized);
  const normalized: DistributedBudgetPolicyV1 = {
    id: identifier("budgets.id", value.id),
    ...(agent || anonymous || recognized
      ? {
          caps: {
            ...(agent ? { agent } : {}),
            ...(anonymous || recognized
              ? {
                  public: {
                    ...(anonymous ? { anonymous } : {}),
                    ...(recognized ? { recognized } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(value.anonymousGlobalLimit === undefined
      ? {}
      : {
          anonymousGlobalLimit: integer(
            "budgets.anonymousGlobalLimit",
            value.anonymousGlobalLimit,
            1,
          ),
        }),
    ...(money("budgets.dailyBudgetUsd", value.dailyBudgetUsd) === undefined
      ? {}
      : { dailyBudgetUsd: value.dailyBudgetUsd }),
    ...(value.notifications === undefined
      ? {}
      : {
          notifications: {
            destination: identifier(
              "budgets.notifications.destination",
              value.notifications.destination,
            ),
            thresholds: Object.freeze(normalizedThresholds),
          },
        }),
    maxReservations: integer("budgets.maxReservations", value.maxReservations, 1),
    reservationRetentionMs,
    maxAnonymousEvents: integer(
      "budgets.maxAnonymousEvents",
      value.maxAnonymousEvents,
      value.anonymousGlobalLimit === undefined ? 0 : 1,
    ),
    maxPeerDays: integer("budgets.maxPeerDays", value.maxPeerDays, 1),
    maxThresholdIntents,
    aggregateRetentionDays,
  };
  if (
    normalized.anonymousGlobalLimit !== undefined &&
    normalized.maxAnonymousEvents < normalized.anonymousGlobalLimit
  ) {
    throw new Error("budget anonymous evidence cannot hold one complete window");
  }
  return Object.freeze(normalized);
}

export function normalizeDistributedBudgetConfig(
  value: DistributedCoordinationBudgetConfig | undefined,
  terminalRequestRetentionMs?: number,
): DistributedCoordinationBudgetConfig {
  const policies = [...(value?.policies ?? [])].map((policy) =>
    normalizeDistributedBudgetPolicy(policy, terminalRequestRetentionMs),
  );
  if (policies.length > MAX_POLICIES) throw new Error("distributed budget policies exceed bounds");
  policies.sort((left, right) => left.id.localeCompare(right.id));
  if (policies.some((policy, index) => policy.id === policies[index - 1]?.id)) {
    throw new Error("distributed budget policy ids must be unique");
  }
  return Object.freeze({ policies: Object.freeze(policies) });
}

export function distributedBudgetPolicyFingerprint(
  value: DistributedCoordinationBudgetConfig,
): string {
  return new Bun.CryptoHasher("sha256")
    .update("auggy-distributed-budget-policy-v1\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function sameDistributedBudgetPolicy(
  left: DistributedBudgetPolicyV1,
  right: DistributedBudgetPolicyV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveDistributedBudgetCaps(
  policy: DistributedBudgetPolicyV1,
  trustLevel: "agent" | "public",
  publicSubstate?: "anonymous" | "recognized",
): DistributedBudgetCapsV1 | undefined {
  if (trustLevel === "agent") return policy.caps?.agent;
  return publicSubstate === "recognized"
    ? policy.caps?.public?.recognized
    : policy.caps?.public?.anonymous;
}
