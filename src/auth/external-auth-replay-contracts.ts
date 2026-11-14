import type { RuntimeDataAdmission } from "../runtime-data-contracts";

/** Package-private managed replay constants; caller-owned stores are unchanged. */
export const EXTERNAL_AUTH_REPLAY_APPLICATION_ID = 0x45415250; // "EARP"
export const EXTERNAL_AUTH_REPLAY_SCHEMA_VERSION = 1;
export const EXTERNAL_AUTH_REPLAY_INVENTORY_SCHEMA = "EARP/v1";
export const EXTERNAL_AUTH_REPLAY_GUARD_VERSION = 1;
export const EXTERNAL_AUTH_REPLAY_GUARD_FILE = ".auggy-auth-replay-guard.json";
export const EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE = ".auggy-auth-replay-guard.pending";
/** Existing inventory v1 prerequisite for local, non-restorable control state. */
export const EXTERNAL_AUTH_REPLAY_GUARD_PREREQUISITE = "external-auth-replay-guard";
export const EXTERNAL_AUTH_REPLAY_MAX_GUARD_BYTES = 4 * 1024;
export const EXTERNAL_AUTH_REPLAY_MAX_UNEXPIRED_ENTRIES = 100_000;
export const EXTERNAL_AUTH_REPLAY_MAX_MANAGED_DATABASES = 10_000;
export const EXTERNAL_AUTH_REPLAY_MAX_JTI_SCALARS = 256;
export const EXTERNAL_AUTH_REPLAY_MAX_JTI_BYTES = 1_024;
export const EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
export const EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS = 30_000;
export const EXTERNAL_AUTH_REPLAY_MAX_RETRY_AFTER_SECONDS = 3_600;
export const EXTERNAL_AUTH_REPLAY_BUSY_TIMEOUT_MS = 5_000;

export type ReplayAvailability =
  | { readonly status: "ready"; readonly nowMs: number }
  | { readonly status: "held"; readonly retryAfterSeconds: number }
  | {
      readonly status: "unavailable";
      readonly reason: "clock" | "guard" | "storage";
    };

export type ManagedReplayClaim =
  | { readonly status: "consumed" }
  | { readonly status: "rejected"; readonly reason: "replay" | "expired" | "invalid" }
  | { readonly status: "held"; readonly retryAfterSeconds: number }
  | {
      readonly status: "unavailable";
      readonly reason: "clock" | "guard" | "storage" | "capacity";
    };

export interface ManagedReplayVerifiedInput {
  readonly audience: string;
  readonly jti: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Current verifier bound, never a remembered value from an earlier hold. */
  readonly maxTtlSeconds: number;
}

export interface ManagedExternalAuthReplayOptions {
  readonly admission: RuntimeDataAdmission;
  /** Already resolved once by the host; must remain inside the admitted root. */
  readonly dbPath: string;
  /** Complete configured managed-store inventory, resolved before any store opens. */
  readonly managedDbPaths: readonly string[];
  /** Explicit finite positive safe integer; validate startup timing arithmetic. */
  readonly maxTtlSeconds: number;
}

export interface ManagedExternalAuthReplay {
  /** Runs before any assertion-authorized response, including completed replay. */
  checkAvailability(maxTtlSeconds: number): Promise<ReplayAvailability>;
  /** Samples time and validates the claim inside the shared guard serialization. */
  consumeVerified(input: ManagedReplayVerifiedInput): Promise<ManagedReplayClaim>;
  /** Transport-owned; called after quiescence and before releasing root ownership. */
  close(): void;
}

export interface ExternalAuthReplayRestoreEpoch {
  /** Exact UUID from the verified copying restore fence. */
  readonly restoreId: string;
  /** Parsed fence time, preserved across every resume and reconciliation. */
  readonly restoredAtMs: number;
}

export interface ExternalAuthReplayGuardV1 {
  readonly version: typeof EXTERNAL_AUTH_REPLAY_GUARD_VERSION;
  readonly agentId: string;
  readonly latestRestore: ExternalAuthReplayRestoreEpoch | null;
  readonly highWaterMs: number;
}

/** Offline, pinned-root restore integration; never backed-up guard content. */
export interface ExternalAuthReplayRestoreGuardOptions {
  readonly agentId: string;
  readonly restore: ExternalAuthReplayRestoreEpoch;
}
