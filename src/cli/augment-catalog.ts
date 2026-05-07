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

const ORG_CONTEXT_SKILL = `---
name: org-context
description: Fetch org knowledge using the org_fetch tool.
---

# Org Context

You are connected to your organization's knowledge base.

## org_fetch — retrieve org knowledge

| Situation | Endpoint | Example |
|---|---|---|
| Visitor asks about the facility | /vision | \`org_fetch({ endpoint: "/vision" })\` |
| Visitor asks about projects | /initiatives | \`org_fetch({ endpoint: "/initiatives" })\` |
| Need architecture decisions | /solutions/architecture | \`org_fetch({ endpoint: "/solutions/architecture" })\` |
| Need research findings | /solutions/research | \`org_fetch({ endpoint: "/solutions/research" })\` |

Check your org context manifest (in your system prompt) for available endpoints.

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Saying "I don't know what LORF is" | Use org_fetch to check /vision |
| Fetching all endpoints every turn | Only fetch what's relevant to the conversation |
`;

const BASH_SKILL = `---
name: bash
description: Run shell commands using shell_exec and operator-defined scripts using run_script.
---

# Bash

Run shell commands and operator-defined scripts.

## shell_exec — run a command

Returns JSON: \`{ stdout, stderr, exitCode, durationMs, truncated, command }\`

- **exitCode 0** = success. Non-zero = failure (check stderr).
- **truncated: true** means output was cut at the byte limit.
- The operator configures which commands are allowed. If rejected, the error says why.

## run_script — run a named script

Scripts are pre-defined by the operator. Check the tool description for available scripts.

## When to use

- System diagnostics: disk, memory, uptime, process lists
- Version control: git status, git log, git diff
- Build and deploy: operator-defined deploy scripts
- Data processing: piping, jq, text manipulation

## When NOT to use

- Reading/writing files in mounted directories — use filesystem tools instead
- Fetching URLs — use web_fetch instead
- Anything destructive without clear operator intent

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Destructive operations without operator request | Ask before any destructive command |
| Ignoring non-zero exit codes | Check exitCode and stderr, report failures |
| Running commands that prompt for input | Only run non-interactive commands |
`;

const NOTIFY_SKILL = `---
name: notify
description: Send notifications to operator-defined destinations using the notify tool.
---

# Notify

You have a \`notify\` tool that sends messages to destinations the operator has configured.

## When to use

| Situation | Example |
|---|---|
| Visitor asks to speak with a human | \`notify({ to: "creator", summary: "Visitor wants partnership discussion", reason: "Outside my scope" })\` |
| You completed a long-running task | \`notify({ to: "creator", summary: "Daily report ready", reason: "End of day summary attached" })\` |
| Something needs human approval | \`notify({ to: "creator", summary: "Permission requested for X", reason: "Visitor requested Y" })\` |

Use named destinations from your agent's configuration. Common destinations: \`creator\` (the agent's owner), \`ops\` (operations channel), \`alerts\` (urgent issues).

## Tool surface

\`\`\`
notify({ to: "<destination-name>", summary: "...", reason?: "...", visitor?: "..." })
\`\`\`

Returns \`{ status: "sent" | "rate_limited" | "failed", message?: string }\`.

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Sending raw chat IDs as \`to:\` | Use the destination NAME from config |
| Calling notify in a loop | Each call counts against rate limits |
| Calling notify for routine acknowledgments | Reserve for things needing operator awareness |
`;

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
  {
    label: "layeredMemory",
    description: "Peer-scoped episodic memory with provenance (SQLite or Supabase)",
    type: "layeredMemory",
    defaultName: "episodic",
    defaultOptions: {
      backend: "sqlite",
      dbPath: "./memory.db",
      namespace: "ep",
      retentionDays: 90,
    },
    required: false,
    hasSkill: false,
  },
  {
    label: "orgContext",
    description: "Connect to org knowledge API (manifest + org_fetch)",
    type: "orgContext",
    defaultName: "org",
    defaultOptions: {
      baseUrl: "${ORG_CONTEXT_URL}",
    },
    required: false,
    envVars: ["ORG_CONTEXT_URL"],
    hasSkill: true,
    skillTemplate: ORG_CONTEXT_SKILL,
  },
  {
    label: "bash",
    description: "Execute shell commands with configurable risk levels",
    type: "bash",
    defaultName: "bash",
    defaultOptions: {
      risk: "restricted",
      allowedCommands: ["echo", "ls", "cat", "pwd", "date"],
    },
    required: false,
    hasSkill: true,
    skillTemplate: BASH_SKILL,
  },
  {
    label: "budgets",
    description: "Per-trust-level turn budgets + dailyBudgetUsd ceiling (SQLite)",
    type: "budgets",
    defaultName: "budgets",
    defaultOptions: {
      dbPath: "./budgets.db",
      caps: {
        public: {
          recognized: { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1 },
          anonymous: { maxTurnsPerThread: 5 },
        },
      },
      anonymousGlobalLimit: 30,
      dailyBudgetUsd: 5,
    },
    required: false,
    hasSkill: false,
  },
  {
    label: "notify",
    description:
      "Outbound messaging to operator-defined destinations (webhook + telegram + agentmail adapters)",
    type: "notify",
    defaultName: "notify",
    defaultOptions: {
      destinations: [{ name: "creator", transport: "webhook", url: "${ORG_NOTIFY_URL}" }],
      rateLimit: {
        cooldownMs: 120_000,
        globalMaxPerHour: 5,
        dedupWindowMs: 300_000,
        dedupThreshold: 0.6,
        perPeerCooldownMs: 30_000,
      },
    },
    required: false,
    envVars: ["ORG_NOTIFY_URL"],
    hasSkill: true,
    skillTemplate: NOTIFY_SKILL,
  },
  {
    label: "telegramTransport",
    description: "Bidirectional Telegram I/O — long-poll OR webhook inbound, four-path identity",
    type: "telegramTransport",
    defaultName: "telegram",
    defaultOptions: {
      botToken: "${TELEGRAM_BOT_TOKEN}",
      inbound: {
        mode: "polling",
        polling: { timeoutSec: 30 },
        // To switch to webhook mode, replace the polling block with:
        // mode: "webhook"
        // webhook: { publicUrl: "${TELEGRAM_WEBHOOK_URL}", port: 8081, secretToken: "${TELEGRAM_WEBHOOK_SECRET}" }
      },
      auth: {
        creatorUserIds: [],
        anonymousIdentityMode: "ephemeral",
      },
    },
    required: false,
    envVars: ["TELEGRAM_BOT_TOKEN"],
    hasSkill: false,
  },
];

/** Get catalog entries that are not yet installed (by type + defaultName). */
export function getAvailableAugments(
  installed: Array<{ type: string; name: string }>,
): CatalogEntry[] {
  return AUGMENT_CATALOG.filter(
    (entry) => !installed.some((i) => i.type === entry.type && i.name === entry.defaultName),
  );
}
