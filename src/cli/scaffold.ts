/**
 * Scaffold — generates a new agent directory with aug1create.
 *
 * Creates the standard agent directory convention:
 *   <name>/
 *     agent.yaml         Config (source of truth)
 *     .env               Secrets template (gitignored)
 *     identity.md        Who the agent is
 *     learned.md         What the agent has learned (mutable)
 *     skills/            Skill folders (read-only fs mount)
 *     workspace/         Agent's mutable workspace
 *     augments/          Custom augments directory
 *     .gitignore         Ignores .env, workspace/, *.log
 */

import { existsSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { scanSkillManifest, renderSkillManifest } from "./skill-manifest";

export interface ScaffoldOptions {
  /** Agent name. */
  name: string;
  /** Target directory (defaults to ./<name>). */
  targetDir?: string;
  /** Optional purpose string for the agent. */
  purpose?: string;
}

/**
 * Scaffold a new agent directory.
 * Throws if the target directory already exists.
 */
export function scaffoldAgent(opts: ScaffoldOptions): string {
  const dir = resolve(opts.targetDir ?? `./${opts.name}`);

  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}`);
  }

  const id = `aug1_${randomUUID()}`;
  const purpose = opts.purpose ?? `${opts.name} agent`;

  // Create directory structure.
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "skills", "memory"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "augments"), { recursive: true });

  // Copy built-in filesystem skill if available.
  const fsSkillSrc = resolve(import.meta.dir, "../augments/filesystem-skill");
  if (existsSync(fsSkillSrc)) {
    cpSync(fsSkillSrc, join(dir, "skills", "filesystem"), { recursive: true });
  }

  // Write template skill files.
  writeFileSync(
    join(dir, "skills", "memory", "SKILL.md"),
    MEMORY_SKILL_TEMPLATE,
  );
  mkdirSync(join(dir, "skills", "web-fetch"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "web-fetch", "SKILL.md"),
    WEB_FETCH_SKILL_TEMPLATE,
  );

  // Scan skills and generate manifest.
  const skillEntries = scanSkillManifest(join(dir, "skills"));
  const skillManifest = renderSkillManifest(skillEntries);

  // Write identity.md with skill manifest.
  writeFileSync(
    join(dir, "identity.md"),
    identityTemplate(opts.name, purpose, skillManifest),
  );

  // Write learned.md (empty).
  writeFileSync(join(dir, "learned.md"), "");

  // Write agent.yaml.
  writeFileSync(join(dir, "agent.yaml"), agentYamlTemplate(id, opts.name, purpose));

  // Write .env.example template (operator copies to .env with real values).
  writeFileSync(join(dir, ".env.example"), ENV_TEMPLATE);

  // Write .gitignore.
  writeFileSync(join(dir, ".gitignore"), GITIGNORE_TEMPLATE);

  return dir;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function agentYamlTemplate(id: string, name: string, purpose: string): string {
  return `# Agent configuration — the source of truth for this Auggy agent.
# See docs at augment-1/docs/ for field reference.

id: ${id}
name: ${name}
purpose: "${purpose}"

engine:
  provider: anthropic        # or: openai, openrouter
  model: claude-sonnet-4-6   # openai: gpt-5 | openrouter: qwen/qwen3.5-397b-a17b
  maxContextTokens: 200000   # for openrouter, set per-model — defaults vary
  maxTokens: 4096            # sent as max_completion_tokens for openai/openrouter
  # reasoningEffort: medium  # optional: none|minimal|low|medium|high|xhigh
  # providerRouting:         # openrouter only — slugs not semantically validated
  #   only: [OpenAI]
  #   sort: price

settings:
  compactionStrategy: truncate
  maxInferenceLoops: 10

augments:
  - name: identity
    type: fileMemory
    options:
      label: self
      source: ./identity.md
      mutable: false
      origin: operator
      priority: required
      placement: system
      eviction: never

  - name: learned
    type: fileMemory
    options:
      label: learned
      source: ./learned.md
      mutable: true
      origin: system
      priority: high
      placement: preamble
      eviction: drop

  - name: files
    type: filesystem
    options:
      mounts:
        - name: skills
          path: ./skills
          writable: false
        - name: workspace
          path: ./workspace
          writable: true
          deletable: true

  - name: fetch
    type: webFetch
    options:
      timeoutMs: 15000

  - name: web
    type: webTransport
    options:
      port: 8080
      auth:
        type: bearer
        token: \${AUGGY_WEB_TOKEN}
`;
}

function identityTemplate(
  name: string,
  purpose: string,
  skillManifest: string,
): string {
  return `# ${name}

You are ${name}, an Auggy agent. ${purpose}.

## Core behaviors

- Be helpful and concise.
- Use your tools when appropriate.
- Read skill guides before using unfamiliar tools.

${skillManifest}
`;
}

const MEMORY_SKILL_TEMPLATE = `---
name: memory
description: When and how to use memory_read, memory_write, memory_search, memory_list tools.
---

# Memory Tools

## When to use each tool

| Situation | Tool | Example |
|---|---|---|
| Need specific labeled content | memory_read | \`memory_read("self")\` for identity |
| Need to find something by content | memory_search | \`memory_search("coffee")\` |
| Need to persist something | memory_write | \`memory_write("learned", "...")\` |
| Need to see what's available | memory_list | Check labels before reading |

## Common mistakes

| Wrong | Correct |
|-------|---------|
| memory_search when you know the label | memory_read with the exact label |
| Writing to an immutable label | Check memory_list first |
| Searching with very long queries | Keep search queries to key phrases |
`;

const WEB_FETCH_SKILL_TEMPLATE = `---
name: web-fetch
description: Fetch URLs, read web pages, and call HTTP APIs using the web_fetch tool.
---

# Web Fetch

You have a \`web_fetch\` tool that retrieves content from URLs.

## When to use it

| Situation | Action |
|---|---|
| User shares a URL | Fetch it and summarize the content |
| Need to check a web page | Fetch the URL |
| Need to call an API | Fetch the API endpoint |
| User asks about a link | Fetch and read it |

## How to use it

\`\`\`
web_fetch({ url: "https://example.com", prompt: "summarize this page" })
\`\`\`

**Parameters:**
- \`url\` — the URL to fetch (http:// URLs are auto-upgraded to https://)
- \`prompt\` — what you want to know about the content

## What it returns

- For **web pages**: stripped HTML to readable text, summarized based on your prompt
- For **JSON APIs**: the raw JSON response (up to 20K chars)

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Telling the user you can't access URLs | Use \`web_fetch\` — you CAN fetch URLs |
| Fetching without a prompt | Always include a prompt describing what you need |
`;

const ENV_TEMPLATE = `# Auggy agent secrets — this file is gitignored.
# Add your API keys and tokens here. Only the key matching the
# configured engine.provider in agent.yaml needs to be filled in.

ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
AUGGY_WEB_TOKEN=
# SUPABASE_URL=
# SUPABASE_SERVICE_KEY=
`;

const GITIGNORE_TEMPLATE = `.env
.env.local
workspace/
*.log
*.err
node_modules/
`;
