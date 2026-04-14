/**
 * Augment catalog — metadata for all built-in augments.
 *
 * Used by `aug1 create` (interactive selection) and `aug1 add`
 * (add to existing agent). Each entry describes what the augment
 * does, its default config, and whether it has a skill file.
 */

export interface CatalogEntry {
  /** Display name for selection UI. */
  label: string;
  /** Short description shown in the selector. */
  description: string;
  /** The augment type identifier in agent.yaml. */
  type: string;
  /** Default instance name in agent.yaml. */
  defaultName: string;
  /** Default options for agent.yaml. */
  defaultOptions: Record<string, unknown>;
  /** Whether this augment is always included (not deselectable). */
  required: boolean;
  /** Env vars this augment needs (shown in .env.example). */
  envVars?: string[];
  /** Whether this augment ships with a SKILL.md. */
  hasSkill: boolean;
  /** The skill template content, if hasSkill is true. */
  skillTemplate?: string;
}

// ---------------------------------------------------------------------------
// Skill templates
// ---------------------------------------------------------------------------

const MEMORY_SKILL = `---
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

const WEB_FETCH_SKILL = `---
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

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const AUGMENT_CATALOG: CatalogEntry[] = [
  {
    label: "fileMemory (identity)",
    description: "Agent identity — who it is, how it behaves",
    type: "fileMemory",
    defaultName: "identity",
    defaultOptions: {
      label: "self",
      source: "./identity.md",
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    },
    required: true,
    hasSkill: false,
  },
  {
    label: "fileMemory (learned)",
    description: "Mutable memory — agent writes learned behaviors here",
    type: "fileMemory",
    defaultName: "learned",
    defaultOptions: {
      label: "learned",
      source: "./learned.md",
      mutable: true,
      origin: "system",
      priority: "high",
      placement: "preamble",
      eviction: "drop",
    },
    required: true,
    hasSkill: true,
    skillTemplate: MEMORY_SKILL,
  },
  {
    label: "filesystem",
    description: "Read/write files — skills directory + workspace",
    type: "filesystem",
    defaultName: "files",
    defaultOptions: {
      mounts: [
        { name: "skills", path: "./skills", writable: false },
        { name: "workspace", path: "./workspace", writable: true, deletable: true },
      ],
    },
    required: true,
    hasSkill: true,
  },
  {
    label: "webTransport",
    description: "AG-UI chat endpoint (HTTP + SSE)",
    type: "webTransport",
    defaultName: "web",
    defaultOptions: {
      port: 8080,
      auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
    },
    required: false,
    envVars: ["AUGGY_WEB_TOKEN"],
    hasSkill: false,
  },
  {
    label: "webFetch",
    description: "Fetch URLs, read web pages, call HTTP APIs",
    type: "webFetch",
    defaultName: "fetch",
    defaultOptions: {
      timeoutMs: 15000,
    },
    required: false,
    hasSkill: true,
    skillTemplate: WEB_FETCH_SKILL,
  },
  {
    label: "supabaseMemory",
    description: "Episodic memory backed by Supabase (visitor profiles, events)",
    type: "supabaseMemory",
    defaultName: "episodic",
    defaultOptions: {
      namespace: "episode",
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
      supabaseUrl: "${SUPABASE_URL}",
      supabaseKey: "${SUPABASE_SERVICE_KEY}",
    },
    required: false,
    envVars: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
    hasSkill: false,
  },
];

/** Get catalog entries that are not yet installed (by type + defaultName). */
export function getAvailableAugments(
  installed: Array<{ type: string; name: string }>,
): CatalogEntry[] {
  return AUGMENT_CATALOG.filter(
    (entry) =>
      !installed.some(
        (i) => i.type === entry.type && i.name === entry.defaultName,
      ),
  );
}
