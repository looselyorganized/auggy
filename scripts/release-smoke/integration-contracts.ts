import type { DeploymentProfile } from "../../src/cli/deploy/contracts";

export const INTEGRATION_LIMITS = Object.freeze({
  readinessMs: 60_000,
  readinessRequestMs: 5_000,
  scenarioMs: 120_000,
  shutdownMs: 15_000,
  reapMs: 5_000,
  outputBytes: 2 * 1024 * 1024,
  fixtureRequestBytes: 256 * 1024,
  fixtureEvents: 1_000,
  fixtureJournalBytes: 2 * 1024 * 1024,
  evidenceBytes: 4 * 1024 * 1024,
  browserNavigationMs: 30_000,
  fixtureRequestMs: 10_000,
  phaseBuildMs: 10 * 60_000,
} as const);

/** Only these explicit fixture overlays may change the generated inputs. */
export const INTEGRATION_OVERLAYS = Object.freeze({
  telegramNetwork: "src/fixtures/telegram-network.ts",
  telegramStartup: "src/index.ts",
  applicationSessionAdapter: "src/server/session-adapter.ts",
} as const);

export type IntegrationStage = "local" | "container" | "hosted";
export const CONTAINER_STORAGE_SCENARIO = "container-storage-recovery";
export const TELEGRAM_CONTAINER_SCENARIO = "telegram-polling-container";
export type IntegrationBuildKind = "production-reference" | "fixture-auth" | "standalone-fixture";

export interface HashedIntegrationFile {
  /** A project/evidence-relative ordinary path, never a secret or checkout path. */
  path: string;
  sha256: string;
}

export interface IntegrationSourceIdentity {
  revision: string;
  tree: string;
  sourceChangesSHA256: string;
  bunVersion: string;
  lockfiles: readonly HashedIntegrationFile[];
  packedPackages: readonly HashedIntegrationFile[];
  installedFiles: readonly HashedIntegrationFile[];
}

export type IntegrationOutcome =
  | { status: "passed"; checks: readonly string[] }
  | { status: "failed" | "unavailable" | "not-run"; reason: string };

/** Runtime validation enforces bounds/redaction in addition to this wire shape. */
export interface IntegrationScenarioEvidence {
  version: 1;
  scenarioId: string;
  runId: string;
  stage: IntegrationStage;
  buildKind: IntegrationBuildKind;
  source: IntegrationSourceIdentity;
  profile: DeploymentProfile;
  baselineFiles: readonly HashedIntegrationFile[];
  changes: readonly {
    path: string;
    kind: "fixture-overlay" | "source-edit" | "dependency-materialization";
    beforeSHA256: string | null;
    afterSHA256: string;
  }[];
  execution: {
    /** Static descriptions only; tokens, cookies and environment values are excluded. */
    commandLabels: readonly string[];
    deadlinesMs: Readonly<Record<string, number>>;
    firstChunkBeforeTerminal: boolean | null;
    effectCount: number;
    duplicateEffectCount: number;
    unauthorizedEffectCount: number;
    startup: "ready" | "failed" | "not-run";
    channel: "verified" | "failed" | "unverified";
    observations: readonly string[];
  };
  platform: {
    exportSHA256: string | null;
    imageDigest: string | null;
    deploymentId: string | null;
    /** Only identifiers owned by this run. No credentials or URLs with userinfo. */
    resources: readonly { kind: string; id: string }[];
  };
  outcome: IntegrationOutcome;
  cleanup: { status: "complete" | "failed" | "not-needed"; remainingOwnedIds: readonly string[] };
  artifacts: readonly HashedIntegrationFile[];
  retainedUntil: string | null;
  independentReviewer: string | null;
}
