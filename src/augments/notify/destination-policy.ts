import type { NotifyRateLimitOptions } from "../../types";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project the non-secret Notify configuration used by cross-augment routing. */
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

/** Reject ambiguity in the agent-wide named Notify routing namespace. */
export function validateUniqueNotifyDestinationNames(
  bindings: readonly NotifyDestinationPolicyBinding[],
): void {
  const owners = new Map<string, string>();
  for (const binding of bindings) {
    const existing = owners.get(binding.destinationName);
    if (existing) {
      throw new Error(
        `notify destination "${binding.destinationName}" is declared by both "${existing}" and "${binding.augmentName}"; destination names must be unique across the agent`,
      );
    }
    owners.set(binding.destinationName, binding.augmentName);
  }
}
