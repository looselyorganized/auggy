import type { AugmentSummary } from "./types";

export interface AugmentPresentation {
  title: string;
  subtitle?: string;
  detail?: string;
}

/**
 * Turn runtime identifiers into operator-facing labels without hiding the
 * canonical augment type or instance name.
 */
export function presentAugment(augment: AugmentSummary): AugmentPresentation {
  const ownership = augment.memory?.ownership;
  const labels = ownership?.kind === "static" ? ownership.labels : [];
  // The fallback names keep a newer development console intelligible when it
  // is temporarily proxied to an older runtime that predates memory metadata.
  const isIdentityMemory =
    augment.type === "fileMemory" &&
    ((labels.includes("self") && augment.memory?.placement === "system") ||
      (augment.name === "identity" && augment.memory === undefined));
  const isLearnedBehaviorMemory =
    augment.type === "fileMemory" &&
    (labels.includes("learned") ||
      (augment.name === "fileMemory" && augment.memory === undefined));

  if (isIdentityMemory) {
    return {
      title: "Agent identity",
      subtitle: "fileMemory · self",
      detail: "Required, read-only system instructions",
    };
  }

  if (isLearnedBehaviorMemory) {
    return {
      title: "Learned behaviors",
      subtitle: "fileMemory · learned",
      detail: "Creator-approved, persistent operating guidance",
    };
  }

  const ownershipLabel = formatMemoryOwnership(augment);
  if (augment.name !== augment.type) {
    return {
      title: augment.name,
      subtitle: ownershipLabel ? `${augment.type} · ${ownershipLabel}` : `Type: ${augment.type}`,
    };
  }
  return {
    title: augment.type,
    ...(ownershipLabel ? { subtitle: ownershipLabel } : {}),
  };
}

export function formatMemoryOwnership(augment: AugmentSummary): string | undefined {
  const ownership = augment.memory?.ownership;
  if (!ownership) return undefined;
  if (ownership.kind === "namespace") return `${ownership.prefix} namespace`;
  if (ownership.labels.length === 0) return "static memory";
  return ownership.labels.join(", ");
}
