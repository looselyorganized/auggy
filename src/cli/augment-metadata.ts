import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { CatalogEntry } from "./augment-catalog";
import { augmentFolderForType } from "./scaffold-skills";

export function writeBuiltinAugmentMetadata(agentDir: string, entry: CatalogEntry): void {
  const folder = augmentFolderForType(entry.type) ?? entry.defaultName;
  const dir = join(agentDir, "augments", folder);
  const metadata: Record<string, unknown> = {
    name: folder,
    kind: "builtin",
    runtime: "auggy",
    configType: entry.type,
  };
  if (entry.hasSkill) metadata.skill = `../../skills/${folder}/SKILL.md`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "augment.yaml"), stringify(metadata));
  writeFileSync(
    join(dir, "README.md"),
    [
      `# ${folder}`,
      "",
      "This is an installed built-in Auggy augment.",
      "",
      "- Runtime implementation: provided by the `auggy` package",
      `- agent.yaml type: \`${entry.type}\``,
      entry.hasSkill
        ? `- Skill: [../../skills/${folder}/SKILL.md](../../skills/${folder}/SKILL.md)`
        : "- Skill: none",
      "",
      "Do not edit built-in runtime code here. Add custom local augments as sibling folders.",
      "",
    ].join("\n"),
  );
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
      "Built-in augments have an `augment.yaml` and README only; their implementation",
      "comes from the installed `auggy` package. Custom augments include local source",
      "such as `index.ts`.",
      "",
    ].join("\n"),
  );
}
