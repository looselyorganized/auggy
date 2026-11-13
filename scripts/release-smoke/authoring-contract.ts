/** M4 harness contracts. Helper preparation never certifies installed authoring. */
import type {
  ApplicationSourceEdit,
  PackedArtifactEvidence,
  PackedArtifactInput,
} from "./application-consumer";
import type { ProviderFixtureTool } from "./provider-fixture";

export type AuthoringProvider = "anthropic" | "openai" | "openrouter" | "ollama";
export type AuthoringPackage = "auggy" | `@auggy/${AuthoringProvider}`;
export type FileHashes = Readonly<Record<string, string>>;

export const AUTHORING_BOUNDS = Object.freeze({
  sourceFiles: 128,
  sourceBytes: 2 * 1024 * 1024,
  totalSourceBytes: 16 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  specifiersBytes: 16 * 1024,
  specifierCharacters: 4_096,
  editCharacters: 32_768,
  commandArguments: 64,
  argumentCharacters: 4_096,
});

export const AUTHORING_EXECUTION_FILES = [
  "src/index.ts",
  "src/agent.ts",
  "src/http.ts",
  "src/turn.ts",
] as const;

export interface AuthoringArtifactSet {
  core: PackedArtifactInput;
  providers: Readonly<Record<AuthoringProvider, PackedArtifactInput>>;
}

export interface AuthoringArtifactSelection {
  core: PackedArtifactEvidence;
  provider: PackedArtifactEvidence;
  prerequisites: readonly PackedArtifactEvidence[];
  specifiers: Readonly<Partial<Record<AuthoringPackage, string>>>;
  specifiersJSON: string;
}

export interface InstalledAuthoringCli {
  entry: string;
  packageRoot: string;
  core: PackedArtifactEvidence;
}

export interface CreateAuthoringConsumerOptions {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  cli: InstalledAuthoringCli;
  artifacts: AuthoringArtifactSet;
  provider: AuthoringProvider;
  model: string;
  name: string;
}

export interface GeneratedAuthoringConsumer {
  consumer: string;
  core: PackedArtifactEvidence;
  provider: PackedArtifactEvidence;
  prerequisites: readonly PackedArtifactEvidence[];
  sourceFiles: readonly string[];
  generatedSources: FileHashes;
  installedSources: FileHashes;
  lockSHA256: string;
}

export interface GeneratedApplicationRecipe {
  schemaVersion: 1;
  entrypoint: "src/index.ts";
  sourceFiles: readonly string[];
  capability: {
    slug: string;
    tool: ProviderFixtureTool;
    expectedOutput: string;
    route: string;
    toolJournal: string;
  };
  edits: {
    startup: ApplicationSourceEdit;
    http: ApplicationSourceEdit;
    turn: ApplicationSourceEdit;
  };
  observations: {
    startupRejection: string;
    httpHeader: { name: string; value: string };
    baselineProviderCalls: 2;
    baselineToolEffects: 1;
    stoppedProviderCalls: 0;
    stoppedToolEffects: 0;
  };
}

export interface GeneratedApplicationRunOptions {
  repoRoot: string;
  consumer: GeneratedAuthoringConsumer;
  global: { consumer: string; core: PackedArtifactEvidence };
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  recipe: GeneratedApplicationRecipe;
}

export interface AuthoringEffectCounts {
  providerCalls: number;
  toolEffects: number;
}
