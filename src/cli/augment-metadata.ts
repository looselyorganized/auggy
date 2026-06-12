import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { CatalogEntry } from "./augment-catalog";
import { augmentFolderForType } from "./scaffold-skills";

export function augmentIdForCatalogEntry(entry: CatalogEntry): string {
  return augmentFolderForType(entry.type) ?? entry.defaultName;
}

export function writeBuiltinAugmentMetadata(
  agentDir: string,
  entry: CatalogEntry,
  config?: Record<string, unknown>,
): void {
  const folder = augmentIdForCatalogEntry(entry);
  const dir = join(agentDir, "augments", folder);
  const metadata: Record<string, unknown> = {
    type: entry.type,
  };
  if (config && Object.keys(config).length > 0) metadata.config = config;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "augment.yaml"), stringify(metadata));
}

export function writeCustomAugmentsReadme(agentDir: string): void {
  const dir = join(agentDir, "augments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    [
      "# Augments",
      "",
      "Installed augment metadata and custom local augments for this agent live here.",
      "",
      "Built-in augments have an `augment.yaml` metadata file only. Their runtime",
      "implementation comes from the installed `auggy` package, which you can inspect",
      "at `node_modules/auggy/src` after `bun install`.",
      "",
      "Auggy keeps the runtime as a package instead of copying its TypeScript source",
      "into every agent so agents can receive runtime and security updates through the",
      "normal package manager path. Custom augments are different: they include local",
      "source such as `index.ts` inside this directory because they belong to this agent.",
      "",
    ].join("\n"),
  );
}
