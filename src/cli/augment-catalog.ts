/**
 * Augment catalog — metadata for all built-in augments.
 *
 * Used by `auggy create` (interactive selection) and `auggy add`
 * (add to existing agent). Each entry describes what the augment
 * does, its default config, and whether it ships with a bundled skill
 * folder under `src/augments/<type>/skill/`.
 *
 * Skills are no longer carried as inline string templates here. Per
 * ADR-025 + PR α task 4, scaffold copies `src/augments/<name>/skill/`
 * into the agent dir directly; the catalog only records *whether* a
 * bundled skill exists so the create UI can label entries accurately.
 * The `scaffold-skills` module is the single source of truth for the
 * type → folder mapping.
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
  /**
   * Whether this augment ships a bundled `src/augments/<type>/skill/` folder
   * the scaffold copies into the agent dir. Authoritative state lives on
   * disk; this flag is informational for the create UI.
   */
  hasSkill: boolean;
  /**
   * External npm packages this augment requires in the agent's `package.json`.
   * Written by `auggy create` / `auggy add` and installed via `bun install`.
   * Built-in augments with no SDK dependency (those satisfied entirely by
   * auggy core) leave this undefined.
   *
   * Per-engine adapter packages (`@auggy/anthropic` etc.) are NOT declared
   * here — engine selection is keyed off `engine.provider` and mapped via
   * `PROVIDER_TO_PACKAGE` in `scaffold-package-json.ts`.
   */
  packageDeps?: Record<string, string>;
}

export const AUGMENT_CATALOG: CatalogEntry[] = [
  // NOTE on identity: the agent's identity preamble is mounted via the
  // top-level `identity: ./identity.md` shorthand (see config-parser §α-5),
  // not via a catalog entry. Keeping an explicit fileMemory@system entry
  // here AND emitting the shorthand would trigger α-5's conflict check on
  // the very first scaffold. The scaffold and the create command emit the
  // shorthand directly; the catalog never carries an identity row.
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
    hasSkill: false,
  },
  {
    label: "layeredMemory",
    description: "Peer-scoped episodic memory with provenance (SQLite or Supabase)",
    type: "layeredMemory",
    defaultName: "memory",
    defaultOptions: {
      backend: "sqlite",
      dbPath: "./memory.sqlite",
      namespace: "ep",
      retentionDays: 90,
    },
    required: true,
    hasSkill: true,
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
    description:
      "AG-UI chat endpoint (HTTP + SSE) — bearer-gated by default; opt-in to anonymous chat via allowAnonymous",
    type: "webTransport",
    defaultName: "web",
    defaultOptions: {
      port: 8080,
      auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
      visitorTokens: {
        // signingKey is NOT set here — visitorAuth is the single source of truth
        // and the resolver injects it. Setting it here would trigger the
        // duplicate-key warning on every boot.
        agentBinding: "${AUGGY_AGENT_ID}",
      },
    },
    required: false,
    envVars: ["AUGGY_WEB_TOKEN", "AUGGY_AGENT_ID"],
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
    packageDeps: { "@supabase/supabase-js": "^2.103.0" },
  },
  {
    label: "orgContext",
    description: "Connect to org knowledge API (manifest + org_fetch)",
    type: "orgContext",
    defaultName: "org",
    defaultOptions: {
      // Default to file:// scheme pointing at the scaffolded example dir
      // (per α-6 + spec §Decision 9). Operators wanting an HTTP-served
      // manifest replace this with `${ORG_CONTEXT_URL}` and provide the env.
      baseUrl: "file://./org-context",
    },
    required: false,
    hasSkill: true,
  },
  {
    // ADR-030: model-facing skill surface. Emits a single system-placement
    // context block listing each mounted skill's name + description (read
    // from each SKILL.md's YAML frontmatter, agentskills.io standard).
    // Activation is fs_read via the filesystem augment. Required because
    // without it no skills are surfaced to the model; operators wanting an
    // agent with literally zero skill discovery can edit agent.yaml after
    // scaffolding.
    label: "skills",
    description: "Lists mounted skills for the model (ADR-030 skill surface)",
    type: "skills",
    defaultName: "skills",
    defaultOptions: {
      dir: "./skills",
    },
    required: true,
    // The augment itself carries no skill — it IS the skill surface.
    hasSkill: false,
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
  {
    label: "Turn Control",
    description:
      "Lets the agent pause and request input from the user. Recommended for chat-shaped agents (web/telegram).",
    type: "turnControl",
    defaultName: "turn-control",
    defaultOptions: {},
    required: false,
    hasSkill: true,
  },
  {
    label: "link",
    description:
      "Peer-to-peer A2A v0.2 transport (auggy ↔ auggy / A2A-speaking peers) via @auggy/link",
    type: "link",
    defaultName: "link",
    defaultOptions: {
      port: 8081,
      dbPath: "./link.db",
      agentCard: {
        id: "${AUGGY_AGENT_ID}",
        name: "${AUGGY_AGENT_NAME}",
        description: "augment-1 link endpoint",
        endpointUrl: "${AUGGY_LINK_PUBLIC_URL}",
      },
      peers: {},
    },
    required: false,
    envVars: ["AUGGY_AGENT_ID", "AUGGY_AGENT_NAME", "AUGGY_LINK_PUBLIC_URL"],
    hasSkill: false,
    packageDeps: { "@auggy/link": "^0.1.2" },
  },
  {
    label: "Visitor Auth",
    description:
      "Email magic-link verification — promotes anonymous visitors to recognized identity",
    type: "visitorAuth",
    defaultName: "visitor-auth",
    defaultOptions: {
      publicUrl: "${AUGGY_PUBLIC_URL}",
      dbPath: "./visitor-auth.db",
      agentMail: {
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
        subjectPrefix: "[Verify] ",
      },
      signingKey: "${VISITOR_SIGNING_KEY}",
      agentBinding: "${AUGGY_AGENT_ID}",
      rateLimit: { perHour: 1, perDay: 3 },
      reverifyAfterDays: 90,
      tokenTtlMinutes: 15,
      layeredMemoryDbPath: "./memory.db",
    },
    required: false,
    envVars: [
      "AGENTMAIL_API_KEY",
      "AGENTMAIL_INBOX_ID",
      "AUGGY_PUBLIC_URL",
      "VISITOR_SIGNING_KEY",
      "AUGGY_AGENT_ID",
    ],
    hasSkill: true,
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
