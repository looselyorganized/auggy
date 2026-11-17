import type { ApplicationLaunch } from "./types";

/** Package-private storage policy; a pathname never selects platform trust. */
export type RuntimeDataPlatform = "generic" | "railway";

export const RAILWAY_RUNTIME_DATA_ROOT = "/app/data";

export interface RuntimeDataEnvironment {
  readonly auggyDataDir: string | undefined;
  readonly railwayVolumeMountPath: string | undefined;
}

export type RuntimeDataSelection =
  | { readonly kind: "local" }
  | { readonly kind: "explicit"; readonly runtimeDataRoot: string }
  | { readonly kind: "railway"; readonly runtimeDataRoot: typeof RAILWAY_RUNTIME_DATA_ROOT };

export type SelectRuntimeDataRoot = (
  mode: ApplicationLaunch["mode"],
  environment: RuntimeDataEnvironment,
) => RuntimeDataSelection;

declare const runtimeDataAdmissionBrand: unique symbol;

/**
 * Package-private capability issued only after identity and singleton admission.
 * A private live-lease registry, not this type brand or these strings, establishes
 * authority. Never expose a root descriptor or accept a structurally similar object.
 */
export interface RuntimeDataAdmission {
  readonly [runtimeDataAdmissionBrand]: true;
  readonly runtimeDataRoot: string;
  readonly agentId: string;
}

/** The production lease retains its pinned root and singleton until release. */
export interface AdmittedRuntimeVolumeLease {
  readonly runtimeDataRoot: string;
  readonly runtimeDataAdmission: RuntimeDataAdmission;
  /** Idempotent; invalidate admission before closing owned descriptors. */
  release(): void;
}

/** Shared host ownership; unset local storage has no data-root capability. */
export interface RuntimeDataOwnership {
  readonly platform: RuntimeDataPlatform;
  readonly runtimeDataRoot?: string;
  readonly runtimeDataAdmission?: RuntimeDataAdmission;
  release(): void;
}

/**
 * Package-private synchronous borrowing seam for descriptor-relative operations.
 * Validate live registry membership and configured/canonical path identity against
 * the pinned directory before entering the callback. The callback must not close,
 * retain or asynchronously use the borrowed descriptor. The implementation also
 * rejects thenable results; types cannot secure an any/unknown cast or trusted
 * callback that already scheduled asynchronous work. The callback owns no lease.
 */
export type WithRuntimeDataAdmission = <T>(
  admission: RuntimeDataAdmission,
  operation: (rootFd: number) => T extends PromiseLike<unknown> ? never : T,
) => T;
