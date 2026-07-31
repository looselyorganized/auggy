import { confirm, input, password, select } from "@inquirer/prompts";
import { Command } from "commander";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildAgentMailRuntimeKeyPermissions,
  createAgentMailProvisioningClient,
  type AgentMailProvisioningClient,
  type AgentMailRuntimeKeyPermissions,
} from "../agentmail-provisioning";
import { successMark } from "../_shared/styles";
import { displayPath } from "../display-path";
import { parseEnvFile } from "../env-parse";
import { upsertEnvValues } from "../env-writer";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import { VALID_NAME_RE } from "../config-parser";
import { writeFileSafely } from "../safe-write";
import {
  VISITOR_AUTH_AGENTMAIL_RATE_LIMIT_DEFAULT,
  VISITOR_AUTH_LOCAL_RATE_LIMIT_DEFAULT,
} from "../augment-catalog";
import { isWellFormedEmail } from "../../augments/visitorAuth/email-validation";
import {
  agentMailInboundRequiresAdminRoute,
  validateAgentMailInboundConfig,
  type ValidatedAgentMailInboundConfig,
} from "../../augments/agentMail/inbound-policy";
import type { AgentMailOutboundOptions } from "../../types";

export type AgentMailSetupTarget = "visitorAuth" | "agentMail";
export type AgentMailSetupMode = "signup" | "existing" | "manual" | "env";

type PromptSelect = typeof select;
type PromptInput = typeof input;
type PromptPassword = typeof password;
type PromptConfirm = typeof confirm;

export interface AgentMailCommandDeps {
  provisioner?: AgentMailProvisioningClient;
  promptSelect?: PromptSelect;
  promptInput?: PromptInput;
  promptPassword?: PromptPassword;
  promptConfirm?: PromptConfirm;
  exit?: (code: number) => void;
  cwd?: string;
  auggyDir?: string;
}

export interface AgentMailSetupOptions {
  agent?: string;
  config?: string;
  mode?: string;
  humanEmail?: string;
  username?: string;
  displayName?: string;
  apiKey?: string;
  inboxId?: string;
  otp?: string;
  baseUrl?: string;
  allowInsecureHttpWithCredentials?: boolean;
}

export interface AgentMailSetupResult {
  agentName: string;
  target: AgentMailSetupTarget;
  mode: AgentMailSetupMode;
  inboxId: string;
  inboxEmail?: string;
  envPath: string;
  augmentPath: string;
  envKeys: string[];
  requiredPermissions?: string[];
}

export function agentMailCommand(deps: AgentMailCommandDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const command = new Command("agentmail").description("Set up AgentMail-backed email delivery");

  command
    .command("setup <target>")
    .description("Provision or configure AgentMail for an augment")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option("--mode <mode>", "signup, existing, manual, or env")
    .option("--human-email <email>", "human owner email for AgentMail signup")
    .option("--username <username>", "AgentMail inbox username")
    .option("--display-name <name>", "AgentMail inbox display name")
    .option("--api-key <key>", "AgentMail parent/runtime API key")
    .option("--inbox-id <id>", "existing AgentMail inbox ID for manual mode")
    .option("--otp <code>", "AgentMail signup OTP code")
    .option("--base-url <url>", "AgentMail API base URL")
    .option(
      "--allow-insecure-http-with-credentials",
      "allow plaintext remote AgentMail only when NODE_ENV=development",
    )
    .action(async (target: string, opts: AgentMailSetupOptions) => {
      try {
        const result = await runAgentMailSetup(target, opts, deps);
        console.log(formatAgentMailSetupResult(result));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}

export async function runAgentMailSetup(
  targetArg: string,
  opts: AgentMailSetupOptions = {},
  deps: AgentMailCommandDeps = {},
): Promise<AgentMailSetupResult> {
  const target = parseTarget(targetArg);

  const configPath = resolveConfigPath(opts.agent, opts.config, {
    auggyDir: deps.auggyDir,
    cwd: deps.cwd,
  });
  const agentDir = dirname(configPath);
  const agentName = readAgentName(configPath);
  const agentId = readAgentId(configPath) ?? agentName;
  const augmentPath = join(agentDir, "augments", target, "augment.yaml");
  if (!existsSync(augmentPath)) {
    throw new Error(
      `${target} is not installed for ${agentName}.\n\n` +
        `  Run \`auggy augment add ${target}\` first.`,
    );
  }
  const configPlan = planAgentMailConfig(target, augmentPath);
  if (configPlan.requiresWebTransport && !agentConfigHasAugmentType(configPath, "webTransport")) {
    throw new Error(
      `${displayPath(augmentPath)} config.inbound.mode webhook requires a webTransport augment before AgentMail setup can provision resources.`,
    );
  }
  if (configPlan.requiresAdminWebTransport && !agentConfigHasAdminWebTransport(configPath)) {
    throw new Error(
      `${displayPath(augmentPath)} config.inbound.replies.mode ${configPlan.inboundReplyMode} requires a webTransport augment with adminRoute enabled before AgentMail setup can provision resources.`,
    );
  }

  const provisioner =
    deps.provisioner ??
    createAgentMailProvisioningClient({
      apiBaseUrl: opts.baseUrl,
      allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
    });
  const prompts = {
    select: deps.promptSelect ?? select,
    input: deps.promptInput ?? input,
    password: deps.promptPassword ?? password,
    confirm: deps.promptConfirm ?? confirm,
  };

  const envPath = join(agentDir, ".env");
  const envCredentials = readExistingEnvCredentials(envPath);
  const useEnvCredentials =
    envCredentials &&
    (!opts.mode
      ? await prompts.confirm({
          message: "Use existing AgentMail credentials from .env?",
          default: true,
        })
      : parseMode(opts.mode) === "env");

  const mode: AgentMailSetupMode = useEnvCredentials
    ? "env"
    : await resolveMode(opts.mode, prompts.select);
  const credentials =
    mode === "env"
      ? (envCredentials ?? missingEnvCredentials())
      : mode === "signup"
        ? await runSignupFlow(
            target,
            agentName,
            opts,
            provisioner,
            prompts,
            configPlan.runtimeKeyPermissions,
          )
        : mode === "existing"
          ? await runExistingAccountFlow(
              target,
              agentName,
              agentId,
              opts,
              provisioner,
              prompts,
              configPlan.runtimeKeyPermissions,
            )
          : await runManualFlow(opts, prompts);
  const resolvedCredentials: { inboxId: string; apiKey: string; email?: string } =
    target === "agentMail" ? await ensureInboxEmail(credentials, provisioner) : credentials;

  const envKeys = commitAgentMailSetup({
    envPath,
    augmentPath,
    updatedAugmentConfig: configPlan.updatedAugmentConfig,
    envValues: {
      AGENTMAIL_API_KEY: resolvedCredentials.apiKey,
      AGENTMAIL_INBOX_ID: resolvedCredentials.inboxId,
      ...(target === "agentMail"
        ? { AGENTMAIL_INBOX_EMAIL: requireInboxEmail(resolvedCredentials.email) }
        : {}),
    },
  });

  return {
    agentName,
    target,
    mode,
    inboxId: resolvedCredentials.inboxId,
    inboxEmail: resolvedCredentials.email,
    envPath,
    augmentPath,
    envKeys,
    requiredPermissions: enabledPermissionNames(configPlan.runtimeKeyPermissions),
  };
}

async function runSignupFlow(
  target: AgentMailSetupTarget,
  agentName: string,
  opts: AgentMailSetupOptions,
  provisioner: AgentMailProvisioningClient,
  prompts: {
    input: PromptInput;
    password: PromptPassword;
    confirm: PromptConfirm;
  },
  runtimeKeyPermissions: AgentMailRuntimeKeyPermissions,
): Promise<{ inboxId: string; apiKey: string; email?: string }> {
  const humanEmail =
    opts.humanEmail ??
    (await prompts.input({
      message: "Human owner email for AgentMail verification:",
      validate: (value) => value.trim().includes("@") || "email required",
    }));
  const username = await resolveUsername(agentName, opts.username, prompts.input);
  const proceed = await prompts.confirm({
    message: `Create ${username}@agentmail.to and send a verification code to ${humanEmail}?`,
    default: true,
  });
  if (!proceed) throw new Error("AgentMail signup cancelled.");

  const signup = await provisioner.signUp({
    humanEmail: humanEmail.trim(),
    username,
    source: "auggy-cli",
    referrer: `auggy ${target} setup`,
  });
  const otpCode =
    opts.otp ??
    (await prompts.input({
      message: "AgentMail verification code:",
      validate: (value) => value.trim().length > 0 || "verification code required",
    }));
  const verified = await provisioner.verify(signup.apiKey, otpCode.trim());
  if (!verified.verified) throw new Error("AgentMail verification did not complete.");

  const inbox =
    target === "agentMail"
      ? await lookupCanonicalInbox(provisioner, signup.apiKey, signup.inboxId)
      : undefined;
  const runtimeKey = await provisioner.createInboxApiKey({
    apiKey: signup.apiKey,
    inboxId: signup.inboxId,
    name: runtimeKeyName(agentName, target),
    permissions: runtimeKeyPermissions,
  });
  return { inboxId: signup.inboxId, apiKey: runtimeKey.apiKey, email: inbox?.email };
}

async function runExistingAccountFlow(
  target: AgentMailSetupTarget,
  agentName: string,
  agentId: string,
  opts: AgentMailSetupOptions,
  provisioner: AgentMailProvisioningClient,
  prompts: {
    input: PromptInput;
    password: PromptPassword;
  },
  runtimeKeyPermissions: AgentMailRuntimeKeyPermissions,
): Promise<{ inboxId: string; apiKey: string; email?: string }> {
  const parentApiKey =
    opts.apiKey ??
    (await prompts.password({
      message: "AgentMail API key that can create inboxes:",
      mask: "*",
      validate: (value) => value.trim().length > 0 || "AgentMail API key required",
    }));
  const username = await resolveUsername(agentName, opts.username, prompts.input);
  const displayName =
    opts.displayName ??
    (await prompts.input({
      message: "Inbox display name:",
      default: agentName,
    }));

  const inbox = await provisioner.createInbox({
    apiKey: parentApiKey.trim(),
    username,
    displayName: displayName.trim() || agentName,
    clientId: agentMailClientId(agentId, target),
    metadata: { source: "auggy-cli", agent: agentName, augment: target },
  });
  const runtimeKey = await provisioner.createInboxApiKey({
    apiKey: parentApiKey.trim(),
    inboxId: inbox.inboxId,
    name: runtimeKeyName(agentName, target),
    permissions: runtimeKeyPermissions,
  });
  return { inboxId: inbox.inboxId, apiKey: runtimeKey.apiKey, email: inbox.email };
}

async function runManualFlow(
  opts: AgentMailSetupOptions,
  prompts: {
    input: PromptInput;
    password: PromptPassword;
  },
): Promise<{ inboxId: string; apiKey: string; email?: string }> {
  const apiKey =
    opts.apiKey ??
    (await prompts.password({
      message: "AgentMail runtime API key:",
      mask: "*",
      validate: (value) => value.trim().length > 0 || "AgentMail API key required",
    }));
  const inboxId =
    opts.inboxId ??
    (await prompts.input({
      message: "AgentMail inbox ID:",
      validate: (value) => value.trim().length > 0 || "inbox ID required",
    }));
  return { inboxId: inboxId.trim(), apiKey: apiKey.trim() };
}

interface AgentMailConfigPlan {
  updatedAugmentConfig: string;
  runtimeKeyPermissions: AgentMailRuntimeKeyPermissions;
  requiresWebTransport: boolean;
  requiresAdminWebTransport: boolean;
  inboundReplyMode?: ValidatedAgentMailInboundConfig["replies"]["mode"];
}

function planAgentMailConfig(
  target: AgentMailSetupTarget,
  augmentPath: string,
): AgentMailConfigPlan {
  const raw = parseYaml(readFileSync(augmentPath, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${displayPath(augmentPath)} is not a valid augment.yaml object.`);
  }
  const doc = raw as Record<string, unknown>;
  if (doc.type !== target) {
    throw new Error(`${displayPath(augmentPath)} is not a ${target} augment.`);
  }

  const config =
    doc.config && typeof doc.config === "object" && !Array.isArray(doc.config)
      ? (doc.config as Record<string, unknown>)
      : {};
  let validatedInbound: ValidatedAgentMailInboundConfig | undefined;
  if (target === "agentMail" && config.inbound !== undefined) {
    try {
      validatedInbound = validateAgentMailInboundConfig(
        config.inbound,
        config.outbound && typeof config.outbound === "object" && !Array.isArray(config.outbound)
          ? (config.outbound as AgentMailOutboundOptions)
          : undefined,
      );
    } catch (error) {
      throw new Error(
        `${displayPath(augmentPath)} config.inbound is invalid: ${(error as Error).message}`,
      );
    }
  }
  const inboundEnabled = validatedInbound !== undefined && validatedInbound.config.mode !== "none";
  const runtimeKeyPermissions = buildAgentMailRuntimeKeyPermissions({
    inboundEnabled,
    processSpam: validatedInbound?.processedEventTypes.includes("message.received.spam") ?? false,
    processBlocked:
      validatedInbound?.processedEventTypes.includes("message.received.blocked") ?? false,
  });

  if (target === "visitorAuth") {
    const currentAgentMail =
      config.agentMail && typeof config.agentMail === "object" && !Array.isArray(config.agentMail)
        ? (config.agentMail as Record<string, unknown>)
        : {};

    const transitionsFromConsole = currentAgentMail.transport === "console";
    config.agentMail = {
      ...currentAgentMail,
      transport: "agentmail",
      apiKey: "${AGENTMAIL_API_KEY}",
      inboxId: "${AGENTMAIL_INBOX_ID}",
    };
    if (
      transitionsFromConsole &&
      isExactRecord(config.rateLimit, VISITOR_AUTH_LOCAL_RATE_LIMIT_DEFAULT)
    ) {
      config.rateLimit = { ...VISITOR_AUTH_AGENTMAIL_RATE_LIMIT_DEFAULT };
    }
  } else {
    config.apiKey = "${AGENTMAIL_API_KEY}";
    config.inboxId = "${AGENTMAIL_INBOX_ID}";
    config.emailAddress = "${AGENTMAIL_INBOX_EMAIL}";
    config.addressVisibility = "public";
  }

  doc.config = config;
  return {
    updatedAugmentConfig: stringifyYaml(doc),
    runtimeKeyPermissions,
    requiresWebTransport: validatedInbound?.config.mode === "webhook",
    requiresAdminWebTransport:
      validatedInbound !== undefined && agentMailInboundRequiresAdminRoute(validatedInbound),
    ...(validatedInbound ? { inboundReplyMode: validatedInbound.replies.mode } : {}),
  };
}

function agentConfigHasAugmentType(configPath: string, type: string): boolean {
  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!isRecord(raw) || !Array.isArray(raw.augments)) return false;
  const agentDir = dirname(configPath);
  return raw.augments.some((entry) => {
    if (isRecord(entry)) return entry.type === type;
    if (typeof entry !== "string") return false;
    const referencedPath = join(agentDir, "augments", entry, "augment.yaml");
    if (!existsSync(referencedPath)) return false;
    try {
      const referenced = parseYaml(readFileSync(referencedPath, "utf-8"));
      return isRecord(referenced) && referenced.type === type;
    } catch {
      return false;
    }
  });
}

function agentConfigHasAdminWebTransport(configPath: string): boolean {
  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!isRecord(raw) || !Array.isArray(raw.augments)) return false;
  const agentDir = dirname(configPath);
  return raw.augments.some((entry) => {
    if (isRecord(entry)) {
      if (entry.type !== "webTransport") return false;
      const options = isRecord(entry.options) ? entry.options : {};
      return options.adminRoute === undefined || options.adminRoute === true;
    }
    if (typeof entry !== "string") return false;
    const referencedPath = join(agentDir, "augments", entry, "augment.yaml");
    if (!existsSync(referencedPath)) return false;
    try {
      const referenced = parseYaml(readFileSync(referencedPath, "utf-8"));
      if (!isRecord(referenced) || referenced.type !== "webTransport") return false;
      const config = isRecord(referenced.config) ? referenced.config : {};
      return config.adminRoute === undefined || config.adminRoute === true;
    } catch {
      return false;
    }
  });
}

function commitAgentMailSetup(input: {
  envPath: string;
  augmentPath: string;
  updatedAugmentConfig: string;
  envValues: Record<string, string>;
}): string[] {
  const envExisted = existsSync(input.envPath);
  const originalEnv = envExisted ? readFileSync(input.envPath, "utf-8") : undefined;
  const envKeys = upsertEnvValues(input.envPath, input.envValues);
  try {
    writeFileSafely(input.augmentPath, input.updatedAugmentConfig);
  } catch (writeError) {
    try {
      if (originalEnv === undefined) {
        rmSync(input.envPath, { force: true });
      } else {
        writeFileSafely(input.envPath, originalEnv, { mode: 0o600 });
      }
    } catch (rollbackError) {
      throw new Error(
        `AgentMail setup could not update ${displayPath(input.augmentPath)} and could not restore ` +
          `${displayPath(input.envPath)}. Restore both files before retrying. ` +
          `Write error: ${safeErrorMessage(writeError)}. Rollback error: ${safeErrorMessage(rollbackError)}.`,
      );
    }
    throw writeError;
  }
  return envKeys;
}

function isExactRecord(value: unknown, expected: Readonly<Record<string, number>>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && record[key] === expected[key])
  );
}

async function resolveMode(
  mode: string | undefined,
  promptSelect: PromptSelect,
): Promise<AgentMailSetupMode> {
  if (mode) return parseMode(mode);
  return promptSelect<AgentMailSetupMode>({
    message: "AgentMail setup mode:",
    choices: [
      {
        name: "Create first AgentMail inbox with email verification",
        value: "signup",
      },
      {
        name: "Create a new inbox in an existing AgentMail account",
        value: "existing",
      },
      {
        name: "Use an existing inbox ID and runtime key",
        value: "manual",
      },
    ],
    default: "signup",
  });
}

function parseTarget(value: string): AgentMailSetupTarget {
  if (value === "visitorAuth") return "visitorAuth";
  if (value === "agentMail") return "agentMail";
  throw new Error('AgentMail setup supports "agentMail" or "visitorAuth".');
}

function parseMode(value: string): AgentMailSetupMode {
  if (value === "signup" || value === "existing" || value === "manual" || value === "env") {
    return value;
  }
  throw new Error(`Invalid AgentMail setup mode "${value}". Use signup, existing, manual, or env.`);
}

async function resolveUsername(
  agentName: string,
  explicit: string | undefined,
  promptInput: PromptInput,
): Promise<string> {
  const value =
    explicit ??
    (await promptInput({
      message: "AgentMail inbox username:",
      default: slugForAgentMail(agentName),
      validate: (candidate) =>
        validAgentMailUsername(candidate.trim()) || "use letters, numbers, hyphens, or underscores",
    }));
  const username = slugForAgentMail(value);
  if (!validAgentMailUsername(username)) {
    throw new Error(`Invalid AgentMail username "${value}".`);
  }
  return username;
}

function slugForAgentMail(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validAgentMailUsername(value: string): boolean {
  return VALID_NAME_RE.test(value);
}

export function formatAgentMailSetupResult(result: AgentMailSetupResult): string {
  const inbox = result.inboxEmail ? `${result.inboxEmail} (${result.inboxId})` : result.inboxId;
  const permissions = (result.requiredPermissions ?? ["inbox_read", "message_send"]).join(", ");
  const permissionText =
    result.mode === "manual" || result.mode === "env"
      ? `Warning: Setup did not change the existing runtime key. It must grant: ${permissions}.`
      : `${successMark()} Runtime key permissions: ${permissions}`;
  const readyText =
    result.target === "visitorAuth"
      ? "visitorAuth will now send magic links with AgentMail."
      : "agentMail will now send outbound email with AgentMail.";
  return [
    `${successMark()} AgentMail inbox ready: ${inbox}`,
    `${successMark()} Wrote .env: ${result.envKeys.join(", ")}`,
    `${successMark()} Updated ${displayPath(result.augmentPath)}`,
    permissionText,
    "",
    readyText,
    "",
    "Run:",
    "  auggy doctor",
    "  auggy run",
  ].join("\n");
}

function runtimeKeyName(agentName: string, target: AgentMailSetupTarget): string {
  return `${agentName} ${target}`;
}

function agentMailClientId(agentId: string, target: AgentMailSetupTarget): string {
  return `auggy:${agentId}:${target}`;
}

function readAgentId(configPath: string): string | null {
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as { id?: unknown } | null;
  if (typeof raw?.id === "string" && raw.id.trim().length > 0) return raw.id.trim();
  return null;
}

function readExistingEnvCredentials(envPath: string): { inboxId: string; apiKey: string } | null {
  if (!existsSync(envPath)) return null;
  const values: Record<string, string> = {};
  for (const line of parseEnvFile(readFileSync(envPath, "utf-8"))) {
    if (line.kind === "kv") values[line.key] = line.value;
  }
  const apiKey = usableEnvValue(values.AGENTMAIL_API_KEY);
  const inboxId = usableEnvValue(values.AGENTMAIL_INBOX_ID);
  if (!apiKey || !inboxId) return null;
  return { apiKey, inboxId };
}

async function ensureInboxEmail(
  credentials: { inboxId: string; apiKey: string; email?: string },
  provisioner: AgentMailProvisioningClient,
): Promise<{ inboxId: string; apiKey: string; email: string }> {
  const email = usableInboxEmail(credentials.email);
  if (email) return { ...credentials, email };

  const inbox = await lookupCanonicalInbox(provisioner, credentials.apiKey, credentials.inboxId);
  return { ...credentials, email: inbox.email };
}

async function lookupCanonicalInbox(
  provisioner: AgentMailProvisioningClient,
  apiKey: string,
  inboxId: string,
): Promise<{ inboxId: string; email: string; displayName?: string }> {
  let inbox: { inboxId: string; email: string; displayName?: string };
  try {
    inbox = await provisioner.getInbox(apiKey, inboxId);
  } catch {
    throw new Error(
      `Could not resolve the canonical email for AgentMail inbox ${inboxId}. ` +
        "Check the runtime key and inbox ID, then retry setup.",
    );
  }
  if (inbox.inboxId !== inboxId) {
    throw new Error(
      `AgentMail returned inbox ${inbox.inboxId} while resolving ${inboxId}; setup was not saved.`,
    );
  }
  const email = usableInboxEmail(inbox.email);
  if (!email) {
    throw new Error(`AgentMail inbox ${inboxId} did not return a valid canonical email.`);
  }
  return { ...inbox, email };
}

function usableInboxEmail(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("${") || !isWellFormedEmail(trimmed)) return null;
  return trimmed.toLowerCase();
}

function requireInboxEmail(value: string | undefined): string {
  if (!value) throw new Error("AgentMail setup did not resolve a canonical inbox email.");
  return value;
}

function enabledPermissionNames(permissions: AgentMailRuntimeKeyPermissions): string[] {
  return Object.entries(permissions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function usableEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("${")) return null;
  return trimmed;
}

function missingEnvCredentials(): never {
  throw new Error(
    "AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID are not set in .env. " +
      "Use --mode signup, --mode existing, or --mode manual.",
  );
}
