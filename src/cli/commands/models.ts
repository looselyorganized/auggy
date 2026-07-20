import { Command } from "commander";
import {
  describeEnginePricing,
  formatUsd,
  hasUsdBudgetCaps,
  listModelRegistry,
  type ModelRegistryResult,
} from "../model-registry";
import { parseConfig } from "../config-parser";
import { resolveConfigPath } from "../resolve-config";
import { isKnownProvider, type ParsedConfig, type Provider } from "../types";
import { warningLabel } from "../_shared/styles";

export interface ModelsCommandDeps {
  listModelRegistry?: typeof listModelRegistry;
  exit?: (code: number) => void;
}

export interface ModelsListOptions {
  refresh?: boolean;
  json?: boolean;
  limit?: string;
}

export interface ModelsDoctorOptions {
  config?: string;
  auggyDir?: string;
  cwd?: string;
}

export function modelsCommand(deps: ModelsCommandDeps = {}): Command {
  const command = new Command("models").description("List and inspect engine models");
  const listRegistry = deps.listModelRegistry ?? listModelRegistry;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  command
    .command("list [provider]")
    .description("List models Auggy can select or recognize")
    .option("--refresh", "fetch live provider models when possible")
    .option("--json", "print JSON")
    .option("--limit <n>", "limit displayed rows")
    .action(async (providerArg: string | undefined, opts: ModelsListOptions) => {
      try {
        const provider = parseProvider(providerArg);
        const result = await listRegistry({
          provider,
          refresh: opts.refresh,
          useCache: true,
          writeCache: opts.refresh === true,
        });
        const requestedLimit = parseLimit(opts.limit);
        const limit = opts.json
          ? requestedLimit
          : (requestedLimit ?? (opts.refresh ? 50 : undefined));
        if (opts.json) {
          console.log(JSON.stringify(limitResult(result, limit), null, 2));
        } else {
          console.log(formatModelsList(result, { limit, color: process.stdout.isTTY }));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("doctor [name]")
    .description("Check the configured agent model and pricing status")
    .option("--config <path>", "path to agent.yaml")
    .action(async (name: string | undefined, opts: { config?: string }) => {
      try {
        const result = runModelsDoctor(name, opts);
        console.log(formatModelsDoctor(result));
        exit(result.pricing.status === "unknown" && result.usdBudgets ? 1 : 0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}

export interface ModelsDoctorResult {
  agent: {
    name: string;
    configPath: string;
  };
  engine: ParsedConfig["engine"];
  pricing: ReturnType<typeof describeEnginePricing>;
  usdBudgets: boolean;
}

export function runModelsDoctor(
  name: string | undefined,
  opts: ModelsDoctorOptions = {},
): ModelsDoctorResult {
  const configPath = resolveConfigPath(name, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const config = parseConfig(configPath);
  return {
    agent: {
      name: config.name,
      configPath,
    },
    engine: config.engine,
    pricing: describeEnginePricing(config.engine),
    usdBudgets: hasUsdBudgetCaps(config.augments),
  };
}

export function formatModelsDoctor(result: ModelsDoctorResult): string {
  const model = `${result.engine.provider}/${result.engine.model}`;
  const lines = [`Model doctor for ${result.agent.name}`, ""];

  if (result.pricing.status === "unknown") {
    lines.push(
      `${result.usdBudgets ? "WARN" : "INFO"} model pricing: ${model} has no Auggy pricing entry.`,
    );
    if (result.usdBudgets) {
      lines.push("USD budget caps will record unpriced turns but cannot enforce dollar spend.");
      lines.push("Add engine.costOverride in agent.yaml for reliable USD budgets.");
    } else {
      lines.push(
        "This is allowed, but USD budget caps need engine.costOverride if you add budgets.",
      );
    }
  } else {
    lines.push(`PASS model pricing: ${model} ${result.pricing.message}`);
  }

  return lines.join("\n");
}

export function formatModelsList(
  result: ModelRegistryResult,
  opts: { limit?: number; color?: boolean } = {},
): string {
  const models = opts.limit === undefined ? result.models : result.models.slice(0, opts.limit);
  const rows = models.map((model) => ({
    provider: model.provider,
    model: model.id,
    context: model.contextWindow ? formatTokens(model.contextWindow) : "-",
    input: model.pricing ? formatMoney(model.pricing.inputUsdPerMtok) : "unknown",
    output: model.pricing ? formatMoney(model.pricing.outputUsdPerMtok) : "unknown",
    tools: model.tools === undefined ? "unknown" : model.tools ? "yes" : "no",
    source: model.source === "provider" ? model.status : "static",
  }));

  const widths = {
    provider: maxWidth(
      "Provider",
      rows.map((r) => r.provider),
    ),
    model: maxWidth(
      "Model",
      rows.map((r) => r.model),
    ),
    context: maxWidth(
      "Context",
      rows.map((r) => r.context),
    ),
    input: maxWidth(
      "Input",
      rows.map((r) => r.input),
    ),
    output: maxWidth(
      "Output",
      rows.map((r) => r.output),
    ),
    tools: maxWidth(
      "Tools",
      rows.map((r) => r.tools),
    ),
  };

  const lines = [
    "Models",
    "",
    `${"Provider".padEnd(widths.provider)}  ${"Model".padEnd(widths.model)}  ${"Context".padEnd(
      widths.context,
    )}  ${"Input".padEnd(widths.input)}  ${"Output".padEnd(widths.output)}  ${"Tools".padEnd(
      widths.tools,
    )}  Source`,
  ];

  for (const row of rows) {
    lines.push(
      `${row.provider.padEnd(widths.provider)}  ${row.model.padEnd(widths.model)}  ${row.context.padEnd(
        widths.context,
      )}  ${row.input.padEnd(widths.input)}  ${row.output.padEnd(widths.output)}  ${row.tools.padEnd(
        widths.tools,
      )}  ${row.source}`,
    );
  }

  if (result.models.length === 0) lines.push("No models found.");
  if (opts.limit !== undefined && result.models.length > models.length) {
    lines.push("");
    lines.push(`Showing ${models.length} of ${result.models.length}. Use --limit 0 to show all.`);
  }

  for (const warning of result.warnings) {
    lines.push("");
    lines.push(`${warningLabel({ color: opts.color })}: ${warning}`);
  }

  return lines.join("\n");
}

function parseProvider(value: string | undefined): Provider | undefined {
  if (!value) return undefined;
  if (!isKnownProvider(value)) {
    throw new Error(
      `Unknown provider "${value}". Valid providers: anthropic, openai, openrouter, ollama`,
    );
  }
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--limit must be a non-negative integer");
  }
  return parsed === 0 ? undefined : parsed;
}

function limitResult(result: ModelRegistryResult, limit: number | undefined): ModelRegistryResult {
  if (limit === undefined) return result;
  return { ...result, models: result.models.slice(0, limit) };
}

function maxWidth(label: string, values: string[]): number {
  return Math.max(label.length, ...values.map((value) => value.length));
}

function formatMoney(value: number): string {
  return `${formatUsd(value)}/M`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatCompactNumber(value / 1_000)}k`;
  return String(value);
}

function formatCompactNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, "");
}
