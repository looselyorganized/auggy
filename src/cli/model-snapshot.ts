import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pricing } from "../engines/_shared/cost";
import type {
  ModelRegistryEntry,
  ModelRegistrySource,
  ModelRegistryStatus,
} from "./model-registry";
import type { Provider } from "./types";

export const MODEL_SNAPSHOT_RELATIVE_PATH = ".auggy/models.lock.json";

export type ModelSnapshotSource = ModelRegistrySource | "custom";

export interface ModelSnapshotSelection {
  provider: Provider;
  model: string;
  displayName?: string;
  source: ModelSnapshotSource;
  status?: ModelRegistryStatus;
  fetchedAt?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  tools?: boolean;
  pricingKnown: boolean;
  pricing?: Pricing;
}

export interface ModelSnapshot {
  schemaVersion: 1;
  createdAt: string;
  selected: ModelSnapshotSelection;
  registry: {
    provider: Provider;
    refreshRequested: boolean;
    warnings: string[];
  };
}

export type ReadModelSnapshotResult =
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; snapshot: ModelSnapshot };

export function modelSnapshotPath(agentDir: string): string {
  return join(agentDir, MODEL_SNAPSHOT_RELATIVE_PATH);
}

export function writeModelSnapshot(agentDir: string, snapshot: ModelSnapshot): void {
  const path = modelSnapshotPath(agentDir);
  mkdirSync(join(agentDir, ".auggy"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function readModelSnapshot(agentDir: string): ReadModelSnapshotResult {
  const path = modelSnapshotPath(agentDir);
  if (!existsSync(path)) return { kind: "missing" };

  try {
    return { kind: "ok", snapshot: parseModelSnapshot(JSON.parse(readFileSync(path, "utf-8"))) };
  } catch (err) {
    return { kind: "invalid", error: (err as Error).message };
  }
}

export function createModelSnapshot(args: {
  provider: Provider;
  refreshRequested: boolean;
  warnings: string[];
  selected: ModelSnapshotSelection;
  now?: Date;
}): ModelSnapshot {
  return {
    schemaVersion: 1,
    createdAt: (args.now ?? new Date()).toISOString(),
    selected: args.selected,
    registry: {
      provider: args.provider,
      refreshRequested: args.refreshRequested,
      warnings: args.warnings,
    },
  };
}

export function selectionFromModelRegistryEntry(entry: ModelRegistryEntry): ModelSnapshotSelection {
  return {
    provider: entry.provider,
    model: entry.id,
    displayName: entry.displayName,
    source: entry.source,
    status: entry.status,
    fetchedAt: entry.fetchedAt,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    tools: entry.tools,
    pricingKnown: entry.pricing !== undefined,
    pricing: entry.pricing,
  };
}

export function customModelSelection(provider: Provider, model: string): ModelSnapshotSelection {
  return {
    provider,
    model,
    source: "custom",
    pricingKnown: false,
  };
}

export function formatModelSnapshotRef(selection: ModelSnapshotSelection): string {
  return `${selection.provider}/${selection.model}`;
}

function parseModelSnapshot(value: unknown): ModelSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("snapshot must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
  if (typeof raw.createdAt !== "string" || !raw.createdAt) {
    throw new Error("createdAt must be a non-empty string");
  }
  const selected = parseSelection(raw.selected);
  const registry = parseRegistry(raw.registry);
  return {
    schemaVersion: 1,
    createdAt: raw.createdAt,
    selected,
    registry,
  };
}

function parseSelection(value: unknown): ModelSnapshotSelection {
  const raw = asRecord(value, "selected");
  const provider = parseProvider(raw.provider, "selected.provider");
  const model = stringField(raw.model, "selected.model");
  const source = parseSource(raw.source);
  const out: ModelSnapshotSelection = {
    provider,
    model,
    source,
    pricingKnown: raw.pricingKnown === true,
  };
  if (typeof raw.displayName === "string") out.displayName = raw.displayName;
  if (typeof raw.status === "string") out.status = raw.status as ModelRegistryStatus;
  if (typeof raw.fetchedAt === "string") out.fetchedAt = raw.fetchedAt;
  if (typeof raw.contextWindow === "number") out.contextWindow = raw.contextWindow;
  if (typeof raw.maxOutputTokens === "number") out.maxOutputTokens = raw.maxOutputTokens;
  if (typeof raw.tools === "boolean") out.tools = raw.tools;
  if (raw.pricing !== undefined) out.pricing = parsePricing(raw.pricing);
  return out;
}

function parseRegistry(value: unknown): ModelSnapshot["registry"] {
  const raw = asRecord(value, "registry");
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  return {
    provider: parseProvider(raw.provider, "registry.provider"),
    refreshRequested: raw.refreshRequested === true,
    warnings,
  };
}

function parsePricing(value: unknown): Pricing {
  const raw = asRecord(value, "selected.pricing");
  const pricing: Pricing = {
    inputUsdPerMtok: numberField(raw.inputUsdPerMtok, "inputUsdPerMtok"),
    outputUsdPerMtok: numberField(raw.outputUsdPerMtok, "outputUsdPerMtok"),
  };
  if (raw.cacheWriteUsdPerMtok !== undefined) {
    pricing.cacheWriteUsdPerMtok = numberField(raw.cacheWriteUsdPerMtok, "cacheWriteUsdPerMtok");
  }
  if (raw.cacheReadUsdPerMtok !== undefined) {
    pricing.cacheReadUsdPerMtok = numberField(raw.cacheReadUsdPerMtok, "cacheReadUsdPerMtok");
  }
  return pricing;
}

function parseProvider(value: unknown, field: string): Provider {
  if (value === "anthropic" || value === "openai" || value === "openrouter" || value === "ollama") {
    return value;
  }
  throw new Error(`${field} must be a known provider`);
}

function parseSource(value: unknown): ModelSnapshotSource {
  if (value === "static" || value === "provider" || value === "custom") return value;
  throw new Error("selected.source must be static, provider, or custom");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} must be a non-empty string`);
}

function numberField(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${label} must be a finite non-negative number`);
}
