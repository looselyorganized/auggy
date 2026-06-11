import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Pricing } from "../engines/_shared/cost";
import * as anthropicPricing from "../engines/anthropic/pricing";
import * as openaiPricing from "../engines/openai/pricing";
import * as openrouterPricing from "../engines/openrouter/pricing";
import type { AugmentConfig, EngineConfig, Provider } from "./types";

export type ModelRegistrySource = "static" | "provider";
export type ModelRegistryStatus = "known" | "live" | "cached" | "installed";

export const MODEL_REGISTRY_CACHE_FILENAME = "model-registry-cache.json";

export interface ModelRegistryEntry {
  provider: Provider;
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Pricing;
  tools?: boolean;
  source: ModelRegistrySource;
  status: ModelRegistryStatus;
  fetchedAt?: string;
}

export interface ModelRegistryResult {
  models: ModelRegistryEntry[];
  warnings: string[];
}

export interface ListModelRegistryOptions {
  provider?: Provider;
  refresh?: boolean;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  ollamaBaseURL?: string;
  useCache?: boolean;
  writeCache?: boolean;
  cacheDir?: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnginePricingStatus {
  status: "known" | "override" | "free" | "unknown";
  message: string;
  pricing?: Pricing;
}

interface ModelRegistryCache {
  schemaVersion: 1;
  providers: Partial<Record<Provider, CachedProviderModels>>;
}

interface CachedProviderModels {
  fetchedAt: string;
  models: ModelRegistryEntry[];
}

export async function listModelRegistry(
  opts: ListModelRegistryOptions = {},
): Promise<ModelRegistryResult> {
  const providers = opts.provider
    ? [opts.provider]
    : (["anthropic", "openai", "openrouter", "ollama"] as const);
  const warnings: string[] = [];
  const models: ModelRegistryEntry[] = [];

  for (const provider of providers) {
    if (opts.refresh) {
      try {
        const liveModels = await fetchProviderModels(provider, opts);
        models.push(...liveModels);
        if (opts.writeCache) writeProviderCache(provider, liveModels, opts);
        continue;
      } catch (err) {
        const cached = opts.useCache ? readProviderCache(provider, opts) : [];
        if (cached.length > 0) {
          warnings.push(`${provider}: ${(err as Error).message}; using saved model cache`);
          models.push(...cached);
          continue;
        }
        warnings.push(`${provider}: ${(err as Error).message}; using bundled fallback`);
      }
    }
    const cached = opts.useCache ? readProviderCache(provider, opts) : [];
    if (cached.length > 0) {
      models.push(...cached);
      continue;
    }
    models.push(...listStaticModels(provider));
  }

  return {
    models: sortModelEntries(dedupeModels(models)),
    warnings,
  };
}

export function modelRegistryCachePath(opts: { cacheDir?: string } = {}): string {
  return join(opts.cacheDir ?? join(homedir(), ".auggy"), MODEL_REGISTRY_CACHE_FILENAME);
}

export function listStaticModels(provider?: Provider): ModelRegistryEntry[] {
  const providers = provider
    ? [provider]
    : (["anthropic", "openai", "openrouter", "ollama"] as const);
  return providers.flatMap((p) => {
    switch (p) {
      case "anthropic":
        return anthropicPricing
          .listModels()
          .map((id) => staticEntry(p, id, anthropicPricing.lookup(id)));
      case "openai":
        return openaiPricing.listModels().map((id) => staticEntry(p, id, openaiPricing.lookup(id)));
      case "openrouter":
        return [
          ...anthropicPricing
            .listModels()
            .map((id) => staticEntry(p, `anthropic/${id}`, anthropicPricing.lookup(id))),
          ...openaiPricing
            .listModels()
            .map((id) => staticEntry(p, `openai/${id}`, openaiPricing.lookup(id))),
        ];
      case "ollama":
        return [
          "qwen3.6:27b",
          "qwen3.5:9b",
          "qwen3.5:27b",
          "qwen3:8b",
          "qwen3:14b",
          "qwen3:32b",
          "gemma4",
          "glm-5.1",
          "deepseek-v3.2",
        ].map((id) => staticEntry(p, id, { inputUsdPerMtok: 0, outputUsdPerMtok: 0 }));
      default: {
        const _exhaustive: never = p;
        return _exhaustive;
      }
    }
  });
}

export function describeEnginePricing(engine: EngineConfig): EnginePricingStatus {
  if (engine.costOverride) {
    return {
      status: "override",
      message: formatPricing(engine.costOverride),
      pricing: engine.costOverride,
    };
  }

  if (engine.provider === "ollama") {
    return {
      status: "free",
      message: "local model; no provider token pricing",
      pricing: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
  }

  const pricing = lookupEnginePricing(engine.provider, engine.model);
  if (pricing) {
    return {
      status: "known",
      message: formatPricing(pricing),
      pricing,
    };
  }

  return {
    status: "unknown",
    message: `${engine.provider}/${engine.model} has no Auggy pricing entry`,
  };
}

export function hasUsdBudgetCaps(augments: readonly AugmentConfig[]): boolean {
  for (const augment of augments) {
    if (augment.type !== "budgets") continue;
    if (hasPositiveNumber(augment.options?.dailyBudgetUsd)) return true;
    if (hasMaxUsdPerDay(augment.options?.caps)) return true;
  }
  return false;
}

export function lookupEnginePricing(provider: Provider, model: string): Pricing | null {
  switch (provider) {
    case "anthropic":
      return anthropicPricing.lookup(model);
    case "openai":
      return openaiPricing.lookup(model);
    case "openrouter":
      return openrouterPricing.resolveSlug(model)?.rates ?? null;
    case "ollama":
      return { inputUsdPerMtok: 0, outputUsdPerMtok: 0 };
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function formatPricing(pricing: Pricing): string {
  return `${formatUsd(pricing.inputUsdPerMtok)}/${formatUsd(pricing.outputUsdPerMtok)} per Mtok`;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (Number.isInteger(value)) return `$${value}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value}`;
}

async function fetchProviderModels(
  provider: Provider,
  opts: ListModelRegistryOptions,
): Promise<ModelRegistryEntry[]> {
  switch (provider) {
    case "anthropic":
      return fetchAnthropicModels(opts);
    case "openai":
      return fetchOpenAIModels(opts);
    case "openrouter":
      return fetchOpenRouterModels(opts);
    case "ollama":
      return fetchOllamaModels(opts);
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

function staticEntry(provider: Provider, id: string, pricing: Pricing | null): ModelRegistryEntry {
  return {
    provider,
    id,
    pricing: pricing ?? undefined,
    tools: provider === "ollama" ? undefined : true,
    source: "static",
    status: "known",
  };
}

async function fetchAnthropicModels(opts: ListModelRegistryOptions): Promise<ModelRegistryEntry[]> {
  const apiKey = opts.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for live model refresh");

  const response = await fetchJson(
    "https://api.anthropic.com/v1/models",
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    },
    opts.fetch,
  );
  const data = arrayField(response, "data");
  const fetchedAt = new Date().toISOString();
  return data.flatMap((item) => {
    const id = stringField(item, "id");
    if (!id) return [];
    return [
      {
        provider: "anthropic" as const,
        id,
        displayName: stringField(item, "display_name"),
        pricing: anthropicPricing.lookup(id) ?? undefined,
        tools: true,
        source: "provider" as const,
        status: "live" as const,
        fetchedAt,
      },
    ];
  });
}

async function fetchOpenAIModels(opts: ListModelRegistryOptions): Promise<ModelRegistryEntry[]> {
  const apiKey = opts.env?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for live model refresh");

  const response = await fetchJson(
    "https://api.openai.com/v1/models",
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    opts.fetch,
  );
  const data = arrayField(response, "data");
  const fetchedAt = new Date().toISOString();
  return data.flatMap((item) => {
    const id = stringField(item, "id");
    if (!id) return [];
    return [
      {
        provider: "openai" as const,
        id,
        pricing: openaiPricing.lookup(id) ?? undefined,
        source: "provider" as const,
        status: "live" as const,
        fetchedAt,
      },
    ];
  });
}

async function fetchOpenRouterModels(
  opts: ListModelRegistryOptions,
): Promise<ModelRegistryEntry[]> {
  const response = await fetchJson("https://openrouter.ai/api/v1/models", {}, opts.fetch);
  const data = arrayField(response, "data");
  const fetchedAt = new Date().toISOString();
  return data.flatMap((item) => {
    const id = stringField(item, "id");
    if (!id) return [];
    const pricing = pricingFromOpenRouter(recordField(item, "pricing"));
    const supported = arrayField(item, "supported_parameters").filter(
      (value): value is string => typeof value === "string",
    );
    return [
      {
        provider: "openrouter" as const,
        id,
        displayName: stringField(item, "name"),
        contextWindow: numberField(item, "context_length"),
        maxOutputTokens: numberField(recordField(item, "top_provider"), "max_completion_tokens"),
        pricing,
        tools: supported.includes("tools"),
        source: "provider" as const,
        status: "live" as const,
        fetchedAt,
      },
    ];
  });
}

async function fetchOllamaModels(opts: ListModelRegistryOptions): Promise<ModelRegistryEntry[]> {
  const baseURL = opts.ollamaBaseURL ?? "http://127.0.0.1:11434";
  const response = await fetchJson(`${baseURL.replace(/\/$/, "")}/api/tags`, {}, opts.fetch);
  const models = arrayField(response, "models");
  const fetchedAt = new Date().toISOString();
  return models.flatMap((item) => {
    const id = stringField(item, "model") ?? stringField(item, "name");
    if (!id) return [];
    return [
      {
        provider: "ollama" as const,
        id,
        displayName: stringField(recordField(item, "details"), "family"),
        pricing: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        source: "provider" as const,
        status: "installed" as const,
        fetchedAt,
      },
    ];
  });
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid JSON from ${new URL(url).hostname}`);
  }
  return value as Record<string, unknown>;
}

function pricingFromOpenRouter(value: Record<string, unknown> | null): Pricing | undefined {
  if (!value) return undefined;
  const input = numberFromString(value.prompt);
  const output = numberFromString(value.completion);
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined;
  const pricing: Pricing = {
    inputUsdPerMtok: input * 1_000_000,
    outputUsdPerMtok: output * 1_000_000,
  };
  const cacheWrite = numberFromString(value.input_cache_write);
  const cacheRead = numberFromString(value.input_cache_read);
  if (cacheWrite !== undefined && cacheWrite >= 0)
    pricing.cacheWriteUsdPerMtok = cacheWrite * 1_000_000;
  if (cacheRead !== undefined && cacheRead >= 0)
    pricing.cacheReadUsdPerMtok = cacheRead * 1_000_000;
  return pricing;
}

function hasMaxUsdPerDay(value: unknown): boolean {
  const caps = asRecord(value);
  if (!caps) return false;
  if (hasPositiveNumber(asRecord(caps.agent)?.maxUsdPerDay)) return true;
  const publicCaps = asRecord(caps.public);
  if (!publicCaps) return false;
  return (
    hasPositiveNumber(asRecord(publicCaps.anonymous)?.maxUsdPerDay) ||
    hasPositiveNumber(asRecord(publicCaps.recognized)?.maxUsdPerDay)
  );
}

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function numberFromString(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const raw = record[key];
  return asRecord(raw);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readProviderCache(
  provider: Provider,
  opts: ListModelRegistryOptions,
): ModelRegistryEntry[] {
  try {
    const path = modelRegistryCachePath(opts);
    const value = JSON.parse(readFileSync(path, "utf-8"));
    const cache = parseModelRegistryCache(value);
    const cached = cache.providers[provider];
    if (!cached || cached.models.length === 0) return [];
    return cached.models.map((model) => ({
      ...model,
      source: "provider" as const,
      status: model.status === "installed" ? ("installed" as const) : ("cached" as const),
      fetchedAt: model.fetchedAt ?? cached.fetchedAt,
    }));
  } catch {
    return [];
  }
}

function writeProviderCache(
  provider: Provider,
  models: ModelRegistryEntry[],
  opts: ListModelRegistryOptions,
): void {
  if (models.length === 0) return;
  const path = modelRegistryCachePath(opts);
  let cache: ModelRegistryCache = { schemaVersion: 1, providers: {} };
  try {
    cache = parseModelRegistryCache(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    cache = { schemaVersion: 1, providers: {} };
  }

  const fetchedAt = new Date().toISOString();
  cache.providers[provider] = {
    fetchedAt,
    models: models
      .filter((model) => model.provider === provider)
      .map((model) => ({ ...model, fetchedAt: model.fetchedAt ?? fetchedAt })),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

function parseModelRegistryCache(value: unknown): ModelRegistryCache {
  const raw = asRecord(value);
  if (raw?.schemaVersion !== 1) return { schemaVersion: 1, providers: {} };
  const providersRaw = asRecord(raw.providers);
  if (!providersRaw) return { schemaVersion: 1, providers: {} };

  const providers: Partial<Record<Provider, CachedProviderModels>> = {};
  for (const provider of ["anthropic", "openai", "openrouter", "ollama"] as const) {
    const providerRaw = asRecord(providersRaw[provider]);
    if (!providerRaw) continue;
    const fetchedAt =
      typeof providerRaw.fetchedAt === "string" && providerRaw.fetchedAt
        ? providerRaw.fetchedAt
        : new Date(0).toISOString();
    const models = Array.isArray(providerRaw.models)
      ? providerRaw.models.flatMap((model) => parseCachedModel(provider, model))
      : [];
    if (models.length > 0) providers[provider] = { fetchedAt, models };
  }

  return { schemaVersion: 1, providers };
}

function parseCachedModel(provider: Provider, value: unknown): ModelRegistryEntry[] {
  const raw = asRecord(value);
  if (!raw) return [];
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : undefined;
  if (!id) return [];
  const pricing = parseCachedPricing(raw.pricing);
  return [
    {
      provider,
      id,
      displayName:
        typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : undefined,
      contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
      maxOutputTokens: typeof raw.maxOutputTokens === "number" ? raw.maxOutputTokens : undefined,
      pricing,
      tools: typeof raw.tools === "boolean" ? raw.tools : undefined,
      source: "provider",
      status: raw.status === "installed" ? "installed" : "cached",
      fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : undefined,
    },
  ];
}

function parseCachedPricing(value: unknown): Pricing | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const input = raw.inputUsdPerMtok;
  const output = raw.outputUsdPerMtok;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return undefined;
  }
  const pricing: Pricing = { inputUsdPerMtok: input, outputUsdPerMtok: output };
  if (typeof raw.cacheWriteUsdPerMtok === "number" && raw.cacheWriteUsdPerMtok >= 0) {
    pricing.cacheWriteUsdPerMtok = raw.cacheWriteUsdPerMtok;
  }
  if (typeof raw.cacheReadUsdPerMtok === "number" && raw.cacheReadUsdPerMtok >= 0) {
    pricing.cacheReadUsdPerMtok = raw.cacheReadUsdPerMtok;
  }
  return pricing;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw : [];
}

function dedupeModels(models: ModelRegistryEntry[]): ModelRegistryEntry[] {
  const seen = new Map<string, ModelRegistryEntry>();
  for (const model of models) {
    seen.set(`${model.provider}:${model.id}`, model);
  }
  return [...seen.values()];
}

function sortModelEntries(models: ModelRegistryEntry[]): ModelRegistryEntry[] {
  return [...models].sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    const aCost = a.pricing?.inputUsdPerMtok ?? Number.POSITIVE_INFINITY;
    const bCost = b.pricing?.inputUsdPerMtok ?? Number.POSITIVE_INFINITY;
    if (aCost !== bCost) return aCost - bCost;
    return a.id.localeCompare(b.id);
  });
}
