import type { Augment } from "../types";
import type { MemoryRegistry } from "./types";

/** Filter an augment list to only those that declare a memory provider. */
export function getMemoryProviders(augments: Augment[]): Augment[] {
  return augments.filter((a) => a.memory !== undefined);
}

/**
 * Build a label → provider registry from the memory providers in an
 * augment list. Throws on any label or namespace conflict.
 */
export function buildRegistry(providers: Augment[]): MemoryRegistry {
  const registry: MemoryRegistry = {
    static: new Map(),
    namespaces: [],
  };

  for (const aug of providers) {
    const spec = aug.memory!;
    if (spec.owns.kind === "static") {
      for (const label of spec.owns.labels) {
        if (registry.static.has(label)) {
          const existing = registry.static.get(label)!;
          throw new Error(
            `Memory label conflict: "${label}" is owned by both "${existing.name}" and "${aug.name}"`,
          );
        }
        registry.static.set(label, aug);
      }
    } else {
      registry.namespaces.push({ prefix: spec.owns.prefix, augment: aug });
    }
  }

  // Validate namespace prefixes don't overlap
  for (let i = 0; i < registry.namespaces.length; i++) {
    for (let j = i + 1; j < registry.namespaces.length; j++) {
      const a = registry.namespaces[i]!;
      const b = registry.namespaces[j]!;
      if (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) {
        throw new Error(
          `Memory namespace conflict: "${a.prefix}" (${a.augment.name}) overlaps with "${b.prefix}" (${b.augment.name})`,
        );
      }
    }
  }

  // Validate static labels don't fall under any namespace prefix
  for (const [label, staticAug] of registry.static) {
    for (const { prefix, augment: nsAug } of registry.namespaces) {
      if (label.startsWith(prefix)) {
        throw new Error(
          `Memory label conflict: static label "${label}" (${staticAug.name}) falls under namespace "${prefix}" (${nsAug.name})`,
        );
      }
    }
  }

  return registry;
}

/**
 * Look up which provider owns a given label. Static labels win over namespaces.
 * Returns null if no provider owns the label.
 */
export function lookupProvider(
  registry: MemoryRegistry,
  label: string,
): Augment | null {
  const staticOwner = registry.static.get(label);
  if (staticOwner) return staticOwner;

  let match: Augment | null = null;
  let longestPrefix = "";
  for (const { prefix, augment } of registry.namespaces) {
    if (label.startsWith(prefix) && prefix.length > longestPrefix.length) {
      match = augment;
      longestPrefix = prefix;
    }
  }
  return match;
}
