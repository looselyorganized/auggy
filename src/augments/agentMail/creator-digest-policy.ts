import type {
  AgentMailCreatorDigestOptions,
  NotifyRateLimitOptions,
  TrustLevel,
} from "../../types";

export const AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS = 60_000;
export const AGENTMAIL_CREATOR_DIGEST_MAX_INTERVAL_MS = 24 * 60 * 60_000;
export const AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS = 20;
export const AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS = 100;
export const AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS = 5;
export const AGENTMAIL_CREATOR_DIGEST_MAX_ATTEMPTS = 20;

const CREATOR_DIGEST_FIELDS = new Set([
  "enabled",
  "destination",
  "intervalMs",
  "maxItems",
  "maxAttempts",
]);
const DEFAULT_NOTIFY_ALLOWED_TRUST_LEVELS: readonly TrustLevel[] = ["creator", "agent"];
const DEFAULT_NOTIFY_GLOBAL_MAX_PER_HOUR = 5;

export interface ResolvedAgentMailCreatorDigestConfig {
  enabled: boolean;
  destination?: string;
  intervalMs: number;
  maxItems: number;
  maxAttempts: number;
}

export interface NotifyDestinationPolicyBinding {
  augmentName: string;
  destinationName: string;
  allowedTrustLevels?: unknown;
  destinationMaxPerHour?: unknown;
  rateLimit?: NotifyRateLimitOptions | Record<string, unknown>;
}

export interface NotifyPolicySource {
  augmentName: string;
  destinations: unknown;
  rateLimit?: unknown;
}

export interface ResolvedCreatorDigestNotifyBinding {
  augmentName: string;
  destinationName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`agentMail: ${label} must be between ${minimum} and ${maximum}`);
  }
  return resolved;
}

/**
 * Validate and resolve the optional creator-digest block. This function is
 * shared by YAML parsing, setup preflight, resolver preflight, and the direct
 * AgentMail factory.
 */
export function resolveAgentMailCreatorDigestConfig(
  value: AgentMailCreatorDigestOptions | unknown,
  inboundMode: unknown,
): ResolvedAgentMailCreatorDigestConfig {
  if (value === undefined) {
    return {
      enabled: false,
      intervalMs: AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS,
      maxItems: AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS,
      maxAttempts: AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS,
    };
  }
  if (!isRecord(value)) {
    throw new Error("agentMail: inbound.creatorDigest must be an object");
  }
  for (const field of Object.keys(value)) {
    if (!CREATOR_DIGEST_FIELDS.has(field)) {
      throw new Error(
        `agentMail: unsupported inbound.creatorDigest field ${JSON.stringify(field)}`,
      );
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("agentMail: inbound.creatorDigest.enabled must be a boolean");
  }
  const enabled = value.enabled ?? false;

  let destination: string | undefined;
  if (value.destination !== undefined) {
    if (
      typeof value.destination !== "string" ||
      value.destination.length === 0 ||
      value.destination !== value.destination.trim() ||
      value.destination.length > 128 ||
      /\p{Cc}/u.test(value.destination)
    ) {
      throw new Error(
        "agentMail: inbound.creatorDigest.destination must be a non-empty Notify destination name without surrounding whitespace or control characters",
      );
    }
    destination = value.destination;
  }
  if (enabled && !destination) {
    throw new Error(
      "agentMail: inbound.creatorDigest.destination is required when creatorDigest is enabled",
    );
  }
  if (enabled && inboundMode === "none") {
    throw new Error(
      'agentMail: inbound.creatorDigest cannot be enabled when inbound.mode is "none"',
    );
  }

  return {
    enabled,
    ...(destination ? { destination } : {}),
    intervalMs: boundedInteger(
      value.intervalMs,
      AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS,
      AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS,
      AGENTMAIL_CREATOR_DIGEST_MAX_INTERVAL_MS,
      "inbound.creatorDigest.intervalMs",
    ),
    maxItems: boundedInteger(
      value.maxItems,
      AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS,
      1,
      AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS,
      "inbound.creatorDigest.maxItems",
    ),
    maxAttempts: boundedInteger(
      value.maxAttempts,
      AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS,
      1,
      AGENTMAIL_CREATOR_DIGEST_MAX_ATTEMPTS,
      "inbound.creatorDigest.maxAttempts",
    ),
  };
}

/**
 * Project the small, non-secret subset of Notify configuration needed for
 * cross-augment policy validation.
 */
export function collectNotifyDestinationPolicyBindings(
  sources: readonly NotifyPolicySource[],
): NotifyDestinationPolicyBinding[] {
  const bindings: NotifyDestinationPolicyBinding[] = [];
  for (const source of sources) {
    if (!Array.isArray(source.destinations)) {
      throw new Error(`notify augment "${source.augmentName}" destinations must be an array`);
    }
    for (const rawDestination of source.destinations) {
      if (!isRecord(rawDestination)) {
        throw new Error(
          `notify augment "${source.augmentName}" contains an invalid destination entry`,
        );
      }
      const name = rawDestination.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error(
          `notify augment "${source.augmentName}" contains a destination without a valid name`,
        );
      }
      if (rawDestination.rateLimit !== undefined && !isRecord(rawDestination.rateLimit)) {
        throw new Error(
          `notify destination "${name}" in augment "${source.augmentName}" has an invalid rateLimit policy`,
        );
      }
      const destinationRateLimit = isRecord(rawDestination.rateLimit)
        ? rawDestination.rateLimit
        : undefined;
      bindings.push({
        augmentName: source.augmentName,
        destinationName: name,
        ...(rawDestination.allowedTrustLevels !== undefined
          ? { allowedTrustLevels: rawDestination.allowedTrustLevels }
          : {}),
        ...(destinationRateLimit?.maxPerHour !== undefined
          ? { destinationMaxPerHour: destinationRateLimit.maxPerHour }
          : {}),
        ...(source.rateLimit !== undefined
          ? {
              rateLimit: isRecord(source.rateLimit) ? source.rateLimit : { enabled: "invalid" },
            }
          : {}),
      });
    }
  }
  return bindings;
}

/** Reject agent-wide ambiguity in the named Notify routing namespace. */
export function validateUniqueNotifyDestinationNames(
  bindings: readonly NotifyDestinationPolicyBinding[],
): void {
  const owners = new Map<string, string>();
  for (const binding of bindings) {
    if (owners.has(binding.destinationName)) {
      const existing = owners.get(binding.destinationName)!;
      throw new Error(
        `notify destination "${binding.destinationName}" is declared by both "${existing}" and "${binding.augmentName}"; destination names must be unique across the agent`,
      );
    }
    owners.set(binding.destinationName, binding.augmentName);
  }
}

/**
 * Resolve an enabled creator digest to one authorized and bounded Notify
 * destination. Disabled digests deliberately do not depend on Notify.
 */
export function resolveCreatorDigestNotifyBinding(
  digest: ResolvedAgentMailCreatorDigestConfig,
  bindings: readonly NotifyDestinationPolicyBinding[],
): ResolvedCreatorDigestNotifyBinding | undefined {
  if (!digest.enabled) return undefined;
  const matches = bindings.filter((binding) => binding.destinationName === digest.destination);
  if (matches.length === 0) {
    throw new Error(
      `agentMail creator digest destination "${digest.destination}" does not match any notify destination`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `agentMail creator digest destination "${digest.destination}" is ambiguous across notify augments`,
    );
  }

  const binding = matches[0]!;
  const configuredAllowed = binding.allowedTrustLevels;
  if (
    configuredAllowed !== undefined &&
    (!Array.isArray(configuredAllowed) ||
      configuredAllowed.length === 0 ||
      configuredAllowed.some(
        (level) => level !== "creator" && level !== "agent" && level !== "public",
      ))
  ) {
    throw new Error(
      `agentMail creator digest destination "${binding.destinationName}" has an invalid Notify authority policy`,
    );
  }
  const allowed = configuredAllowed ?? DEFAULT_NOTIFY_ALLOWED_TRUST_LEVELS;
  if (!allowed.includes("creator")) {
    throw new Error(
      `agentMail creator digest destination "${binding.destinationName}" must allow creator trust`,
    );
  }

  const rateLimit = binding.rateLimit;
  if (rateLimit?.enabled === false) {
    throw new Error(
      `agentMail creator digest destination "${binding.destinationName}" requires notify rateLimit.enabled to remain true`,
    );
  }
  if (rateLimit?.enabled !== undefined && rateLimit.enabled !== true) {
    throw new Error(
      `agentMail creator digest destination "${binding.destinationName}" has an invalid notify rateLimit.enabled policy`,
    );
  }
  const globalMaxPerHour = rateLimit?.globalMaxPerHour ?? DEFAULT_NOTIFY_GLOBAL_MAX_PER_HOUR;
  if (
    typeof globalMaxPerHour !== "number" ||
    !Number.isSafeInteger(globalMaxPerHour) ||
    globalMaxPerHour < 1
  ) {
    throw new Error(
      `agentMail creator digest destination "${binding.destinationName}" requires notify globalMaxPerHour to be a positive integer`,
    );
  }
  if (
    binding.destinationMaxPerHour !== undefined &&
    (typeof binding.destinationMaxPerHour !== "number" ||
      !Number.isSafeInteger(binding.destinationMaxPerHour) ||
      binding.destinationMaxPerHour < 1)
  ) {
    throw new Error(
      `agentMail creator digest destination "${binding.destinationName}" requires destination maxPerHour to be a positive integer`,
    );
  }

  return {
    augmentName: binding.augmentName,
    destinationName: binding.destinationName,
  };
}
