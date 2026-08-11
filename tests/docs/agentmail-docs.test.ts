import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AGENTMAIL_MAX_ALLOWED_SENDERS,
  AGENTMAIL_MAX_ATTEMPTS,
  AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR,
  AGENTMAIL_MAX_INBOUND_GLOBAL_PER_HOUR,
  AGENTMAIL_MAX_INBOUND_PER_SENDER_PER_HOUR,
  AGENTMAIL_MAX_POLL_INTERVAL_MS,
  AGENTMAIL_MAX_PROMPT_BYTES,
  AGENTMAIL_MIN_POLL_INTERVAL_MS,
  AGENTMAIL_MIN_PROMPT_BYTES,
  resolveAgentMailInboundReplies,
  validateAgentMailInboundConfig,
} from "../../src/augments/agentMail/inbound-policy";
import {
  AGENTMAIL_ATTENTION_DEFAULT_MAX_RECORDS,
  AGENTMAIL_ATTENTION_DEFAULT_RETENTION_MS,
} from "../../src/augments/agentMail/creator-attention";
import {
  AGENTMAIL_DIGEST_DEFAULT_MAX_BATCHES,
  AGENTMAIL_DIGEST_DEFAULT_MAX_ITEMS,
  AGENTMAIL_DIGEST_DEFAULT_RETENTION_MS,
} from "../../src/augments/agentMail/creator-digest";
import {
  AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS,
  AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS,
  AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS,
  AGENTMAIL_CREATOR_DIGEST_MAX_ATTEMPTS,
  AGENTMAIL_CREATOR_DIGEST_MAX_INTERVAL_MS,
  AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS,
  AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS,
  resolveAgentMailCreatorDigestConfig,
} from "../../src/augments/agentMail/creator-digest-policy";
import {
  AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX,
  createAgentMailInboundLedger,
} from "../../src/augments/agentMail/inbound-ledger";
import { normalizeSubject, validateOutbound } from "../../src/augments/agentMail/outbound";
import {
  checkRateLimit,
  createRateLimitState,
  recordSend,
} from "../../src/augments/agentMail/rate-limit";
import { createAgentMailReviewQueue } from "../../src/augments/agentMail/review-queue";
import type { AgentMailProvisioningClient } from "../../src/cli/agentmail-provisioning";
import { formatAgentMailSetupResult, runAgentMailSetup } from "../../src/cli/commands/agentmail";
import { parseConfig } from "../../src/cli/config-parser";
import { AUGMENT_CATALOG } from "../../src/cli/augment-catalog";
import type {
  AgentMailAugmentOptions,
  AgentMailCreatorDigestOptions,
  AgentMailInboundConfig,
  AgentMailInboundRateLimitOptions,
  AgentMailInboundReplyOptions,
  AgentMailOutboundOptions,
  AgentMailRateLimitOptions,
} from "../../src/types";

const DOC_PATH = resolve(import.meta.dir, "../../docs/22-agent-mail.md");
const AGENT_ID = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";
const INBOX_ID = "inb_docs_contract";
const INBOX_EMAIL = "docs-contract@agentmail.to";

const AGENTMAIL_YAML_CONTAINERS = [
  "outbound",
  "outbound.rateLimit",
  "outbound.humanReview",
  "inbound",
  "inbound.rateLimit",
  "inbound.classifications",
  "inbound.replies",
  "inbound.webhook",
  "inbound.creatorDigest",
] as const;

const AGENTMAIL_YAML_SETTINGS = [
  "apiKey",
  "inboxId",
  "emailAddress",
  "addressVisibility",
  "apiBaseUrl",
  "allowInsecureHttpWithCredentials",
  "dbPath",
  "outbound.allowedTrustLevels",
  "outbound.allowedRecipients",
  "outbound.maxRecipients",
  "outbound.bodyMaxBytes",
  "outbound.allowHtml",
  "outbound.subjectPrefix",
  "outbound.rateLimit.enabled",
  "outbound.rateLimit.globalMaxPerHour",
  "outbound.rateLimit.perRecipientCooldownMs",
  "outbound.rateLimit.dedupWindowMs",
  "outbound.humanReview.requiredForTrustLevels",
  "outbound.humanReview.expiresAfterMs",
  "inbound.mode",
  "inbound.allowedSenders",
  "inbound.allowAnySender",
  "inbound.rateLimit.globalMaxPerHour",
  "inbound.rateLimit.perSenderMaxPerHour",
  "inbound.pollIntervalMs",
  "inbound.maxPromptBytes",
  "inbound.maxAttempts",
  "inbound.websocketBaseUrl",
  "inbound.classifications.received",
  "inbound.classifications.spam",
  "inbound.classifications.blocked",
  "inbound.classifications.unauthenticated",
  "inbound.replies.mode",
  "inbound.replies.allowReplyAll",
  "inbound.webhook.path",
  "inbound.webhook.secretEnv",
  "inbound.webhook.timestampToleranceSeconds",
  "inbound.creatorDigest.enabled",
  "inbound.creatorDigest.destination",
  "inbound.creatorDigest.intervalMs",
  "inbound.creatorDigest.maxItems",
  "inbound.creatorDigest.maxAttempts",
] as const;

const RECIPES = [
  {
    heading: "Send email only",
    companions: [] as const,
    permissions: ["inbox_read", "message_send"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "dbPath",
      "emailAddress",
      "inbound",
      "inbound.mode",
      "inboxId",
      "outbound",
      "outbound.allowHtml",
      "outbound.allowedTrustLevels",
      "outbound.bodyMaxBytes",
      "outbound.humanReview",
      "outbound.humanReview.expiresAfterMs",
      "outbound.humanReview.requiredForTrustLevels",
      "outbound.maxRecipients",
      "outbound.rateLimit",
      "outbound.rateLimit.dedupWindowMs",
      "outbound.rateLimit.globalMaxPerHour",
      "outbound.rateLimit.perRecipientCooldownMs",
      "outbound.subjectPrefix",
    ],
  },
  {
    heading: "Send `visitorAuth` magic links through the shared inbox",
    companions: ["visitorAuth", "webTransport"] as const,
    permissions: ["inbox_read", "message_send"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.mode",
      "inboxId",
    ],
  },
  {
    heading: "Receive allowlisted email over WebSocket, with replies disabled",
    companions: [] as const,
    permissions: ["inbox_read", "message_send", "message_read"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.allowedSenders",
      "inbound.mode",
      "inbound.replies",
      "inbound.replies.mode",
      "inboxId",
    ],
  },
  {
    heading: "Receive email from anyone, with bounded admission",
    companions: [] as const,
    permissions: ["inbox_read", "message_send", "message_read"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.allowAnySender",
      "inbound.mode",
      "inbound.rateLimit",
      "inbound.rateLimit.globalMaxPerHour",
      "inbound.rateLimit.perSenderMaxPerHour",
      "inbound.replies",
      "inbound.replies.mode",
      "inboxId",
    ],
  },
  {
    heading: "Receive email through a verified webhook",
    companions: ["webTransport"] as const,
    permissions: ["inbox_read", "message_send", "message_read"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.allowedSenders",
      "inbound.mode",
      "inbound.replies",
      "inbound.replies.mode",
      "inbound.webhook",
      "inbound.webhook.path",
      "inbound.webhook.secretEnv",
      "inbound.webhook.timestampToleranceSeconds",
      "inboxId",
    ],
  },
  {
    heading: "Require creator review before replying",
    companions: ["webTransport"] as const,
    permissions: ["inbox_read", "message_send", "message_read"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.allowedSenders",
      "inbound.mode",
      "inbound.replies",
      "inbound.replies.allowReplyAll",
      "inbound.replies.mode",
      "inboxId",
    ],
  },
  {
    heading: "Send automatic replies within a hard hourly cap",
    companions: ["webTransport"] as const,
    permissions: ["inbox_read", "message_send", "message_read"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.allowedSenders",
      "inbound.mode",
      "inbound.replies",
      "inbound.replies.allowReplyAll",
      "inbound.replies.mode",
      "inboxId",
      "outbound",
      "outbound.rateLimit",
      "outbound.rateLimit.dedupWindowMs",
      "outbound.rateLimit.enabled",
      "outbound.rateLimit.globalMaxPerHour",
      "outbound.rateLimit.perRecipientCooldownMs",
    ],
  },
  {
    heading: "Send a creator digest for outstanding mail work",
    companions: ["notify"] as const,
    permissions: ["inbox_read", "message_send", "message_read"],
    optionPaths: [
      "addressVisibility",
      "apiKey",
      "emailAddress",
      "inbound",
      "inbound.allowedSenders",
      "inbound.creatorDigest",
      "inbound.creatorDigest.destination",
      "inbound.creatorDigest.enabled",
      "inbound.creatorDigest.intervalMs",
      "inbound.creatorDigest.maxAttempts",
      "inbound.creatorDigest.maxItems",
      "inbound.mode",
      "inbound.replies",
      "inbound.replies.mode",
      "inboxId",
    ],
  },
] as const;

type Companion = (typeof RECIPES)[number]["companions"][number];

function markdownSection(source: string, heading: string): string {
  const marker = `### ${heading}\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing AgentMail recipe heading: ${heading}`);
  const end = source.indexOf("\n### ", start + marker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

function markdownSubsection(source: string, heading: string): string {
  const marker = `#### ${heading}\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing AgentMail reference heading: ${heading}`);
  const sameLevelEnd = source.indexOf("\n#### ", start + marker.length);
  const parentEnd = source.indexOf("\n### ", start + marker.length);
  const candidates = [sameLevelEnd, parentEnd].filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function fencedYaml(source: string): string[] {
  return [...source.matchAll(/^```yaml\s*\n([\s\S]*?)^```\s*$/gm)].map((match) =>
    match[1]!.trimEnd(),
  );
}

function yamlForPath(source: string, path: string): string {
  const block = fencedYaml(source).find((yaml) => yaml.startsWith(`# ${path}\n`));
  if (!block) throw new Error(`Missing YAML block for ${path}`);
  return block;
}

function objectPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path, ...objectPaths(child, path));
  }
  return paths.sort();
}

function expectReferenceRows(
  source: string,
  subsection: string,
  rows: Readonly<Record<string, string>>,
): void {
  const section = markdownSubsection(source, subsection);
  for (const [field, label] of Object.entries(rows)) {
    const rowPrefix = `| \`${label}\` |`;
    expect(
      section.split(rowPrefix).length - 1,
      `${field} must have exactly one reference row`,
    ).toBe(1);
  }
}

function writeRecipeProject(
  root: string,
  agentMailYaml: string,
  companions: readonly Companion[],
  companionYaml: Readonly<Record<Companion, string>>,
  options: { runtimeCredentials?: boolean } = {},
): string {
  const mounts = ["agentMail", ...companions];
  writeFileSync(
    join(root, "agent.yaml"),
    [
      `id: ${AGENT_ID}`,
      "name: agentmail-docs-contract",
      "creator:",
      "  displayName: Docs Operator",
      "engine:",
      "  provider: anthropic",
      "  model: claude-sonnet-4-6",
      "augments:",
      ...mounts.map((name) => `  - ${name}`),
      "",
    ].join("\n"),
  );
  const runtimeCredentials = options.runtimeCredentials ?? true;
  writeFileSync(
    join(root, ".env"),
    [
      ...(runtimeCredentials
        ? [
            "AGENTMAIL_API_KEY=am_docs_contract_runtime",
            `AGENTMAIL_INBOX_ID=${INBOX_ID}`,
            `AGENTMAIL_INBOX_EMAIL=${INBOX_EMAIL}`,
          ]
        : []),
      "AGENTMAIL_WEBHOOK_SECRET=whsec_docs_contract_secret",
      "AUGGY_PUBLIC_URL=https://agent.example.test",
      `AUGGY_AGENT_ID=${AGENT_ID}`,
      "AUGGY_WEB_TOKEN=docs-contract-console-token-32-chars",
      `VISITOR_SIGNING_KEY=${"v".repeat(64)}`,
      "",
    ].join("\n"),
  );

  const allYaml: Record<string, string> = { agentMail: agentMailYaml };
  for (const companion of companions) allYaml[companion] = companionYaml[companion];
  for (const [name, yaml] of Object.entries(allYaml)) {
    const directory = join(root, "augments", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "augment.yaml"), `${yaml}\n`);
  }
  return join(root, "agent.yaml");
}

function docsProvisioner(): AgentMailProvisioningClient {
  const unused = async (): Promise<never> => {
    throw new Error("provider mutation must not run while validating documentation");
  };
  return {
    signUp: unused,
    verify: unused,
    createInbox: unused,
    listInboxes: unused,
    getInbox: async (_apiKey, inboxId) => ({ inboxId, email: INBOX_EMAIL }),
  };
}

async function withIsolatedAgentMailEnv<T>(run: () => Promise<T>): Promise<T> {
  const names = [
    "AGENTMAIL_API_KEY",
    "AGENTMAIL_INBOX_ID",
    "AGENTMAIL_INBOX_EMAIL",
    "AGENTMAIL_WEBHOOK_SECRET",
    "AUGGY_PUBLIC_URL",
    "AUGGY_AGENT_ID",
    "AUGGY_WEB_TOKEN",
    "VISITOR_SIGNING_KEY",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return await run();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const TOP_LEVEL_REFERENCE_ROWS = {
  apiKey: "apiKey",
  inboxId: "inboxId",
  emailAddress: "emailAddress",
  addressVisibility: "addressVisibility",
  apiBaseUrl: "apiBaseUrl",
  allowInsecureHttpWithCredentials: "allowInsecureHttpWithCredentials",
  dbPath: "dbPath",
  outbound: "outbound",
  inbound: "inbound",
} satisfies Record<Exclude<keyof AgentMailAugmentOptions, "agentDir">, string>;

const OUTBOUND_REFERENCE_ROWS = {
  allowedTrustLevels: "allowedTrustLevels",
  allowedRecipients: "allowedRecipients",
  maxRecipients: "maxRecipients",
  bodyMaxBytes: "bodyMaxBytes",
  allowHtml: "allowHtml",
  subjectPrefix: "subjectPrefix",
  rateLimit: "rateLimit",
  humanReview: "humanReview",
} satisfies Record<keyof AgentMailOutboundOptions, string>;

const OUTBOUND_RATE_REFERENCE_ROWS = {
  enabled: "rateLimit.enabled",
  globalMaxPerHour: "rateLimit.globalMaxPerHour",
  perRecipientCooldownMs: "rateLimit.perRecipientCooldownMs",
  dedupWindowMs: "rateLimit.dedupWindowMs",
} satisfies Record<keyof AgentMailRateLimitOptions, string>;

type AgentMailHumanReviewOptions = NonNullable<AgentMailOutboundOptions["humanReview"]>;
const HUMAN_REVIEW_REFERENCE_ROWS = {
  requiredForTrustLevels: "humanReview.requiredForTrustLevels",
  expiresAfterMs: "humanReview.expiresAfterMs",
} satisfies Record<keyof AgentMailHumanReviewOptions, string>;

const INBOUND_REFERENCE_ROWS = {
  mode: "mode",
  allowedSenders: "allowedSenders",
  allowAnySender: "allowAnySender",
  rateLimit: "rateLimit",
  classifications: "classifications",
  replies: "replies",
  creatorDigest: "creatorDigest",
  pollIntervalMs: "pollIntervalMs",
  maxPromptBytes: "maxPromptBytes",
  maxAttempts: "maxAttempts",
  websocketBaseUrl: "websocketBaseUrl",
  webhook: "webhook",
} satisfies Record<keyof AgentMailInboundConfig, string>;

const INBOUND_RATE_REFERENCE_ROWS = {
  globalMaxPerHour: "rateLimit.globalMaxPerHour",
  perSenderMaxPerHour: "rateLimit.perSenderMaxPerHour",
} satisfies Record<keyof AgentMailInboundRateLimitOptions, string>;

type AgentMailClassifications = NonNullable<AgentMailInboundConfig["classifications"]>;
const CLASSIFICATION_REFERENCE_ROWS = {
  received: "classifications.received",
  spam: "classifications.spam",
  blocked: "classifications.blocked",
  unauthenticated: "classifications.unauthenticated",
} satisfies Record<keyof AgentMailClassifications, string>;

const REPLY_REFERENCE_ROWS = {
  mode: "replies.mode",
  allowReplyAll: "replies.allowReplyAll",
} satisfies Record<keyof AgentMailInboundReplyOptions, string>;

type AgentMailWebhookOptions = NonNullable<AgentMailInboundConfig["webhook"]>;
const WEBHOOK_REFERENCE_ROWS = {
  path: "path",
  secretEnv: "secretEnv",
  timestampToleranceSeconds: "timestampToleranceSeconds",
} satisfies Record<keyof AgentMailWebhookOptions, string>;

const CREATOR_DIGEST_REFERENCE_ROWS = {
  enabled: "enabled",
  destination: "destination",
  intervalMs: "intervalMs",
  maxItems: "maxItems",
  maxAttempts: "maxAttempts",
} satisfies Record<keyof AgentMailCreatorDigestOptions, string>;

describe("AgentMail operator guide contracts", () => {
  const source = readFileSync(DOC_PATH, "utf-8");
  const reviewSection = markdownSection(source, "Require creator review before replying");
  const visitorAuthSection = markdownSection(
    source,
    "Send `visitorAuth` magic links through the shared inbox",
  );
  const digestSection = markdownSection(source, "Send a creator digest for outstanding mail work");
  const companionYaml: Readonly<Record<Companion, string>> = {
    visitorAuth: yamlForPath(visitorAuthSection, "augments/visitorAuth/augment.yaml"),
    webTransport: yamlForPath(
      reviewSection,
      "augments/webTransport/augment.yaml (relevant option)",
    ),
    notify: yamlForPath(digestSection, "augments/notify/augment.yaml"),
  };

  test("separates published RC.9 behavior from the next candidate", () => {
    expect(source).toContain("not present in RC.9");
    expect(source).toContain("Invalid binaryType: blob");
    expect(source).toContain("Use `inbound.mode: polling` on RC.9");
    expect(source).toContain("signup instead stores the provider-returned key");
  });

  test("every published YAML fence is syntactically valid", () => {
    const blocks = fencedYaml(source);
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const [index, yaml] of blocks.entries()) {
      expect(() => parseYaml(yaml), `YAML fence ${index + 1} must parse`).not.toThrow();
    }
  });

  test("publishes exactly eight config-valid AgentMail recipes with expected key plans", async () => {
    const markedAgentMailBlocks = fencedYaml(source).filter((yaml) =>
      yaml.startsWith("# augments/agentMail/augment.yaml\n"),
    );
    expect(markedAgentMailBlocks).toHaveLength(RECIPES.length);

    await withIsolatedAgentMailEnv(async () => {
      for (const recipe of RECIPES) {
        const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-docs-"));
        try {
          const section = markdownSection(source, recipe.heading);
          const agentMailYaml = yamlForPath(section, "augments/agentMail/augment.yaml");
          const configPath = writeRecipeProject(
            root,
            agentMailYaml,
            recipe.companions,
            companionYaml,
          );

          const parsed = parseConfig(configPath);
          expect(parsed.augments.map((augment) => augment.type)).toEqual([
            "agentMail",
            ...recipe.companions,
          ]);
          const parsedAgentMail = parsed.augments.find((augment) => augment.type === "agentMail");
          expect(
            objectPaths(parsedAgentMail?.options),
            `${recipe.heading} option inventory`,
          ).toEqual([...recipe.optionPaths].sort());

          const setup = await runAgentMailSetup(
            "agentMail",
            { config: configPath, mode: "env" },
            { interactive: false, provisioner: docsProvisioner() },
          );
          expect(setup.requiredPermissions, recipe.heading).toEqual([...recipe.permissions]);

          const formatted = formatAgentMailSetupResult(setup);
          expect(formatted).toContain("AgentMail inbox configured:");
          expect(formatted).toContain("Required AgentMail key capabilities:");
          expect(formatted).toContain("Confirm that the configured key grants:");
          if (setup.requiredPermissions?.includes("message_read")) {
            expect(formatted).toContain(
              "AgentMail is configured for outbound email and inbound processing.",
            );
            expect(formatted).not.toContain("won't read or act on it by default");
          } else {
            expect(formatted).toContain(
              "AgentMail is configured for outbound email, including visitorAuth magic links.",
            );
            expect(formatted).toContain("won't read or act on it by default");
          }
          expect(formatted).not.toContain("AgentMail is ready");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  });

  test("keeps the first recipe identical to the generated AgentMail policy", () => {
    const section = markdownSection(source, "Send email only");
    const documented = parseYaml(yamlForPath(section, "augments/agentMail/augment.yaml")) as {
      type: string;
      config: Record<string, unknown>;
    };
    const catalog = AUGMENT_CATALOG.find((entry) => entry.type === "agentMail");
    expect(catalog).toBeDefined();
    expect(documented).toEqual({
      type: "agentMail",
      config: {
        ...structuredClone(catalog?.defaultOptions ?? {}),
        dbPath: "./data/agent-mail.db",
      },
    });
  });

  test("runs the documented fresh agentMail then visitorAuth shared-credential sequence", async () => {
    const section = markdownSection(
      source,
      "Send `visitorAuth` magic links through the shared inbox",
    );
    const agentMailSetup = section.indexOf("auggy agentmail setup agentMail");
    const visitorAuthSetup = section.indexOf("auggy agentmail setup visitorAuth --mode env");
    expect(agentMailSetup).toBeGreaterThan(0);
    expect(visitorAuthSetup).toBeGreaterThan(agentMailSetup);

    const visitorAuthYaml = yamlForPath(section, "augments/visitorAuth/augment.yaml");
    const documentedVisitorAuth = parseYaml(visitorAuthYaml) as {
      config: { agentMail: Record<string, unknown> };
    };
    expect(documentedVisitorAuth.config.agentMail).toEqual({
      transport: "console",
      subjectPrefix: "[Verify] ",
    });

    const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-docs-shared-fresh-"));
    try {
      const configPath = writeRecipeProject(
        root,
        yamlForPath(section, "augments/agentMail/augment.yaml"),
        ["visitorAuth", "webTransport"],
        companionYaml,
        { runtimeCredentials: false },
      );
      const visitorAuthPath = join(root, "augments", "visitorAuth", "augment.yaml");

      await withIsolatedAgentMailEnv(async () => {
        const configured = await runAgentMailSetup(
          "agentMail",
          {
            config: configPath,
            mode: "existing",
            apiKey: "am_docs_account",
            username: "docs-contract",
            displayName: "Docs Contract",
          },
          {
            interactive: false,
            provisioner: {
              signUp: async () => {
                throw new Error("not used");
              },
              verify: async () => {
                throw new Error("not used");
              },
              createInbox: async () => ({ inboxId: INBOX_ID, email: INBOX_EMAIL }),
              listInboxes: async () => [],
              getInbox: async () => ({ inboxId: INBOX_ID, email: INBOX_EMAIL }),
            },
          },
        );
        expect(configured.mode).toBe("existing");
        expect(readFileSync(join(root, ".env"), "utf-8")).toContain(
          "AGENTMAIL_API_KEY=am_docs_account",
        );
        expect(
          (parseYaml(readFileSync(visitorAuthPath, "utf-8")) as typeof documentedVisitorAuth).config
            .agentMail,
        ).toEqual({ transport: "console", subjectPrefix: "[Verify] " });

        const attached = await runAgentMailSetup(
          "visitorAuth",
          { config: configPath, mode: "env" },
          { interactive: false, provisioner: docsProvisioner() },
        );
        expect(attached.mode).toBe("env");
        expect(
          (parseYaml(readFileSync(visitorAuthPath, "utf-8")) as typeof documentedVisitorAuth).config
            .agentMail,
        ).toEqual({
          transport: "agentmail",
          apiKey: "${AGENTMAIL_API_KEY}",
          inboxId: "${AGENTMAIL_INBOX_ID}",
          subjectPrefix: "[Verify] ",
        });
        const parsed = parseConfig(configPath);
        expect(parsed.augments.map((augment) => augment.type)).toEqual([
          "agentMail",
          "visitorAuth",
          "webTransport",
        ]);
        expect(
          parsed.augments.find((augment) => augment.type === "agentMail")?.options,
        ).toMatchObject({ addressVisibility: "creator" });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives conditional label-read permissions from the documented classification policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-docs-labels-"));
    try {
      const section = markdownSection(
        source,
        "Receive allowlisted email over WebSocket, with replies disabled",
      );
      const parsedRecipe = parseYaml(yamlForPath(section, "augments/agentMail/augment.yaml")) as {
        config: AgentMailAugmentOptions;
      };
      parsedRecipe.config.inbound = {
        ...parsedRecipe.config.inbound!,
        classifications: {
          received: "process",
          spam: "process",
          blocked: "process",
          unauthenticated: "discard",
        },
      };
      const configPath = writeRecipeProject(
        root,
        stringifyYaml(parsedRecipe).trimEnd(),
        [],
        companionYaml,
      );

      await withIsolatedAgentMailEnv(async () => {
        parseConfig(configPath);
        const setup = await runAgentMailSetup(
          "agentMail",
          { config: configPath, mode: "env" },
          { interactive: false, provisioner: docsProvisioner() },
        );
        expect(setup.requiredPermissions).toEqual([
          "inbox_read",
          "message_send",
          "message_read",
          "label_spam_read",
          "label_blocked_read",
        ]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("references every public AgentMail configuration field exactly once", () => {
    expectReferenceRows(source, "Top-level `config`", TOP_LEVEL_REFERENCE_ROWS);
    expect(markdownSubsection(source, "Top-level `config`")).toContain(
      "`agentDir` is programmatic-only",
    );
    expectReferenceRows(source, "`outbound`", OUTBOUND_REFERENCE_ROWS);
    expectReferenceRows(
      source,
      "`outbound.rateLimit` and `outbound.humanReview`",
      OUTBOUND_RATE_REFERENCE_ROWS,
    );
    expectReferenceRows(
      source,
      "`outbound.rateLimit` and `outbound.humanReview`",
      HUMAN_REVIEW_REFERENCE_ROWS,
    );
    expectReferenceRows(source, "`inbound` delivery and sender admission", INBOUND_REFERENCE_ROWS);
    expectReferenceRows(
      source,
      "`inbound` delivery and sender admission",
      INBOUND_RATE_REFERENCE_ROWS,
    );
    expectReferenceRows(
      source,
      "`inbound.classifications` and `inbound.replies`",
      CLASSIFICATION_REFERENCE_ROWS,
    );
    expectReferenceRows(
      source,
      "`inbound.classifications` and `inbound.replies`",
      REPLY_REFERENCE_ROWS,
    );
    expectReferenceRows(source, "`inbound.webhook`", WEBHOOK_REFERENCE_ROWS);
    expectReferenceRows(source, "`inbound.creatorDigest`", CREATOR_DIGEST_REFERENCE_ROWS);
  });

  test("separates 42 YAML settings, nine containers, and programmatic-only agentDir", () => {
    expect(AGENTMAIL_YAML_SETTINGS).toHaveLength(42);
    expect(new Set(AGENTMAIL_YAML_SETTINGS).size).toBe(42);
    expect(AGENTMAIL_YAML_CONTAINERS).toHaveLength(9);
    expect(new Set(AGENTMAIL_YAML_CONTAINERS).size).toBe(9);
    expect(
      AGENTMAIL_YAML_SETTINGS.filter((path) =>
        AGENTMAIL_YAML_CONTAINERS.includes(path as (typeof AGENTMAIL_YAML_CONTAINERS)[number]),
      ),
    ).toEqual([]);

    const reference = source.slice(source.indexOf("### Complete configuration reference"));
    expect(reference).toContain("**42 YAML settings**");
    expect(reference).toContain("grouped under nine object containers");
    for (const container of AGENTMAIL_YAML_CONTAINERS) {
      expect(reference).toContain(`\`${container}\``);
    }
    expect(reference).toContain("`agentDir` is programmatic-only");
    expect(reference).toContain("It is not one of the 42 YAML settings");
    expect(reference).not.toMatch(/^\| `agentDir` \|/m);
  });

  test("documents restart-only YAML and the persisted review-expiry lifecycle", () => {
    const reference = source
      .slice(source.indexOf("### Complete configuration reference"))
      .replace(/\s+/g, " ");
    for (const statement of [
      "Every YAML change below requires an agent restart",
      "does not hot-reload AgentMail YAML",
      "applies only to newly queued reviews",
      "there is no background expiration timer",
      "becomes `expired`",
      "does not immediately delete the record",
      "eligible for pruning after 30 days",
      "already in `sending` does not expire",
    ]) {
      expect(reference).toContain(statement);
    }

    let now = 1_000;
    let nextId = 0;
    const queue = createAgentMailReviewQueue({
      now: () => now,
      id: () => `review-${++nextId}`,
    });
    const enqueue = (fingerprint: string, expiresAt: number) =>
      queue.enqueue({
        trustLevel: "public",
        recipients: ["customer@example.com"],
        subject: fingerprint,
        rateKey: fingerprint,
        fingerprint,
        request: {
          kind: "send",
          to: ["customer@example.com"],
          subject: fingerprint,
          text: "Review me",
        },
        expiresAt,
      }).record;

    const original = enqueue("original-24-hour-policy", now + 86_400_000);
    const newer = enqueue("new-one-hour-policy", now + 3_600_000);
    now += 3_600_000;
    expect(queue.get(newer.id)).toMatchObject({ state: "expired", resolvedAt: now });
    expect(queue.get(original.id)).toMatchObject({ state: "pending", expiresAt: 86_401_000 });
    expect(() => queue.beginApproval(newer.id)).toThrow(/expired/);
  });

  test("binds documented inbound ranges and defaults to exported runtime contracts", () => {
    const inbound = markdownSubsection(
      source,
      "`inbound` delivery and sender admission",
    ).replaceAll(",", "");
    expect(inbound).toContain(`1–${AGENTMAIL_MAX_ALLOWED_SENDERS} unique exact addresses`);
    expect(inbound).toContain(`from 1 through ${AGENTMAIL_MAX_INBOUND_GLOBAL_PER_HOUR}`);
    expect(inbound).toContain(`from 1 through ${AGENTMAIL_MAX_INBOUND_PER_SENDER_PER_HOUR}`);
    expect(inbound).toContain(
      `from ${AGENTMAIL_MIN_POLL_INTERVAL_MS} through ${AGENTMAIL_MAX_POLL_INTERVAL_MS}`,
    );
    expect(inbound).toContain(
      `from ${AGENTMAIL_MIN_PROMPT_BYTES} through ${AGENTMAIL_MAX_PROMPT_BYTES}`,
    );
    expect(inbound).toContain(`from 1 through ${AGENTMAIL_MAX_ATTEMPTS}`);

    const replies = markdownSubsection(
      source,
      "`inbound.classifications` and `inbound.replies`",
    ).replaceAll(",", "");
    expect(replies).toContain(
      `\`${resolveAgentMailInboundReplies("none", undefined, undefined).mode}\` when inbound is \`none\``,
    );
    expect(replies).toContain(
      `\`${resolveAgentMailInboundReplies("websocket", undefined, undefined).mode}\` when inbound is enabled`,
    );
    expect(replies).toContain(`from 1 through ${AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR}`);

    const digestDefaults = resolveAgentMailCreatorDigestConfig(undefined, "websocket");
    const digest = markdownSubsection(source, "`inbound.creatorDigest`").replaceAll(",", "");
    expect(digest).toContain(
      `from ${AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS} through ${AGENTMAIL_CREATOR_DIGEST_MAX_INTERVAL_MS}`,
    );
    expect(digest).toContain(`\`${digestDefaults.intervalMs}\``);
    expect(digestDefaults.intervalMs).toBe(AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS);
    expect(digest).toContain(`from 1 through ${AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS}`);
    expect(digest).toContain(`\`${digestDefaults.maxItems}\``);
    expect(digestDefaults.maxItems).toBe(AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS);
    expect(digest).toContain(`from 1 through ${AGENTMAIL_CREATOR_DIGEST_MAX_ATTEMPTS}`);
    expect(digest).toContain(`\`${digestDefaults.maxAttempts}\``);
    expect(digestDefaults.maxAttempts).toBe(AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS);
  });

  test("binds important outbound and enabled-inbound defaults to runtime behavior", () => {
    const outbound = markdownSubsection(source, "`outbound`").replaceAll(",", "");
    expect(normalizeSubject("Status", {})).toBe("[Auggy] Status");
    expect(outbound).toContain("`[Auggy] `");

    const tenRecipients = Array.from({ length: 10 }, (_, index) => `person${index}@example.com`);
    expect(
      validateOutbound({ recipients: tenRecipients, subject: "Status", text: "ok" }, {}).ok,
    ).toBe(true);
    expect(
      validateOutbound(
        {
          recipients: [...tenRecipients, "overflow@example.com"],
          subject: "Status",
          text: "ok",
        },
        {},
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("configured cap of 10") });
    expect(
      validateOutbound(
        { recipients: ["person@example.com"], subject: "Status", text: "a".repeat(102_401) },
        {},
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("102400 bytes") });
    expect(
      validateOutbound(
        {
          recipients: ["person@example.com"],
          subject: "Status",
          text: "plain",
          html: "<p>html</p>",
        },
        {},
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("disabled by default") });
    expect(
      validateOutbound(
        {
          recipients: ["person@example.com"],
          subject: "Status",
          text: "a".repeat(102_400),
          html: "b",
        },
        { allowHtml: true },
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("102401 bytes (text + html)"),
    });
    expect(outbound).toContain("combined UTF-8 byte length of the plain-text and HTML bodies");

    const now = 1_000_000;
    const globalState = createRateLimitState();
    for (let index = 0; index < 10; index += 1) {
      recordSend(globalState, [`person${index}@example.com`], `Subject ${index}`, now, {});
    }
    expect(checkRateLimit(globalState, ["next@example.com"], "Next", {}, now)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("10/hour"),
    });
    const cooldownState = createRateLimitState();
    recordSend(cooldownState, ["person@example.com"], "First", now, {});
    expect(
      checkRateLimit(cooldownState, ["person@example.com"], "Different", {}, now + 1),
    ).toMatchObject({ allowed: false, retryAfterSec: 300 });
    expect(
      checkRateLimit(cooldownState, ["other@example.com"], "First", {}, now + 1),
    ).toMatchObject({ allowed: false, retryAfterSec: 300 });

    const inboundDefaults = validateAgentMailInboundConfig({
      mode: "websocket",
      allowedSenders: ["operator@example.com"],
    });
    expect(inboundDefaults.processedEventTypes).toEqual(["message.received"]);
    expect(inboundDefaults.replies).toEqual({ mode: "review", allowReplyAll: false });
    expect(inboundDefaults.creatorDigest).toMatchObject({ enabled: false });
    const classificationReference = markdownSubsection(
      source,
      "`inbound.classifications` and `inbound.replies`",
    );
    expect(classificationReference).toContain(
      "| `classifications.received` | `process` or `discard` | `process` |",
    );
    expect(classificationReference).toContain("`review` when inbound is enabled");
    expect(markdownSubsection(source, "`inbound.creatorDigest`")).toContain(
      "| `enabled` | Boolean | `false`",
    );
  });

  test("binds the documented inbound and reply modes to effective runtime policy", () => {
    expect(validateAgentMailInboundConfig({ mode: "none" })).toMatchObject({
      processedEventTypes: [],
      replies: { mode: "disabled", allowReplyAll: false },
    });

    for (const mode of ["polling", "websocket"] as const) {
      expect(
        validateAgentMailInboundConfig({
          mode,
          allowedSenders: ["operator@example.com"],
        }),
      ).toMatchObject({
        processedEventTypes: ["message.received"],
        replies: { mode: "review", allowReplyAll: false },
      });
    }
    expect(
      validateAgentMailInboundConfig({
        mode: "webhook",
        allowedSenders: ["operator@example.com"],
        webhook: {},
      }),
    ).toMatchObject({
      processedEventTypes: ["message.received"],
      replies: { mode: "review", allowReplyAll: false },
    });
    expect(
      validateAgentMailInboundConfig({
        mode: "websocket",
        allowedSenders: ["operator@example.com"],
        replies: { mode: "automatic", allowReplyAll: true },
      }).replies,
    ).toEqual({ mode: "automatic", allowReplyAll: true });

    const modeSection = source.slice(
      source.indexOf("## Choosing an inbound mode"),
      source.indexOf("## Inbound trust and prompt shape"),
    );
    expect(modeSection).toContain("AgentMail can still receive and store mail upstream");
    expect(modeSection).toContain("REST catch-up");
    expect(modeSection).toContain("every `pollIntervalMs`");
    expect(modeSection).toContain("durably enqueued before success");

    const replyReference = markdownSubsection(
      source,
      "`inbound.classifications` and `inbound.replies`",
    ).replace(/\s+/g, " ");
    for (const statement of [
      "A normal assistant response is not emailed",
      "may propose one reply to the message that triggered it",
      "may send one reply to its triggering message",
      "does not authorize a new",
      "does not grant general outbound or forwarding authority",
    ]) {
      expect(replyReference).toContain(statement);
    }
    expect(source).toContain(
      "an outcome-unknown turn is quarantined after the first uncertain outcome instead of being retried",
    );
  });

  test("binds the retention reference to durable ledger behavior and exported capacities", () => {
    const retention = source.slice(
      source.indexOf("### Retention behavior"),
      source.indexOf("## Operator visibility"),
    );
    expect(retention).toContain(
      "ordinary terminal rows currently have no time-based pruning and remain",
    );
    expect(retention).toContain(
      `Each inbox retains at most ${AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX.toLocaleString("en-US")}`,
    );
    expect(retention).toContain(
      `At most ${AGENTMAIL_ATTENTION_DEFAULT_MAX_RECORDS.toLocaleString("en-US")}`,
    );
    expect(retention).toContain(
      `At most ${AGENTMAIL_DIGEST_DEFAULT_MAX_BATCHES.toLocaleString("en-US")} immutable batches and ${AGENTMAIL_DIGEST_DEFAULT_MAX_ITEMS.toLocaleString("en-US")} items`,
    );
    expect(AGENTMAIL_ATTENTION_DEFAULT_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
    expect(AGENTMAIL_DIGEST_DEFAULT_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);

    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const inboxId = "retention-contract@agentmail.to";
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:", now: () => now });
    try {
      ledger.enqueue({
        source: "rest",
        eventType: "message.received",
        providerEventId: undefined,
        message: {
          inboxId,
          threadId: "thread_retention_contract",
          messageId: "message_retention_contract",
          labels: ["received"],
          timestamp: new Date(now).toISOString(),
          from: "customer@example.com",
          to: [inboxId],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: "Retain this",
          preview: "Durable body",
          text: "Durable body",
          html: undefined,
          extractedText: undefined,
          extractedHtml: undefined,
          size: 12,
          attachments: [],
          inReplyTo: undefined,
          references: [],
          createdAt: undefined,
          updatedAt: undefined,
        },
      });
      const claim = ledger.claimNext({ workerId: "docs-retention", leaseMs: 60_000 });
      expect(claim).not.toBeNull();
      expect(ledger.complete(claim!)).toBe(true);
      now += 365 * 24 * 60 * 60_000;
      expect(ledger.get(inboxId, "message_retention_contract")).toMatchObject({
        state: "processed",
        envelope: { message: { text: "Durable body" } },
      });
    } finally {
      ledger.close();
    }
  });
});
