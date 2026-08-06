import { confirm, input, password, select } from "@inquirer/prompts";
import { Command } from "commander";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AgentMailProvisioningApiError,
  buildAgentMailClientId,
  buildAgentMailRuntimeKeyPermissions,
  createAgentMailProvisioningClient,
  type AgentMailProvisioningClient,
  type AgentMailProvisioningTarget,
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
import {
  collectNotifyDestinationPolicyBindings,
  resolveCreatorDigestNotifyBinding,
  validateUniqueNotifyDestinationNames,
} from "../../augments/agentMail/creator-digest-policy";
import type { AgentMailOutboundOptions } from "../../types";

export type AgentMailSetupTarget = AgentMailProvisioningTarget;
export type AgentMailSetupMode = "signup" | "existing" | "manual" | "env";
const IMMUTABLE_AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  /** Override terminal interactivity for embedded callers and tests. */
  interactive?: boolean;
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
    .command("setup [target]")
    .description("Provision or configure AgentMail for an augment")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option(
      "--mode <mode>",
      "signup (new account), existing (account API key), manual (existing inbox), or env",
    )
    .option("--human-email <email>", "human owner email for AgentMail signup")
    .option("--username <username>", "AgentMail inbox username")
    .option("--display-name <name>", "AgentMail inbox display name")
    .option(
      "--api-key <key>",
      "AgentMail key (prefer the secure prompt or AGENTMAIL_ACCOUNT_API_KEY/AGENTMAIL_API_KEY)",
    )
    .option("--inbox-id <id>", "existing AgentMail inbox ID for manual mode")
    .option("--base-url <url>", "AgentMail API base URL")
    .option(
      "--allow-insecure-http-with-credentials",
      "allow plaintext remote AgentMail only when NODE_ENV=development",
    )
    .action(async (target: string | undefined, opts: AgentMailSetupOptions) => {
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
  targetArg: string | undefined,
  opts: AgentMailSetupOptions = {},
  deps: AgentMailCommandDeps = {},
): Promise<AgentMailSetupResult> {
  const configPath = resolveConfigPath(opts.agent, opts.config, {
    auggyDir: deps.auggyDir,
    cwd: deps.cwd,
  });
  const agentDir = dirname(configPath);
  const agentName = readAgentName(configPath);
  const agentId = readAgentId(configPath);
  const prompts = {
    select: deps.promptSelect ?? select,
    input: deps.promptInput ?? input,
    password: deps.promptPassword ?? password,
    confirm: deps.promptConfirm ?? confirm,
  };
  const interactive =
    deps.interactive ??
    Boolean(
      deps.promptSelect ??
        deps.promptInput ??
        deps.promptPassword ??
        deps.promptConfirm ??
        process.stdin.isTTY,
    );
  const mountedAugments = readMountedAugmentConfigs(configPath);
  const target = resolveSetupTarget(targetArg, agentDir, mountedAugments);
  const augmentPath = join(agentDir, "augments", target, "augment.yaml");
  if (!isCanonicalSetupTargetInstalled(target, agentDir, mountedAugments)) {
    if (mountedAugments.some((augment) => augment.type === target)) {
      throw unsupportedSetupMountError(target);
    }
    throw new Error(
      `${target} is not installed for ${agentName}.\n\n` +
        `  Run \`auggy augment add ${target}\` first.`,
    );
  }
  const configPlan = planAgentMailConfig(target, augmentPath);
  if (
    configPlan.requiresWebTransport &&
    !mountedAugments.some((augment) => augment.type === "webTransport")
  ) {
    throw new Error(
      `${displayPath(augmentPath)} config.inbound.mode webhook requires a webTransport augment before AgentMail setup can provision resources.`,
    );
  }
  if (
    configPlan.requiresAdminWebTransport &&
    !mountedAugments.some(
      (augment) => augment.type === "webTransport" && augment.options.adminRoute !== false,
    )
  ) {
    throw new Error(
      `${displayPath(augmentPath)} config.inbound.replies.mode ${configPlan.inboundReplyMode} requires a webTransport augment with adminRoute enabled before AgentMail setup can provision resources.`,
    );
  }
  if (configPlan.creatorDigest?.enabled) {
    const notifyBindings = collectNotifyDestinationPolicyBindings(
      mountedAugments.flatMap((augment) =>
        augment.type === "notify"
          ? [
              {
                augmentName: augment.name,
                destinations: augment.options.destinations,
                rateLimit: augment.options.rateLimit,
              },
            ]
          : [],
      ),
    );
    validateUniqueNotifyDestinationNames(notifyBindings);
    resolveCreatorDigestNotifyBinding(configPlan.creatorDigest, notifyBindings);
  }

  const provisioner =
    deps.provisioner ??
    createAgentMailProvisioningClient({
      apiBaseUrl: opts.baseUrl,
      allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
    });
  const envPath = join(agentDir, ".env");
  const envCredentials = readExistingEnvCredentials(envPath);
  const otherTarget: AgentMailSetupTarget = target === "agentMail" ? "visitorAuth" : "agentMail";
  const otherConsumers = mountedAugments.filter((augment) => augment.type === otherTarget);
  if (
    otherConsumers.length > 0 &&
    !isCanonicalSetupTargetInstalled(otherTarget, agentDir, mountedAugments)
  ) {
    throw new Error(
      `Automatic setup cannot safely change shared AGENTMAIL_* credentials while a custom, inline, or additional ${otherTarget} instance is mounted. Configure all AgentMail consumers manually.`,
    );
  }
  if (
    target === "visitorAuth" &&
    otherConsumers.length > 0 &&
    (opts.mode !== "env" || !hasUsableEnvInboxEmail(envPath))
  ) {
    throw new Error(
      "agentMail and visitorAuth share one AgentMail inbox and runtime key. Configure agentMail first, " +
        "then run `auggy agentmail setup visitorAuth --mode env` so visitorAuth reuses those credentials.",
    );
  }
  let mode: AgentMailSetupMode = await resolveMode(
    opts.mode,
    prompts.select,
    envCredentials !== null,
    interactive,
  );
  assertModeOptionCompatibility(mode, opts);
  assertNonInteractiveSetupInputs(mode, opts, interactive);
  if (
    (mode === "signup" || mode === "existing") &&
    runtimeKeyName(agentName, target).length > 256
  ) {
    throw new Error(
      "Agent name is too long for an AgentMail runtime-key name (maximum 256 characters).",
    );
  }
  let credentials: { inboxId: string; apiKey: string; email?: string };
  if (mode === "env") {
    credentials = envCredentials ?? missingEnvCredentials();
  } else if (mode === "signup") {
    try {
      credentials = await runSignupFlow(
        target,
        agentName,
        opts,
        provisioner,
        prompts,
        configPlan.runtimeKeyPermissions,
      );
    } catch (error) {
      if (!isExistingAgentMailAccountError(error)) throw error;
      if (!interactive || opts.mode !== undefined) throw existingAccountSetupError(target);
      const useExistingAccount = await prompts.confirm({
        message:
          "This email already has an AgentMail account. Create a new inbox in that account instead?",
        default: true,
      });
      if (!useExistingAccount) throw existingAccountSetupError(target);
      mode = "existing";
      credentials = await runExistingAccountFlow(
        target,
        agentName,
        requireAgentMailProvisioningAgentId(agentId, configPath),
        opts,
        provisioner,
        prompts,
        configPlan.runtimeKeyPermissions,
        interactive,
      );
    }
  } else if (mode === "existing") {
    credentials = await runExistingAccountFlow(
      target,
      agentName,
      requireAgentMailProvisioningAgentId(agentId, configPath),
      opts,
      provisioner,
      prompts,
      configPlan.runtimeKeyPermissions,
      interactive,
    );
  } else {
    credentials = await runManualFlow(opts, prompts);
  }
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
    (usableOption(opts.humanEmail) ? opts.humanEmail : undefined) ??
    (await prompts.input({
      message: "Human owner email for AgentMail verification:",
      validate: (value) => value.trim().includes("@") || "email required",
    }));
  const username = await resolveUsername(agentName, opts.username, prompts.input);
  const normalizedHumanEmail = humanEmail.trim();
  if (!isWellFormedEmail(normalizedHumanEmail)) {
    throw new Error("Invalid AgentMail human owner email.");
  }
  const proceed = await prompts.confirm({
    message: `Create ${username}@agentmail.to and send a verification code to ${normalizedHumanEmail}?`,
    default: true,
  });
  if (!proceed) throw new Error("AgentMail signup cancelled.");

  const signup = await provisioner.signUp({
    humanEmail: normalizedHumanEmail,
    username,
    source: "auggy-cli",
    referrer: `auggy ${target} setup`,
  });
  const otpCode = await prompts.input({
    message: "AgentMail verification code:",
    validate: (value) => value.trim().length > 0 || "verification code required",
  });
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
  interactive: boolean,
): Promise<{ inboxId: string; apiKey: string; email?: string }> {
  const parentApiKey =
    firstUsableOption(opts.apiKey, process.env.AGENTMAIL_ACCOUNT_API_KEY) ??
    (await prompts.password({
      message: "AgentMail API key that can create inboxes:",
      mask: "*",
      validate: (value) => value.trim().length > 0 || "AgentMail API key required",
    }));
  const username = await resolveUsername(agentName, opts.username, prompts.input);
  const displayName =
    (usableOption(opts.displayName) ? opts.displayName : undefined) ??
    (interactive
      ? await prompts.input({
          message: "Inbox display name:",
          default: agentName,
        })
      : agentName);
  const normalizedDisplayName = displayName.trim() || agentName;
  if (normalizedDisplayName.length > 256 || /[\p{Cc}\p{Cf}]/u.test(normalizedDisplayName)) {
    throw new Error(
      "AgentMail inbox display name must be at most 256 characters without controls.",
    );
  }

  const inbox = await provisioner.createInbox({
    apiKey: parentApiKey.trim(),
    username,
    displayName: normalizedDisplayName,
    clientId: buildAgentMailClientId(agentId, target),
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
    firstUsableOption(opts.apiKey, process.env.AGENTMAIL_API_KEY) ??
    (await prompts.password({
      message: "AgentMail runtime API key:",
      mask: "*",
      validate: (value) => value.trim().length > 0 || "AgentMail API key required",
    }));
  const inboxId =
    firstUsableOption(opts.inboxId, process.env.AGENTMAIL_INBOX_ID) ??
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
  creatorDigest?: ValidatedAgentMailInboundConfig["creatorDigest"];
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
    ...(validatedInbound ? { creatorDigest: validatedInbound.creatorDigest } : {}),
  };
}

interface MountedAugmentConfig {
  name: string;
  type: unknown;
  options: Record<string, unknown>;
  source: "inline" | "referenced";
}

/**
 * Read only non-secret augment topology needed by setup preflight. This path
 * intentionally does not interpolate environment variables because setup is
 * responsible for creating the AgentMail credentials that may still be absent.
 */
function readMountedAugmentConfigs(configPath: string): MountedAugmentConfig[] {
  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!isRecord(raw) || !Array.isArray(raw.augments)) {
    throw new Error(`${displayPath(configPath)} must contain an augments array.`);
  }
  const agentDir = dirname(configPath);
  return raw.augments.map((entry, index) => {
    if (isRecord(entry)) {
      const type = entry.type;
      const name =
        typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : typeof type === "string"
            ? type
            : `augments[${index}]`;
      if (entry.options !== undefined && !isRecord(entry.options)) {
        throw new Error(`${displayPath(configPath)} augments[${index}].options must be an object.`);
      }
      return {
        name,
        type,
        options: isRecord(entry.options) ? entry.options : {},
        source: "inline",
      };
    }
    if (typeof entry !== "string" || !VALID_NAME_RE.test(entry)) {
      throw new Error(
        `${displayPath(configPath)} augments[${index}] must be an inline augment or a safe augment id.`,
      );
    }
    const referencedPath = join(agentDir, "augments", entry, "augment.yaml");
    if (!existsSync(referencedPath)) {
      throw new Error(
        `${displayPath(configPath)} augments[${index}] is missing ${displayPath(referencedPath)}.`,
      );
    }
    try {
      const referenced = parseYaml(readFileSync(referencedPath, "utf-8"));
      if (!isRecord(referenced)) {
        throw new Error("metadata must be an object");
      }
      if (referenced.config !== undefined && !isRecord(referenced.config)) {
        throw new Error("config must be an object");
      }
      return {
        name: entry,
        type: referenced.type,
        options: isRecord(referenced.config) ? referenced.config : {},
        source: "referenced",
      };
    } catch {
      // YAML parser diagnostics can quote source lines, which may contain
      // credentials. Setup only needs a classified topology error here.
      throw new Error(`${displayPath(referencedPath)} is invalid augment metadata.`);
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
  hasEnvCredentials: boolean,
  interactive: boolean,
): Promise<AgentMailSetupMode> {
  if (mode) return parseMode(mode);
  if (!interactive) {
    throw new Error(
      "AgentMail setup needs a mode in non-interactive use. Pass --mode signup, existing, manual, or env.",
    );
  }
  return promptSelect<AgentMailSetupMode>({
    message: "AgentMail setup mode:",
    choices: [
      ...(hasEnvCredentials
        ? [
            {
              name: "Use AgentMail credentials already configured in .env",
              value: "env" as const,
            },
          ]
        : []),
      {
        name: "New to AgentMail — create an account and first inbox",
        value: "signup",
      },
      {
        name: "Existing AgentMail account — create an inbox with an account API key",
        value: "existing",
      },
      {
        name: "Existing AgentMail inbox — connect its ID and scoped runtime key",
        value: "manual",
      },
    ],
    default: hasEnvCredentials ? "env" : "signup",
  });
}

function resolveSetupTarget(
  targetArg: string | undefined,
  agentDir: string,
  mountedAugments: readonly MountedAugmentConfig[],
): AgentMailSetupTarget {
  if (targetArg !== undefined) return parseTarget(targetArg);

  const installedTargets = (["agentMail", "visitorAuth"] as const).filter((target) =>
    isCanonicalSetupTargetInstalled(target, agentDir, mountedAugments),
  );
  if (installedTargets.length === 1) return installedTargets[0]!;
  if (installedTargets.length === 0) {
    if (
      mountedAugments.some(
        (augment) => augment.type === "agentMail" || augment.type === "visitorAuth",
      )
    ) {
      throw new Error(
        "AgentMail setup found only inline or custom-named AgentMail-compatible augments. " +
          "Automatic setup supports canonical referenced mounts only; configure that instance manually or migrate it to agentMail/visitorAuth.",
      );
    }
    throw new Error(
      "No AgentMail-compatible augment is installed.\n\n" +
        "  Run `auggy augment add agentMail` for agent email.\n" +
        "  Run `auggy augment add visitorAuth` for visitor sign-in email.",
    );
  }
  throw new Error(
    "Both agentMail and visitorAuth are installed and share AgentMail credentials. Configure agentMail first, " +
      "then run `auggy agentmail setup visitorAuth --mode env`.",
  );
}

function isCanonicalSetupTargetInstalled(
  target: AgentMailSetupTarget,
  agentDir: string,
  mountedAugments: readonly MountedAugmentConfig[],
): boolean {
  const sameTypeConsumers = mountedAugments.filter((augment) => augment.type === target);
  return (
    sameTypeConsumers.length === 1 &&
    existsSync(join(agentDir, "augments", target, "augment.yaml")) &&
    sameTypeConsumers.some(
      (augment) =>
        augment.source === "referenced" && augment.name === target && augment.type === target,
    )
  );
}

function unsupportedSetupMountError(target: AgentMailSetupTarget): Error {
  return new Error(
    `${target} is mounted inline or under a custom name. Automatic AgentMail setup only updates the canonical referenced ` +
      `augments/${target}/augment.yaml mount; configure this instance manually or migrate it first.`,
  );
}

function isExistingAgentMailAccountError(error: unknown): boolean {
  return (
    error instanceof AgentMailProvisioningApiError &&
    error.operation === "/agent/sign-up" &&
    error.status === 403 &&
    error.providerCode === "already_exists"
  );
}

function existingAccountSetupError(target: AgentMailSetupTarget): Error {
  return new Error(
    "This email already has an AgentMail account, so new-account signup cannot claim it. " +
      "No existing inbox was adopted and no local credentials were changed.\n\n" +
      `  Run \`auggy agentmail setup ${target} --mode existing\` with an account API key.`,
  );
}

function parseTarget(value: string): AgentMailSetupTarget {
  const normalized = value.trim().toLowerCase();
  if (normalized === "visitorauth") return "visitorAuth";
  if (normalized === "agentmail") return "agentMail";
  throw new Error('AgentMail setup supports "agentMail" or "visitorAuth".');
}

function parseMode(value: string): AgentMailSetupMode {
  if (value === "signup" || value === "existing" || value === "manual" || value === "env") {
    return value;
  }
  throw new Error(`Invalid AgentMail setup mode "${value}". Use signup, existing, manual, or env.`);
}

function assertModeOptionCompatibility(
  mode: AgentMailSetupMode,
  opts: AgentMailSetupOptions,
): void {
  const allowedByMode: Record<AgentMailSetupMode, ReadonlySet<keyof AgentMailSetupOptions>> = {
    signup: new Set(["humanEmail", "username"]),
    existing: new Set(["apiKey", "username", "displayName"]),
    manual: new Set(["apiKey", "inboxId"]),
    env: new Set(),
  };
  const setupFlags: Array<[keyof AgentMailSetupOptions, string]> = [
    ["humanEmail", "--human-email"],
    ["username", "--username"],
    ["displayName", "--display-name"],
    ["apiKey", "--api-key"],
    ["inboxId", "--inbox-id"],
  ];
  const ignored = setupFlags.flatMap(([key, flag]) =>
    opts[key] !== undefined && !allowedByMode[mode].has(key) ? [flag] : [],
  );
  if (ignored.length > 0) {
    throw new Error(
      `AgentMail --mode ${mode} does not use ${ignored.join(", ")}; remove unused setup flags before retrying.`,
    );
  }
}

function assertNonInteractiveSetupInputs(
  mode: AgentMailSetupMode,
  opts: AgentMailSetupOptions,
  interactive: boolean,
): void {
  if (interactive || mode === "env") return;
  const missing: string[] = [];
  if (mode === "signup") {
    throw new Error(
      "AgentMail --mode signup is interactive-only because the verification code is issued during signup. " +
        "For automation, use existing, manual, or env mode.",
    );
  } else if (mode === "existing") {
    if (!usableOption(opts.apiKey ?? process.env.AGENTMAIL_ACCOUNT_API_KEY)) {
      missing.push("--api-key or AGENTMAIL_ACCOUNT_API_KEY");
    }
    if (!usableOption(opts.username)) missing.push("--username");
  } else {
    if (!usableOption(opts.apiKey ?? process.env.AGENTMAIL_API_KEY)) {
      missing.push("--api-key or AGENTMAIL_API_KEY");
    }
    if (!usableOption(opts.inboxId ?? process.env.AGENTMAIL_INBOX_ID)) {
      missing.push("--inbox-id or AGENTMAIL_INBOX_ID");
    }
  }
  if (missing.length > 0) {
    throw new Error(`AgentMail --mode ${mode} needs ${missing.join(", ")} in non-interactive use.`);
  }
}

function usableOption(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function firstUsableOption(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => usableOption(value));
}

async function resolveUsername(
  agentName: string,
  explicit: string | undefined,
  promptInput: PromptInput,
): Promise<string> {
  const value =
    (usableOption(explicit) ? explicit : undefined) ??
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

function readAgentId(configPath: string): string | null {
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as { id?: unknown } | null;
  if (typeof raw?.id === "string" && raw.id.length > 0) return raw.id;
  return null;
}

function requireAgentMailProvisioningAgentId(agentId: string | null, configPath: string): string {
  if (agentId && IMMUTABLE_AGENT_ID_RE.test(agentId)) return agentId;
  throw new Error(
    `${displayPath(configPath)} must contain a valid immutable aug1_ UUID before AgentMail can create an inbox.`,
  );
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

function hasUsableEnvInboxEmail(envPath: string): boolean {
  if (!existsSync(envPath)) return false;
  const values: Record<string, string> = {};
  for (const line of parseEnvFile(readFileSync(envPath, "utf-8"))) {
    if (line.kind === "kv") values[line.key] = line.value;
  }
  return usableInboxEmail(usableEnvValue(values.AGENTMAIL_INBOX_EMAIL) ?? undefined) !== null;
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
