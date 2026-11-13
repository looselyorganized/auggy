/** CLI-private authoring contracts. Raw documents/plans can contain secrets: never render them. */
export type RawValue = null | boolean | number | string | readonly RawValue[] | RawRecord;

export interface RawRecord {
  readonly [key: string]: RawValue;
}

export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface MissingFileSnapshot {
  readonly path: string;
  readonly exists: false;
}

export interface ExistingFileSnapshot {
  readonly path: string;
  readonly exists: true;
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export type FileSnapshot = MissingFileSnapshot | ExistingFileSnapshot;

export interface AuthoringDeclaration {
  readonly index: number;
  readonly name: string | null;
  readonly type: string;
  readonly raw: RawRecord;
  readonly source?: string;
  readonly options?: RawValue;
  readonly origin: {
    readonly kind: "inline" | "referenced";
    readonly path: string;
    readonly pointer: string;
    readonly sourceBaseDir: string;
  };
  readonly environmentNames: readonly string[];
}

export interface AuthoringDocument {
  readonly projectDir: string;
  readonly configPath: string;
  readonly format: "inline" | "referenced" | "mixed";
  readonly config: ExistingFileSnapshot;
  readonly inputs: readonly FileSnapshot[];
  readonly value: RawRecord;
  readonly declarations: readonly AuthoringDeclaration[];
}

export interface PlannedFile {
  readonly relativePath: string;
  readonly before: FileSnapshot;
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly role: "support" | "activation" | "ignore" | "new-env";
}

export type MutationKind =
  | "init"
  | "augment-add"
  | "augment-create"
  | "augment-install"
  | "augment-remove"
  | "agentmail-config"
  | "migrate";

export interface SafeChangeSummary {
  readonly path: string;
  readonly operation: "create" | "replace";
  /** Controlled explanation, never arbitrary option/credential values. */
  readonly reason: string;
}

export interface SafeDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly field?: string;
  /** Controlled, bounded message; no original parser error/cause. */
  readonly message: string;
}

export interface MutationPlanInput {
  readonly kind: MutationKind;
  readonly projectDir: string;
  readonly configRelativePath: string;
  readonly inputs: readonly FileSnapshot[];
  readonly files: readonly PlannedFile[];
  readonly summary: readonly SafeChangeSummary[];
}

export interface MutationPlan extends MutationPlanInput {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
}

export interface ApplicationDeclaration {
  readonly entrypoint: string;
  readonly contractVersion: 1;
}

export type DocumentEdit =
  | {
      readonly kind: "append-augment";
      readonly entry: RawRecord;
    }
  | {
      readonly kind: "remove-augment";
      readonly name: string;
    }
  | {
      readonly kind: "set-augment-options";
      readonly name: string;
      readonly options: RawValue;
    }
  | {
      readonly kind: "set-application";
      readonly application: ApplicationDeclaration;
    }
  | {
      readonly kind: "inline-references";
    };

declare const projectMutationLeaseBrand: unique symbol;

export interface ProjectMutationLease {
  readonly projectDir: string;
  readonly [projectMutationLeaseBrand]: true;
  release(): void;
}

export type PublicationBoundary =
  | "before-ignore"
  | "after-ignore"
  | "before-first-backup"
  | "prepared"
  | "before-file"
  | "after-file"
  | "after-activation"
  | "before-complete"
  | "before-rollback-file"
  | "after-rollback-file"
  | "before-sensitive-cleanup"
  | "after-sensitive-cleanup";

export type PublicationFaultHook = (event: {
  readonly boundary: PublicationBoundary;
  readonly operationId: string;
  readonly path?: string;
}) => void;

export interface PublicationOptions {
  readonly lease?: ProjectMutationLease;
  /** Explicit test injection only; never selected by env or CLI flags. */
  readonly fault?: PublicationFaultHook;
}

export interface PublicationResult {
  readonly status: "complete" | "rolled-back" | "recovery-required";
  /** Guarded observation of central YAML, independent of overall cleanup status. */
  readonly activation: "original" | "output" | "unknown";
  readonly operationId: string;
  readonly changedPaths: readonly string[];
  readonly diagnostics: readonly SafeDiagnostic[];
}

export type ReceiptPhase =
  | "preparing"
  | "prepared"
  | "publishing"
  | "activated"
  | "complete"
  | "rolling-back"
  | "rolled-back"
  | "conflicted";

export interface ReceiptFileVersion {
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

export interface ReceiptStep {
  readonly relativePath: string;
  readonly role: PlannedFile["role"];
  readonly before:
    | (ReceiptFileVersion & {
        readonly backupPath: string;
      })
    | null;
  readonly after: ReceiptFileVersion & {
    readonly stagePath: string;
  };
  readonly published: boolean;
  readonly rollbackComplete: boolean;
  /** Where known, used alongside bytes to verify created-file ownership. */
  readonly outputIdentity?: FileIdentity;
}

export interface OperationReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: MutationKind;
  readonly project: {
    readonly canonicalPath: string;
    readonly dev: string;
    readonly ino: string;
  };
  readonly configRelativePath: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly phase: ReceiptPhase;
  readonly ignoreBootstrap?: {
    readonly relativePath: ".gitignore";
    readonly before: ReceiptFileVersion | null;
    /** Only the known generated ignore suffix, never original file contents. */
    readonly appendedSuffix: string;
    readonly after: ReceiptFileVersion;
    readonly published: boolean;
  };
  readonly steps: readonly ReceiptStep[];
}

export type RollbackFile =
  | {
      readonly kind: "restore";
      readonly relativePath: string;
      readonly expected: ExistingFileSnapshot;
      readonly bytes: Uint8Array;
      readonly mode: number;
    }
  | {
      readonly kind: "remove-owned";
      readonly relativePath: string;
      readonly expected: ExistingFileSnapshot;
    };

export interface SafeRollbackSummary {
  readonly path: string;
  readonly operation: "restore" | "remove-owned";
  readonly reason: string;
}

export interface RollbackPlan {
  readonly projectDir: string;
  readonly operationId: string;
  readonly receipt: ExistingFileSnapshot;
  readonly inputs: readonly FileSnapshot[];
  readonly files: readonly RollbackFile[];
  readonly summary: readonly SafeRollbackSummary[];
  readonly diagnostics: readonly SafeDiagnostic[];
}

export interface GeneratedApplicationFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface ApplicationScaffoldPlan {
  readonly application: {
    readonly entrypoint: "./src/index.ts";
    readonly contractVersion: 1;
  };
  readonly files: readonly GeneratedApplicationFile[];
  readonly packageFields: {
    readonly type: "module";
    readonly scripts: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
}

export const AUTHORING_LIMITS = Object.freeze({
  documentBytes: 1_048_576,
  metadataBytes: 262_144,
  aggregateInputBytes: 8_388_608,
  yamlDepth: 64,
  yamlNodes: 50_000,
  augments: 256,
  plannedWrites: 256,
  outputBytes: 4_194_304,
  aggregateOutputBytes: 16_777_216,
  receiptBytes: 1_048_576,
  receiptEntries: 1_024,
  diagnostics: 100,
  diagnosticBytes: 1_024,
  /** Normalized project-relative paths; absolute selection remains separately bounded. */
  pathBytes: 1_024,
});

/** Narrow implementation seams compiled before the independently owned modules land. */
export interface DocumentOperations {
  readFileSnapshot(
    path: string,
    maxBytes: number,
    options?: { readonly allowMissing?: boolean },
  ): FileSnapshot;
  readAuthoringDocument(configPath: string): AuthoringDocument;
  assertInlineAuthoring(document: AuthoringDocument): void;
  editAuthoringDocument(document: AuthoringDocument, edits: readonly DocumentEdit[]): PlannedFile;
  createMutationPlan(input: MutationPlanInput): MutationPlan;
}

export interface PublicationOperations {
  acquireProjectMutationLease(projectDir: string): ProjectMutationLease;
  publishMutationPlan(plan: MutationPlan, options?: PublicationOptions): PublicationResult;
  readOperationReceipt(projectDir: string, operationId: string): OperationReceipt;
  planRollback(projectDir: string, operationId: string): RollbackPlan;
  applyRollback(plan: RollbackPlan, options?: PublicationOptions): PublicationResult;
}

export interface BuiltinSourceMapping {
  readonly type: string;
  readonly entrypoint: string;
  readonly directory?: string;
  readonly skill?: string;
}

/** Navigation only; never an enabled graph or a source of runtime policy/options. */
export interface InstalledSourceIndex {
  readonly schemaVersion: 1;
  readonly runtime: {
    readonly application: string;
    readonly host: string;
    readonly turn: string;
  };
  readonly augments: readonly BuiltinSourceMapping[];
}

export interface InspectionSource {
  readonly ownership: "project" | "external" | "package";
  readonly status: "available" | "missing" | "unresolved" | "unavailable";
  readonly path: string | null;
  readonly reason?: string;
}

export interface InspectionReport {
  readonly schemaVersion: 1;
  readonly status: "complete" | "partial" | "invalid";
  readonly inspector: { readonly version: string };
  readonly project: {
    readonly configPath: string;
    readonly format: AuthoringDocument["format"] | null;
    readonly name: string | null;
    readonly identity: {
      /** Only a validated immutable aug1_ ID may be emitted as a literal value. */
      readonly value: string | null;
      readonly environmentNames: readonly string[];
    };
  };
  readonly application: {
    readonly mode: "legacy" | "application";
    readonly entrypoint: string | null;
    readonly contractVersion: number | null;
    readonly source: InspectionSource | null;
  };
  readonly runtime: {
    readonly status: "available" | "unavailable";
    readonly packageRoot: string | null;
    readonly version: string | null;
    readonly manifestSHA256: string | null;
    readonly applicationSupported: boolean | null;
  };
  readonly execution: {
    readonly basis: "conventional-project-files";
    readonly startup: InspectionSource | null;
    readonly composition: InspectionSource | null;
    readonly http: InspectionSource | null;
    readonly turn: InspectionSource | null;
    readonly runtime: Readonly<Partial<Record<"application" | "host" | "turn", InspectionSource>>>;
  };
  readonly augments: readonly {
    readonly index: number;
    readonly name: string | null;
    readonly type: string;
    readonly configuration: { readonly path: string; readonly pointer: string };
    readonly optionKeys: readonly string[];
    readonly environmentNames: readonly string[];
    readonly source: InspectionSource;
  }[];
  readonly runtimeDiscovery: "not-evaluated";
  readonly diagnostics: readonly SafeDiagnostic[];
}
