import type { Augment } from "../types";

// Package-owned closure evidence survives resolver shallow copies of an augment.
const proofs = new WeakMap<NonNullable<Augment["onShutdown"]>, () => boolean>();

export function registerCleanupProof(augment: Augment, closed: () => boolean): void {
  if (augment.onShutdown) proofs.set(augment.onShutdown, closed);
}

export function hasConfirmedCleanup(augment: Augment): boolean {
  if (!augment.onShutdown) return true;
  try {
    return proofs.get(augment.onShutdown)?.() === true;
  } catch {
    return false;
  }
}
