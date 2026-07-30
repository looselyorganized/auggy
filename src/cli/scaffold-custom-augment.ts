import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VALID_NAME_RE } from "./config-parser";

export interface CustomAugmentScaffoldOptions {
  slug: string;
  targetDir: string;
  skillTargetDir?: string;
  force?: boolean;
}

export function scaffoldCustomAugment(opts: CustomAugmentScaffoldOptions): string {
  const slug = opts.slug.trim();
  if (!VALID_NAME_RE.test(slug)) {
    throw new Error(
      `Invalid augment slug "${opts.slug}". Use lowercase letters, numbers, hyphens, or underscores.`,
    );
  }

  const dir = resolve(opts.targetDir);
  if (existsSync(dir) && !opts.force) {
    throw new Error(`Directory already exists: ${dir}. Re-run with --force to overwrite.`);
  }
  const skillDir = opts.skillTargetDir ? resolve(opts.skillTargetDir) : null;
  if (skillDir && existsSync(skillDir) && !opts.force) {
    throw new Error(
      `Skill directory already exists: ${skillDir}. Re-run with --force to overwrite.`,
    );
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "augment.yaml"), augmentYamlTemplate());
  writeFileSync(join(dir, "index.ts"), indexTemplate(slug));
  // Clean up the pre-0.5 scaffold location when the operator explicitly
  // overwrites an older custom augment. Runtime skills only live in /skills.
  rmSync(join(dir, "SKILL.md"), { force: true });
  writeFileSync(join(dir, "README.md"), readmeTemplate(slug));
  writeFileSync(join(dir, `${slug}.test.ts`), testTemplate(slug));
  if (skillDir) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skillTemplate(slug));
  }
  return dir;
}

function augmentYamlTemplate(): string {
  return `type: custom
source: ./index.ts
config: {}
`;
}

function pascalCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function indexTemplate(slug: string): string {
  const typeName = `${pascalCase(slug)}Options`;
  const toolName = `${slug.replace(/-/g, "_")}_echo`;
  return `import { defineAugment, defineTool } from "auggy";
import { z } from "zod";

export interface ${typeName} {
  prefix?: string;
}

export default function ${slug.replace(/-/g, "_")}(opts: ${typeName} = {}) {
  return defineAugment({
    name: "${slug}",
    tools: [
      defineTool({
        name: "${toolName}",
        description: "Echo a message with an optional configured prefix.",
        category: "utility",
        input: z.object({
          message: z.string().describe("Message to echo."),
        }),
        execute: async ({ message }) => {
          return opts.prefix ? \`\${opts.prefix}: \${message}\` : message;
        },
      }),
    ],
    constraints: {
      // A new model tool starts creator-only. Route auth does not authorize a
      // matching tool; relax these rules only after choosing allowed peers.
      perTrustLevel: {
        public: { neverExpose: ["${toolName}"] },
        agent: { neverExpose: ["${toolName}"] },
      },
    },
  });
}
`;
}

function skillTemplate(slug: string): string {
  return `---
name: ${slug}
description: How and when to use the ${slug} augment.
allowedTrustLevels:
  - creator
---

# ${slug}

Use this skill when a task needs the custom ${slug} capability.

## Tools

- \`${slug.replace(/-/g, "_")}_echo\`: Echoes a message with the augment's optional prefix.

## Guidance

- Use the tool only when echoing or checking the custom augment wiring is useful.
- Prefer answering directly when the user asks a normal conversational question.
`;
}

function readmeTemplate(slug: string): string {
  return `# ${slug}

Custom Auggy augment scaffolded by \`auggy augment create ${slug}\`.

The create command also registers this augment in the current project's
\`agent.yaml\`.

The starter tool is creator-only by default. Route auth does not authorize
model tools: choose each route's \`auth\`, any delegated \`requires\`, and tool
visibility under \`constraints.perTrustLevel\` independently.

## Test

\`\`\`bash
auggy augment test ./augments/${slug}
\`\`\`
`;
}

function testTemplate(slug: string): string {
  const fnName = slug.replace(/-/g, "_");
  const toolName = `${slug.replace(/-/g, "_")}_echo`;
  return `import { describe, expect, test } from "bun:test";
import ${fnName} from "./index";

describe("${slug}", () => {
  test("exposes the ${toolName} tool", async () => {
    const augment = ${fnName}({ prefix: "test" });
    const tool = augment.tools?.find((t) => t.name === "${toolName}");

    expect(tool).toBeDefined();
    await expect(tool!.execute({ message: "hello" })).resolves.toBe("test: hello");
  });
});
`;
}
