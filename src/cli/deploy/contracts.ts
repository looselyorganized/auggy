import { AUTHORING_LIMITS, type AuthoringDocument } from "../authoring/contracts";
import type { AugmentConfig, BuiltinAugmentType } from "../types";

/** CLI-private deployment contracts. They describe ingress, never an enabled graph. */
export type IngressSelection = "auto" | "none" | "http";

export interface NoIngressProfile {
  readonly kind: "none";
}

export interface HttpDeploymentProfile {
  readonly kind: "http";
  readonly port: number;
  readonly healthPath: string | null;
  readonly consolePath: "/console" | null;
}

export type DeploymentProfile = NoIngressProfile | HttpDeploymentProfile;

export interface ProfileSelection {
  /** CLI normalization supplies "auto" when the operator omits --ingress. */
  readonly ingress: IngressSelection;
  readonly port?: number;
  readonly healthPath?: string;
}

export interface DeploymentDiagnostic {
  readonly code: string;
  /** Controlled and bounded; never raw configuration, credentials or environment values. */
  readonly message: string;
}

export type ProfileEvidence = "known-config" | "operator-declared";

export interface ResolvedDeploymentProfile {
  readonly profile: DeploymentProfile;
  readonly selection: IngressSelection;
  readonly evidence: ProfileEvidence;
  readonly diagnostics: readonly DeploymentDiagnostic[];
}

/** Exhaustive, data-only classification of the built-in's own inbound listener. */
export const BUILTIN_INGRESS = Object.freeze({
  fileMemory: "none",
  supabaseMemory: "none",
  layeredMemory: "none",
  filesystem: "none",
  webTransport: "web",
  webFetch: "none",
  knowledge: "none",
  skills: "none",
  bash: "none",
  budgets: "none",
  notify: "none",
  mcp: "none",
  agentMail: "none",
  telegramTransport: "telegram",
  turnControl: "none",
  visitorAuth: "none",
  link: "link",
} as const satisfies Record<BuiltinAugmentType, "none" | "web" | "telegram" | "link">);

export interface DeploymentProfileOperations {
  resolveDeploymentProfile(
    document: AuthoringDocument,
    selection: ProfileSelection,
  ): ResolvedDeploymentProfile;
  /** Known resolved listeners must agree before runtime construction or hosted effects. */
  reconcileDeploymentProfile(profile: DeploymentProfile, augments: readonly AugmentConfig[]): void;
}

/** Existing Railway staging signature remains callable; return is an owned temp directory. */
export interface StageBundleOptions {
  readonly agentDir: string;
  readonly agentName: string;
  readonly excludedPaths?: readonly string[];
}

export interface ExportDockerOptions extends ProfileSelection {
  readonly name?: string;
  readonly config?: string;
  readonly cwd?: string;
  readonly out: string;
}

export interface ExportDockerResult {
  readonly outputDir: string;
  readonly profile: DeploymentProfile;
  readonly manifestPath: string;
  readonly fileCount: number;
  readonly sourceBytes: number;
  /** Export performs no install or image build. */
  readonly buildVerified: false;
}

export interface PortableExportOperations {
  stageBundle(options: StageBundleOptions): string;
  exportDocker(options: ExportDockerOptions): Promise<ExportDockerResult>;
}

export const DEPLOYMENT_FILES = Object.freeze({
  dockerfile: "Dockerfile",
  entrypoint: "auggy-entrypoint.sh",
  manifest: "auggy-deployment.json",
  packageManifest: "package.json",
  lockfile: "bun.lock",
} as const);

export const DEPLOYMENT_MANIFEST_ENV = "AUGGY_DEPLOYMENT_MANIFEST";

/** Verified multi-architecture image; preserve its inherited UID/GID 0 without a USER directive. */
export const DEPLOYMENT_TOOLCHAIN = Object.freeze({
  bunVersion: "1.3.14",
  image: "oven/bun:1.3.14-alpine",
  imageDigest: "sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0",
} as const);

export interface DeploymentFileDigest {
  /** Canonical, contained project-relative slash path; never an absolute source path. */
  readonly path: string;
  /** Lowercase SHA-256 of the exact staged bytes. */
  readonly sha256: string;
  readonly bytes: number;
  /** Ordinary output file permission bits (0..0777), without file-type bits. */
  readonly mode: number;
}

/** Descriptive build input, not a signature, runtime graph or proof that an image ran. */
export interface DeploymentManifestV1 {
  readonly version: 1;
  readonly agentId: string;
  readonly agentName: string;
  readonly configPath: string;
  readonly profile: DeploymentProfile;
  readonly selection: IngressSelection;
  readonly evidence: ProfileEvidence;
  readonly toolchain: typeof DEPLOYMENT_TOOLCHAIN;
  readonly packageJsonSHA256: string;
  readonly lockfileSHA256: string;
  /** Includes package.json and bun.lock; excludes dependency archives and generated files. */
  readonly sourceFiles: readonly DeploymentFileDigest[];
  readonly dependencyTarballs: readonly DeploymentFileDigest[];
  /** Dockerfile and entrypoint only; the manifest never includes its own digest. */
  readonly generatedFiles: readonly DeploymentFileDigest[];
}

export interface DeploymentManifestExpectation {
  readonly agentId: string;
  readonly agentName: string;
  /** Actual selected config relative to the prepared project root. */
  readonly configPath: string;
}

export interface DeploymentManifestOperations {
  /** Root-owned runtime reader also requires an ordinary contained file and bounded bytes. */
  readDeploymentManifest(
    path: string,
    projectDir: string,
    expected: DeploymentManifestExpectation,
  ): DeploymentManifestV1;
}

interface CloudTargetIdentity {
  readonly agentId: string;
  readonly provider: "railway";
  readonly projectId: string;
  readonly serviceId: string;
  readonly volumeId: string;
  readonly deployedAt: string;
}

/** Validated legacy disk shape. Unversioned or unbound JSON is not a CloudRecordV1. */
export interface CloudRecordV1 extends CloudTargetIdentity {
  readonly version: 1;
  readonly url: string;
}

export type CloudIngressBinding =
  | { readonly profile: NoIngressProfile; readonly url: null }
  | { readonly profile: HttpDeploymentProfile; readonly url: string };

export type CloudRecordV2 = CloudTargetIdentity & CloudIngressBinding & { readonly version: 2 };

export type PersistedCloudRecord = CloudRecordV1 | CloudRecordV2;

/** Root reuses this union in src/cli/types.ts; invalid/unreadable data is handled separately. */
export type CloudRecord = PersistedCloudRecord | null;

/** In-memory read view; normalization never rewrites the record on disk. */
export type NormalizedCloudDeployment = CloudTargetIdentity &
  CloudIngressBinding & { readonly recordVersion: 1 | 2 };

export const LEGACY_HTTP_PROFILE: Readonly<HttpDeploymentProfile> = Object.freeze({
  kind: "http",
  port: 8080,
  healthPath: "/health",
  consolePath: "/console",
});

export interface CloudRecordOperations {
  /** Missing files are handled by the caller; invalid input throws instead of becoming null. */
  validateCloudRecord(value: unknown, expectedAgentId: string): PersistedCloudRecord;
  normalizeCloudRecord(record: PersistedCloudRecord): NormalizedCloudDeployment;
}

export type HealthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** health.ts imports and re-exports these types when M5-03 implements bounded polling. */
export interface HealthCheckOptions {
  readonly fetch?: HealthFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly healthPath?: string;
  readonly requestTimeoutMs?: number;
}

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly url: string;
  readonly attempts: number;
  readonly status?: number;
  /** Controlled diagnostic only; never response bodies or raw fetch exceptions. */
  readonly error?: string;
}

export interface HealthCheckOperations {
  waitForHealth(baseUrl: string, options?: HealthCheckOptions): Promise<HealthCheckResult>;
}

export type DeploymentHttpReadiness =
  | { readonly state: "not-applicable"; readonly reason: "no-ingress" }
  | { readonly state: "not-configured"; readonly reason: "no-health-path" }
  | { readonly state: "not-checked"; readonly reason: "check-disabled" }
  | { readonly state: "not-attempted"; readonly reason: "platform-not-ready" }
  | {
      readonly state: "ready" | "failed" | "timed-out";
      readonly result: HealthCheckResult;
    };

interface DeploymentReadinessObservations {
  readonly http: DeploymentHttpReadiness;
  /** Only the separately authorized acceptance harness proves a channel turn. */
  readonly channel: { readonly state: "unverified" };
}

export type DeploymentReadiness = DeploymentReadinessObservations &
  (
    | {
        readonly platform: "ready" | "failed" | "timed-out";
        readonly platformReason?: never;
      }
    | {
        readonly platform: "unverified";
        readonly platformReason: "wait-disabled" | "status-unavailable";
      }
  );

/** Future deploy result preserves target IDs and makes the lack of an HTTP probe explicit. */
export type ProfileAwareDeployResult = CloudIngressBinding & {
  readonly name: string;
  readonly projectId: string;
  readonly serviceId: string;
  readonly volumeId: string;
  readonly readiness: DeploymentReadiness;
  readonly health: HealthCheckResult | null;
};

export const DEPLOYMENT_LIMITS = Object.freeze({
  documentBytes: AUTHORING_LIMITS.documentBytes,
  metadataBytes: AUTHORING_LIMITS.metadataBytes,
  aggregateInputBytes: AUTHORING_LIMITS.aggregateInputBytes,
  packageManifestBytes: 1_048_576,
  lockfileBytes: 16_777_216,
  pathBytes: 1_024,
  directoryDepth: 64,
  visitedEntries: 10_000,
  regularFileBytes: 268_435_456,
  stagedSourceBytes: 1_073_741_824,
  archiveExpandedBytes: 536_870_912,
  aggregateArchiveExpandedBytes: 1_073_741_824,
  archiveEntries: 10_000,
  archiveManifestBytes: 1_048_576,
  deploymentManifestBytes: 4_194_304,
  cloudRecordBytes: 65_536,
  cloudIdentifierBytes: 256,
  healthPathBytes: 2_048,
  diagnosticBytes: 1_024,
  diagnostics: AUTHORING_LIMITS.diagnostics,
} as const);

export const DEPLOYMENT_READINESS_DEFAULTS = Object.freeze({
  healthTimeoutMs: 90_000,
  healthRequestTimeoutMs: 5_000,
  healthIntervalMs: 3_000,
  railwayTimeoutMs: 600_000,
  railwayIntervalMs: 5_000,
  railwayStatusRequestTimeoutMs: 15_000,
  railwayStatusOutputBytes: 1_048_576,
} as const);
