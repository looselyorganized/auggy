/**
 * Augment catalog — metadata for all built-in augments.
 *
 * Used by `auggy create` and `auggy augment add`
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
  /**
   * Short one-line summary (~50 chars) shown next to the label in the
   * augment picker. Keeps the picker readable at any terminal width.
   */
  tagline: string;
  /**
   * Long-form description shown in the picker's detail panel for the
   * focused row, and in docs. Can run multiple sentences; the picker
   * renders it below the list, not inline.
   */
  description: string;
  /** Augment factory identifier written to augments/<id>/augment.yaml. */
  type: string;
  /** Default installed id and folder name. */
  defaultName: string;
  /** Default config written to augment.yaml. */
  defaultOptions: Record<string, unknown>;
  /** Whether this augment is always included (not deselectable). */
  required: boolean;
  /** v1.0 product surface. Core is installed by create; stable is supported post-create; preview warns on add. */
  stability: "core" | "stable" | "preview";
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
   * Written by `auggy create` / `auggy augment add` and installed via `bun install`.
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
    label: "File Memory",
    tagline: "learned-behaviors store",
    description:
      "Mutable file for creator-approved, agent-global learned behaviors (./learned-behaviors.md). Mounted as operator-origin guidance and writable only from creator-trust turns.",
    type: "fileMemory",
    defaultName: "fileMemory",
    defaultOptions: {
      label: "learned",
      source: "./learned-behaviors.md",
      mutable: true,
      origin: "operator",
      writeTrustLevels: ["creator"],
      priority: "high",
      placement: "preamble",
      eviction: "drop",
    },
    required: true,
    stability: "core",
    hasSkill: false,
  },
  {
    label: "Layered Memory",
    tagline: "peer-scoped memory for repeat visitors",
    description:
      "Per-peer episodic memory with provenance tracking. Stores remembered visitor and creator context in SQLite by default; Supabase is available for manual configs.",
    type: "layeredMemory",
    defaultName: "layeredMemory",
    defaultOptions: {
      backend: "sqlite",
      dbPath: "./memory.db",
      namespace: "ep",
      retentionDays: 90,
      autoSave: { enabled: false },
    },
    required: false,
    stability: "stable",
    hasSkill: true,
  },
  {
    label: "Filesystem",
    tagline: "scoped read/write + skills directory",
    description:
      "Scoped file access with two mounts: ./skills (read-only) and ./workspace (read/write/delete), plus a bounded per-turn workspace catalog so the agent can notice and reuse durable artifacts.",
    type: "filesystem",
    defaultName: "filesystem",
    defaultOptions: {
      mounts: [
        { name: "skills", path: "./skills", writable: false },
        { name: "workspace", path: "./workspace", writable: true, deletable: true },
      ],
      workspaceAwareness: { enabled: true, maxEntries: 24, maxDepth: 4 },
    },
    required: true,
    stability: "core",
    hasSkill: true,
  },
  {
    label: "Web Transport",
    tagline: "chat over HTTP+SSE + the /console operator UI",
    description:
      "Exposes the agent on a port: AG-UI chat endpoint (SSE), the /console operator surface, and /health. Bearer-gated on non-loopback; loopback is open. Required if you want anything besides the CLI to talk to the agent.",
    type: "webTransport",
    defaultName: "webTransport",
    defaultOptions: {
      port: 8080,
      publicIntegration: false,
      auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
      visitorTokens: {
        // signingKey is NOT set here — visitorAuth is the single source of truth
        // and the resolver injects it. Setting it here would trigger the
        // duplicate-key warning on every boot.
        agentBinding: "${AUGGY_AGENT_ID}",
      },
    },
    required: true,
    stability: "core",
    envVars: ["AUGGY_WEB_TOKEN", "AUGGY_AGENT_ID"],
    hasSkill: false,
  },
  {
    label: "Web Fetch",
    tagline: "fetch URLs / scrape pages / call HTTP APIs",
    description:
      "Gives the agent a fetch tool: GET any public URL, parse HTML to text, pass JSON through. SSRF guard blocks loopback + private IPs by default.",
    type: "webFetch",
    defaultName: "webFetch",
    defaultOptions: {
      timeoutMs: 15000,
    },
    required: true,
    stability: "core",
    hasSkill: true,
  },
  {
    label: "Knowledge",
    tagline: "local docs and API-backed knowledge sources",
    description:
      "Catalog of local files and remote knowledge APIs the agent can fetch to answer questions about your org or project. Defaults to ./knowledge/ on disk.",
    type: "knowledge",
    defaultName: "knowledge",
    defaultOptions: {
      root: "./knowledge",
    },
    required: false,
    stability: "stable",
    hasSkill: true,
  },
  // `skills` (ADR-030 model-facing skill surface) is NOT in the catalog.
  // It's auggy runtime infrastructure, not a feature operators choose.
  // Auto-mounted by `augment-resolver.ts` if not explicitly declared in
  // agent.yaml. See docs/solutions/architecture/adr-NNN-augment-catalog-policy.md.
  {
    label: "Bash",
    tagline: "scoped shell execution (allowlist + risk levels)",
    description:
      "Preview host process execution, not a sandbox. Creator-only by default with a small allowlist (echo, ls, cat, pwd, date). Configure risk level + allowlist in augments/bash/augment.yaml.",
    type: "bash",
    defaultName: "bash",
    defaultOptions: {
      risk: "restricted",
      allowedCommands: ["echo", "ls", "cat", "pwd", "date"],
    },
    required: false,
    stability: "preview",
    hasSkill: true,
  },
  {
    label: "Budgets",
    tagline: "spend caps per trust level (turns + $/day)",
    description:
      "Preview runtime spend guardrails, not billing control. Caps turns and settled USD per trust level with a post-hoc daily soft cap. SQLite-backed and single-process.",
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
    stability: "preview",
    hasSkill: false,
  },
  {
    label: "Notify",
    tagline: "send outbound alerts to operators",
    description:
      "Lets the agent ping you when something happens. Adapters: log-to-file (default), webhook, telegram, agentmail. Per-destination rate limit + dedup.",
    type: "notify",
    defaultName: "notify",
    defaultOptions: {
      // log-to-file default: zero-config out of the box. The agent appends
      // a JSON-line per notification to `./notifications.jsonl` (relative
      // to the agent dir at boot CWD). Operators wanting real delivery
      // replace this destination with a webhook / telegram / agentmail
      // entry. See `docs/13-notify.md` for the per-transport schema.
      destinations: [
        {
          name: "creator",
          transport: "log-to-file",
          path: "./notifications.jsonl",
          allowedTrustLevels: ["creator", "agent"],
        },
      ],
      rateLimit: {
        cooldownMs: 120_000,
        globalMaxPerHour: 5,
        dedupWindowMs: 300_000,
        dedupThreshold: 0.6,
        perPeerCooldownMs: 30_000,
      },
    },
    required: false,
    stability: "stable",
    // No env vars in the default scaffold — log-to-file needs none.
    // Operators switching to webhook destinations will add ORG_NOTIFY_URL
    // (or similar) manually.
    hasSkill: true,
  },
  {
    label: "MCP",
    tagline: "call external MCP servers",
    description:
      "Lets the agent use tools exposed by MCP servers. Server definitions live in .mcp.json so they stay portable across Claude Code/Cursor-style MCP configs. Local stdio servers work locally; cloud deploys require remote HTTP MCP or explicitly disabled local servers.",
    type: "mcp",
    defaultName: "mcp",
    defaultOptions: {},
    required: false,
    stability: "stable",
    hasSkill: true,
  },
  {
    label: "Agent Mail",
    tagline: "send email through AgentMail",
    description:
      "Lets the agent send email (send / reply / forward) via AgentMail. Trust-level gate, recipient allowlist, rate limits, dedup, audit ring. Requires AGENTMAIL_API_KEY + AGENTMAIL_INBOX_ID.",
    type: "agentMail",
    defaultName: "agentMail",
    defaultOptions: {
      apiKey: "${AGENTMAIL_API_KEY}",
      inboxId: "${AGENTMAIL_INBOX_ID}",
      dbPath: "./agent-mail.db",
      outbound: {
        allowedTrustLevels: ["creator"],
        subjectPrefix: "[Auggy] ",
        maxRecipients: 10,
        bodyMaxBytes: 102_400,
        allowHtml: false,
        rateLimit: {
          globalMaxPerHour: 10,
          perRecipientCooldownMs: 300_000,
          dedupWindowMs: 300_000,
        },
      },
      inbound: { mode: "none" },
    },
    required: false,
    stability: "stable",
    envVars: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID"],
    hasSkill: true,
  },
  {
    label: "Telegram Transport",
    tagline: "chat with the agent from Telegram",
    description:
      "Bidirectional Telegram chat. Long-poll or webhook inbound. Four-path identity (creator user IDs, recognized via visitorAuth, anonymous). Requires TELEGRAM_BOT_TOKEN.",
    type: "telegramTransport",
    defaultName: "telegramTransport",
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
        creatorUserIdsEnv: "TELEGRAM_CREATOR_USER_IDS",
        anonymousIdentityMode: "ephemeral",
      },
    },
    required: false,
    stability: "stable",
    envVars: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CREATOR_USER_IDS"],
    hasSkill: false,
  },
  {
    label: "Turn Control",
    tagline: "agent can pause + ask for clarification",
    description:
      "Gives the agent a request_input tool that ends the turn waiting for a reply. Recommended for chat-shaped agents (web/telegram) — without it the agent always produces a final answer.",
    type: "turnControl",
    defaultName: "turnControl",
    defaultOptions: {},
    required: true,
    stability: "core",
    hasSkill: true,
  },
  {
    label: "Link",
    tagline: "peer-to-peer A2A (auggy ↔ auggy / A2A peers)",
    description:
      "Preview peer-to-peer A2A transport. Opens a separate inbound port and dials configured peers outbound. Configured peer bearers currently admit peers as agent trust.",
    type: "link",
    defaultName: "link",
    defaultOptions: {
      port: 8081,
      dbPath: "./link.db",
      agentCard: {
        id: "${AUGGY_AGENT_ID}",
        name: "${AUGGY_AGENT_NAME}",
        description: "Auggy link endpoint",
        endpointUrl: "${AUGGY_LINK_PUBLIC_URL}",
      },
      peers: {},
    },
    required: false,
    stability: "preview",
    envVars: ["AUGGY_AGENT_ID", "AUGGY_AGENT_NAME", "AUGGY_LINK_PUBLIC_URL"],
    hasSkill: true,
    packageDeps: { "@auggy/link": "^0.1.2" },
  },
  {
    label: "Visitor Auth",
    tagline: "email magic-link → recognized visitor",
    description:
      "Promotes anonymous chat visitors to recognized identity via email magic-link. Console mode (default) prints verify links to stdout for local testing; switch to agentmail transport for production mail delivery.",
    type: "visitorAuth",
    defaultName: "visitorAuth",
    defaultOptions: {
      publicUrl: "${AUGGY_PUBLIC_URL}",
      dbPath: "./visitor-auth.db",
      // Console mail by default — verify links print to the agent's stdout
      // for local OSS testing without AgentMail credentials. Switch to
      // `transport: "agentmail"` + provide AGENTMAIL_API_KEY/AGENTMAIL_INBOX_ID
      // for production mail delivery. See `docs/19-visitor-auth.md`.
      agentMail: {
        transport: "console",
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
    stability: "stable",
    // AGENTMAIL_API_KEY + AGENTMAIL_INBOX_ID intentionally omitted — they're
    // only needed when the operator switches `agentMail.transport` to
    // "agentmail". AUGGY_PUBLIC_URL, VISITOR_SIGNING_KEY, AUGGY_AGENT_ID
    // are auto-generated by the scaffold (see AUTO_GENERATED_ENV_VARS in
    // commands/create.ts).
    envVars: ["AUGGY_PUBLIC_URL", "VISITOR_SIGNING_KEY", "AUGGY_AGENT_ID"],
    hasSkill: true,
  },
];

/**
 * Resolve an augment specifier to a catalog entry. Augment commands use one
 * code vocabulary: the YAML `type:`/`name:` identifier (`webFetch`,
 * `visitorAuth`, etc.). Human labels are display-only.
 */
export function resolveCatalogEntry(specifier: string): CatalogEntry | null {
  const normalized = specifier.trim();
  if (!normalized) return null;

  return (
    AUGMENT_CATALOG.find(
      (entry) => entry.type === normalized || entry.defaultName === normalized,
    ) ?? null
  );
}

export function validAugmentSpecifiers(): string[] {
  const names = new Set<string>();
  for (const entry of AUGMENT_CATALOG) {
    names.add(entry.type);
    names.add(entry.defaultName);
  }
  return [...names].sort();
}

/** Get catalog entries that are not yet installed (by type). */
export function getAvailableAugments(
  installed: Array<{ type: string; name?: string }>,
): CatalogEntry[] {
  return AUGMENT_CATALOG.filter((entry) => !installed.some((i) => i.type === entry.type));
}
