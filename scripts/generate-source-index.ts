/** Generate/check the data-only navigation index shipped inside the Auggy package. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUILTIN_SOURCE_METADATA } from "../src/cli/augment-catalog";
import { BUILTIN_TYPE_NAMES } from "../src/cli/builtin-types";
import type { InstalledSourceIndex } from "../src/cli/authoring/contracts";
import {
  SOURCE_INDEX_PATH,
  validateInstalledSourceIndex,
} from "../src/cli/authoring/inspection-index";

export function generateSourceIndex(
  packageRoot = resolve(import.meta.dir, ".."),
  options: { readonly check?: boolean } = {},
): InstalledSourceIndex {
  const names = BUILTIN_SOURCE_METADATA.map((entry) => entry.type).sort();
  if (JSON.stringify(names) !== JSON.stringify([...BUILTIN_TYPE_NAMES].sort())) {
    throw new Error("Source metadata must cover every supported declarable built-in exactly once.");
  }
  const index: InstalledSourceIndex = {
    schemaVersion: 1,
    runtime: {
      application: "src/application/runner.ts",
      host: "src/application/host.ts",
      turn: "src/kernel/turn-session.ts",
    },
    augments: BUILTIN_SOURCE_METADATA,
  };
  validateInstalledSourceIndex(index, packageRoot);
  const path = join(packageRoot, SOURCE_INDEX_PATH);
  const bytes = `${JSON.stringify(index, null, 2)}\n`;
  if (options.check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* A missing index is stale. */
    }
    if (current !== bytes)
      throw new Error("Source index is stale; run bun scripts/generate-source-index.ts.");
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  return index;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    console.error("Usage: bun scripts/generate-source-index.ts [--check]");
    process.exitCode = 1;
  } else {
    try {
      generateSourceIndex(undefined, { check: args.includes("--check") });
      console.log(
        args.includes("--check") ? "Source index is current." : "Generated installed source index.",
      );
    } catch {
      console.error(
        "Source index validation failed; regenerate it and review its source mappings.",
      );
      process.exitCode = 1;
    }
  }
}
