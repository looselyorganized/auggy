import { confirm, input, password, select } from "@inquirer/prompts";
import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  agentMailCapabilityRequirements,
  buildAgentMailRequiredPermissions,
  describeAgentMailCapabilities,
  type AgentMailRequiredPermissions,
} from "../agentmail-capabilities";
import { successMark } from "../_shared/styles";
import { displayPath } from "../display-path";
import { withAgentEnvMutationLock } from "../env-mutation-lock";
import { parseEnvFile } from "../env-parse";
import { upsertEnvValues } from "../env-writer";
import { resolveConfigPath } from "../resolve-config";
import { VALID_NAME_RE } from "../config-parser";
import { writeFileSafely } from "../safe-write";
import {
  VISITOR_AUTH_AGENTMAIL_RATE_LIMIT_DEFAULT,
  VISITOR_AUTH_LOCAL_RATE_LIMIT_DEFAULT,
} from "../augment-catalog";
import { isWellFormedEmail } from "../../augments/visitorAuth/email-validation";
import {
  validateAgentMailConfig,
  type ValidatedAgentMailConfig,
} from "../../augments/agentMail/config";
import {
  AgentMailProviderError,
  createAgentMailProvider,
  type AgentMailProvider,
} from "../../augments/agentMail/provider";
import {
  createAgentMailSetupProvider,
  type AgentMailSetupProvider,
} from "../agentmail-setup-provider";

export type AgentMailSetupTarget = "agentMail" | "visitorAuth";
export type AgentMailSetupMode = "signup" | "existing" | "manual" | "connect" | "env";
const AGENTMAIL_OTP_MAX_ATTEMPTS = 3;
const AGENTMAIL_RUNTIME_ENV_KEYS = [
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "AGENTMAIL_INBOX_EMAIL",
] as const;

type AgentMailRuntimeEnvKey = (typeof AGENTMAIL_RUNTIME_ENV_KEYS)[number];

interface AgentMailSetupCredentials {
  inboxId: string;
  apiKey: string;
  email?: string;
}

type AgentMailDiskEnv = Partial<Record<AgentMailRuntimeEnvKey, string>>;

interface AgentMailEnvSnapshot {
  existed: boolean;
  source?: string;
}

type PromptSelect = typeof select;
type PromptInput = typeof input;
type PromptPassword = typeof password;
type PromptConfirm = typeof confirm;

export interface AgentMailCommandDeps {
  setupProvider?: AgentMailSetupProvider;
  /** Read-only runtime capability checks for the supplied inbox and key. */
  verifyRuntimeAccess?: (
    input: {
      apiKey: string;
      inboxId: string;
      apiBaseUrl?: string;
      allowInsecureHttpWithCredentials?: boolean;
    },
    requirements: {
      messageRead: boolean;
      draftRead: boolean;
    },
  ) => Promise<{ emailAddress: string; verifiedPermissions: string[] }>;
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
  yes?: boolean;
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
  verifiedPermissions?: string[];
  enabledCapabilities?: string[];
}

export function agentMailCommand(deps: AgentMailCommandDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const command = new Command("agentmail").description(
    "Create or connect an AgentMail inbox for agent email and visitorAuth",
  );

  command
    .command("setup [target]")
    .description("Create or connect AgentMail for an installed augment")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option("--mode <mode>", "signup, existing, manual, or env")
    .option("--human-email <email>", "human owner email for first-time AgentMail signup")
    .option("--username <username>", "username for a new AgentMail inbox")
    .option("--display-name <name>", "display name for a new AgentMail inbox")
    .option("--api-key <key>", "AgentMail API key (prefer the secure prompt or AGENTMAIL_API_KEY)")
    .option("--inbox-id <id>", "existing AgentMail inbox ID for manual mode")
    .option("--yes", "confirm a non-interactive provider mutation")
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
  return withAgentEnvMutationLock(agentDir, () =>
    runAgentMailSetupLocked(targetArg, opts, deps, configPath, agentDir),
  );
}

async function runAgentMailSetupLocked(
  targetArg: string | undefined,
  opts: AgentMailSetupOptions,
  deps: AgentMailCommandDeps,
  configPath: string,
  agentDir: string,
): Promise<AgentMailSetupResult> {
  const expectedAgentConfig = readFileSync(configPath, "utf-8");
  const agentName = readAgentNameSnapshot(configPath, expectedAgentConfig);
  const agentId = readAgentIdSnapshot(configPath, expectedAgentConfig);
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
  const mountedAugments = readMountedAugmentConfigs(configPath, expectedAgentConfig);
  const target = resolveSetupTarget(targetArg, agentDir, mountedAugments);
  const augmentPath = join(agentDir, "augments", target, "augment.yaml");
  if (!isCanonicalSetupTargetInstalled(target, agentDir, mountedAugments)) {
    if (mountedAugments.some((augment) => augment.type === target)) {
      throw unsupportedSetupMountError(target, mountedAugments);
    }
    throw new Error(
      `${target} is not installed for ${agentName}.\n\n` +
        `  Run \`auggy augment add ${target}\` first.`,
    );
  }
  const configPlan = planAgentMailConfig(target, augmentPath);
  const envPath = join(agentDir, ".env");
  const expectedEnv = readAgentMailEnvSnapshot(envPath);
  const diskEnv = readEffectiveAgentMailDiskEnv(expectedEnv);
  const envCredentials = readExistingEnvCredentials(diskEnv);
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
  const mode: AgentMailSetupMode = await resolveMode(
    target,
    opts.mode,
    prompts.select,
    envCredentials !== null,
    interactive,
  );
  assertModeOptionCompatibility(target, mode, opts);
  assertNonInteractiveSetupInputs(target, mode, opts, interactive, diskEnv);
  assertSharedCredentialMode(target, mode, otherConsumers, diskEnv);
  if (mode === "manual" || mode === "connect") assertManualEnvSafe(opts, diskEnv);
  else if (mode === "existing") assertNewInboxEnvSafe(opts, diskEnv);
  else if (mode === "signup") assertSignupEnvSafe(diskEnv);
  else assertAmbientDiskEnvParity(diskEnv);
  const setupProvider =
    deps.setupProvider ??
    createAgentMailSetupProvider({
      ...(opts.baseUrl ? { apiBaseUrl: opts.baseUrl } : {}),
      ...(opts.allowInsecureHttpWithCredentials ? { allowInsecureHttpWithCredentials: true } : {}),
    });
  const credentials = await (async (): Promise<AgentMailSetupCredentials> => {
    if (mode === "env") return envCredentials ?? missingEnvCredentials(target);
    if (mode === "manual" || mode === "connect") {
      return runManualFlow(opts, prompts, {
        agentDir,
        invocationDir: deps.cwd ?? process.cwd(),
        diskEnv,
      });
    }
    if (mode === "existing") {
      return runExistingAccountFlow(target, agentName, agentId, opts, setupProvider, prompts, {
        agentDir,
        invocationDir: deps.cwd ?? process.cwd(),
        diskEnv,
        interactive,
      });
    }
    return runSignupFlow(target, agentName, opts, setupProvider, prompts, interactive);
  })();
  const verificationInput = {
    apiKey: credentials.apiKey,
    inboxId: credentials.inboxId,
    ...(opts.baseUrl ? { apiBaseUrl: opts.baseUrl } : {}),
    ...(opts.allowInsecureHttpWithCredentials ? { allowInsecureHttpWithCredentials: true } : {}),
  };
  const verificationRequirements = {
    messageRead: configPlan.requiredPermissions.message_read === true,
    draftRead: configPlan.requiredPermissions.draft_read === true,
  };
  let verification: { emailAddress: string; verifiedPermissions: string[] };
  try {
    verification = await (deps.verifyRuntimeAccess ?? verifyAgentMailRuntimeReadAccess)(
      verificationInput,
      verificationRequirements,
    );
  } catch (error) {
    throw agentMailAccessVerificationError(error, credentials.inboxId, verificationRequirements);
  }
  const resolvedCredentials = { ...credentials, email: verification.emailAddress };
  const envValues = {
    AGENTMAIL_API_KEY: resolvedCredentials.apiKey,
    AGENTMAIL_INBOX_ID: resolvedCredentials.inboxId,
    ...(target === "agentMail"
      ? { AGENTMAIL_INBOX_EMAIL: requireInboxEmail(resolvedCredentials.email) }
      : {}),
  };
  const envKeys = commitAgentMailSetup({
    configPath,
    expectedAgentConfig,
    envPath,
    expectedEnv,
    augmentPath,
    expectedAugmentConfig: configPlan.expectedAugmentConfig,
    updatedAugmentConfig: configPlan.updatedAugmentConfig,
    envValues,
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
    requiredPermissions: enabledPermissionNames(configPlan.requiredPermissions),
    verifiedPermissions: verification.verifiedPermissions,
    enabledCapabilities: configPlan.enabledCapabilities,
  };
}

async function runSignupFlow(
  target: AgentMailSetupTarget,
  agentName: string,
  opts: AgentMailSetupOptions,
  provider: AgentMailSetupProvider,
  prompts: { input: PromptInput; confirm: PromptConfirm },
  interactive: boolean,
): Promise<AgentMailSetupCredentials> {
  const humanEmail =
    usableOption(opts.humanEmail) ??
    (await prompts.input({
      message: "Human owner email for AgentMail verification:",
      validate: (value) => isWellFormedEmail(value.trim()) || "enter a valid email address",
    }));
  const normalizedEmail = humanEmail.trim().toLowerCase();
  if (!isWellFormedEmail(normalizedEmail)) throw new Error("Invalid AgentMail owner email.");
  const username = await resolveInboxUsername(agentName, opts.username, prompts.input);
  if (interactive && !opts.yes) {
    const proceed = await prompts.confirm({
      message: `Create a new AgentMail account with ${username}@agentmail.to and send a verification code to ${normalizedEmail}?`,
      default: true,
    });
    if (!proceed) throw new Error("AgentMail account creation cancelled.");
  }
  const signup = await provider.signUp({
    humanEmail: normalizedEmail,
    username,
    source: "auggy-cli",
    referrer: `auggy ${target} setup`,
  });
  for (let attempt = 1; attempt <= AGENTMAIL_OTP_MAX_ATTEMPTS; attempt += 1) {
    const otpCode = await prompts.input({
      message:
        attempt === 1
          ? "AgentMail verification code:"
          : `AgentMail verification code (attempt ${attempt} of ${AGENTMAIL_OTP_MAX_ATTEMPTS}):`,
      validate: (value) => /^\d{6}$/.test(value.trim()) || "enter the 6-digit verification code",
    });
    const verified = await provider.verify(signup.apiKey, otpCode.trim());
    if (verified.verified) {
      return { inboxId: signup.inboxId, apiKey: signup.apiKey };
    }
  }
  throw new Error(
    "AgentMail account was created but verification did not complete. Sign in to AgentMail Console to verify it before retrying setup.",
  );
}

async function runExistingAccountFlow(
  target: AgentMailSetupTarget,
  agentName: string,
  agentId: string,
  opts: AgentMailSetupOptions,
  provider: AgentMailSetupProvider,
  prompts: { input: PromptInput; password: PromptPassword; confirm: PromptConfirm },
  context: {
    agentDir: string;
    invocationDir: string;
    diskEnv: AgentMailDiskEnv;
    interactive: boolean;
  },
): Promise<AgentMailSetupCredentials> {
  const apiKey = await resolveConnectApiKey(
    opts.apiKey,
    prompts.password,
    context.agentDir,
    context.invocationDir,
    context.diskEnv.AGENTMAIL_API_KEY,
  );
  const username = await resolveInboxUsername(agentName, opts.username, prompts.input);
  const displayName = await resolveInboxDisplayName(agentName, opts.displayName, prompts.input);
  if (context.interactive && !opts.yes) {
    const proceed = await prompts.confirm({
      message: `Create ${username}@agentmail.to in the existing AgentMail account using this exact runtime key?`,
      default: true,
    });
    if (!proceed) throw new Error("AgentMail inbox creation cancelled.");
  }
  const inbox = await provider.createInbox({
    apiKey,
    username,
    displayName,
    clientId: buildSetupClientId(agentId, target),
    metadata: { source: "auggy-cli", agent: agentName, augment: target },
  });
  return { apiKey, inboxId: inbox.inboxId, email: inbox.email };
}

async function resolveInboxUsername(
  agentName: string,
  selected: string | undefined,
  promptInput: PromptInput,
): Promise<string> {
  const fallback = slugForAgentMail(agentName);
  const value =
    usableOption(selected) ??
    (await promptInput({
      message: "AgentMail inbox username:",
      default: fallback,
      validate: (candidate) =>
        validAgentMailUsername(candidate.trim()) ||
        "use 1-64 letters, numbers, periods, hyphens, underscores, or tildes",
    }));
  const username = value.trim();
  if (!validAgentMailUsername(username)) throw new Error("Invalid AgentMail inbox username.");
  return username;
}

async function resolveInboxDisplayName(
  agentName: string,
  selected: string | undefined,
  promptInput: PromptInput,
): Promise<string> {
  const value =
    usableOption(selected) ??
    (await promptInput({ message: "Inbox display name:", default: agentName }));
  const displayName = value.trim() || agentName;
  if (displayName.length > 256 || /[\p{Cc}\p{Cf}]/u.test(displayName)) {
    throw new Error(
      "AgentMail inbox display name must be at most 256 characters without controls.",
    );
  }
  return displayName;
}

function validAgentMailUsername(value: string): boolean {
  return /^[A-Za-z0-9._~-]{1,64}$/.test(value);
}

function slugForAgentMail(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._~-]+|[._~-]+$/g, "")
    .slice(0, 64);
  return slug || "auggy-agent";
}

function buildSetupClientId(agentId: string, target: AgentMailSetupTarget): string {
  const clientId = `auggy.v2.inbox.${agentId}.${target}`;
  if (!/^[A-Za-z0-9._~-]{1,256}$/.test(clientId)) {
    throw new Error("Agent identity cannot be represented as an AgentMail client ID.");
  }
  return clientId;
}

function usableOption(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function runManualFlow(
  opts: AgentMailSetupOptions,
  prompts: {
    input: PromptInput;
    password: PromptPassword;
  },
  context: {
    agentDir: string;
    invocationDir: string;
    diskEnv: AgentMailDiskEnv;
  },
): Promise<AgentMailSetupCredentials> {
  const selectedApiKey = await resolveConnectApiKey(
    opts.apiKey,
    prompts.password,
    context.agentDir,
    context.invocationDir,
    context.diskEnv.AGENTMAIL_API_KEY,
  );
  const inboxId = await resolveConnectInboxId(opts.inboxId, prompts.input, context.diskEnv);
  return {
    apiKey: selectedApiKey,
    inboxId,
  };
}

async function resolveConnectApiKey(
  explicit: string | undefined,
  promptPassword: PromptPassword,
  agentDir: string,
  invocationDir: string,
  diskApiKey?: string,
): Promise<string> {
  const deprecatedDotenvSources = findProjectDotenvProvisioningKeySources(agentDir, invocationDir);
  if (deprecatedDotenvSources.length > 0) {
    throw new Error(
      "AGENTMAIL_ACCOUNT_API_KEY is not a supported AgentMail runtime credential. " +
        `Remove it from ${deprecatedDotenvSources.map((path) => displayPath(path)).join(", ")} and supply the exact key Auggy should use as AGENTMAIL_API_KEY. ` +
        "Setup did not contact AgentMail or change local files.",
    );
  }
  if (process.env.AGENTMAIL_ACCOUNT_API_KEY?.trim()) {
    throw new Error(
      "AGENTMAIL_ACCOUNT_API_KEY is not a supported AgentMail runtime credential. Unset it and supply the exact key Auggy should use as AGENTMAIL_API_KEY. Setup did not contact AgentMail or change local files.",
    );
  }

  const explicitKey = exactApiKey(explicit, "--api-key");
  if (explicitKey) return explicitKey;

  const ambientKey = exactApiKey(process.env.AGENTMAIL_API_KEY, "AGENTMAIL_API_KEY");
  const persistedKey = exactApiKey(diskApiKey, ".env AGENTMAIL_API_KEY");
  if (ambientKey && persistedKey && ambientKey !== persistedKey) {
    throw ambientEnvConflictError("AGENTMAIL_API_KEY");
  }
  const existingKey = ambientKey ?? persistedKey;
  if (existingKey) return existingKey;

  const prompted = await promptPassword({
    message: "AgentMail API key Auggy should use at runtime:",
    mask: "*",
    validate: (value) =>
      value.trim().length === 0
        ? "AgentMail API key required"
        : value !== value.trim()
          ? "remove leading or trailing whitespace"
          : true,
  });
  return requireExactApiKey(prompted, "AgentMail API key");
}

async function resolveConnectInboxId(
  explicit: string | undefined,
  promptInput: PromptInput,
  diskEnv: AgentMailDiskEnv,
): Promise<string> {
  const explicitId = exactInboxId(explicit, "--inbox-id");
  if (explicitId) return explicitId;

  const ambientId = exactInboxId(process.env.AGENTMAIL_INBOX_ID, "AGENTMAIL_INBOX_ID");
  const persistedId = exactInboxId(diskEnv.AGENTMAIL_INBOX_ID, ".env AGENTMAIL_INBOX_ID");
  if (ambientId && persistedId && ambientId !== persistedId) {
    throw ambientEnvConflictError("AGENTMAIL_INBOX_ID");
  }
  const existingId = ambientId ?? persistedId;
  if (existingId) return existingId;

  const prompted = await promptInput({
    message: "Existing AgentMail inbox ID:",
    validate: (value) =>
      /^[\x21-\x7e]{1,256}$/.test(value)
        ? true
        : "use 1 to 256 printable ASCII characters without whitespace",
  });
  return exactInboxId(prompted, "AgentMail inbox ID")!;
}

interface AgentMailConfigPlan {
  expectedAugmentConfig: string;
  updatedAugmentConfig: string;
  requiredPermissions: AgentMailRequiredPermissions;
  enabledCapabilities: string[];
}

function planAgentMailConfig(
  target: AgentMailSetupTarget,
  augmentPath: string,
): AgentMailConfigPlan {
  const expectedAugmentConfig = readFileSync(augmentPath, "utf-8");
  const raw = parseYaml(expectedAugmentConfig);
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
  let validatedAgentMail: ValidatedAgentMailConfig | undefined;

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
    config.addressVisibility ??= "creator";
    try {
      validatedAgentMail = validateAgentMailConfig(config);
    } catch (error) {
      throw new Error(`${displayPath(augmentPath)} config is invalid: ${(error as Error).message}`);
    }
  }

  const requirements = validatedAgentMail
    ? agentMailCapabilityRequirements(validatedAgentMail)
    : {
        inboundEnabled: false,
        reviewReplies: false,
        allowNewDraft: false,
        allowReplyDraft: false,
        allowReplyAllDraft: false,
        allowForwardDraft: false,
        allowLabelMutation: false,
        allowTrashRestore: false,
        allowAttachmentAccess: false,
        allowPermanentDelete: false,
        allowDirectDelivery: true,
      };
  const requiredPermissions: AgentMailRequiredPermissions = validatedAgentMail
    ? buildAgentMailRequiredPermissions(requirements)
    : { inbox_read: true, message_send: true };

  doc.config = config;
  return {
    expectedAugmentConfig,
    updatedAugmentConfig: stringifyYaml(doc),
    requiredPermissions,
    enabledCapabilities:
      target === "agentMail"
        ? describeAgentMailCapabilities(requirements)
        : ["send visitorAuth magic links"],
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
function readMountedAugmentConfigs(
  configPath: string,
  expectedAgentConfig: string,
): MountedAugmentConfig[] {
  const raw = parseYaml(expectedAgentConfig);
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
  configPath: string;
  expectedAgentConfig: string;
  envPath: string;
  expectedEnv: AgentMailEnvSnapshot;
  augmentPath: string;
  expectedAugmentConfig: string;
  updatedAugmentConfig: string;
  envValues: Record<string, string>;
}): string[] {
  assertSetupInputUnchanged(
    input.configPath,
    input.expectedAgentConfig,
    "agent.yaml changed while AgentMail setup was running",
  );
  assertSetupInputUnchanged(
    input.augmentPath,
    input.expectedAugmentConfig,
    "augment.yaml changed while AgentMail setup was running",
  );
  assertEnvInputUnchanged(input.envPath, input.expectedEnv);
  const envKeys = upsertEnvValues(input.envPath, input.envValues);
  try {
    writeFileSafely(input.augmentPath, input.updatedAugmentConfig);
  } catch (writeError) {
    try {
      if (!input.expectedEnv.existed) {
        rmSync(input.envPath, { force: true });
      } else {
        writeFileSafely(input.envPath, input.expectedEnv.source!, { mode: 0o600 });
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

function assertEnvInputUnchanged(path: string, expected: AgentMailEnvSnapshot): void {
  const exists = existsSync(path);
  if (exists !== expected.existed) {
    throw new Error(
      `${displayPath(path)} changed while AgentMail setup was running; no files were overwritten.`,
    );
  }
  if (!exists) return;
  assertSetupInputUnchanged(path, expected.source!, "changed while AgentMail setup was running");
}

function assertSetupInputUnchanged(path: string, expected: string, reason: string): void {
  let current: string;
  try {
    current = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      `${displayPath(path)} could not be re-read safely before commit; setup did not change local files.`,
    );
  }
  if (current !== expected) {
    throw new Error(`${displayPath(path)} ${reason}; setup did not overwrite the newer file.`);
  }
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
  target: AgentMailSetupTarget,
  mode: string | undefined,
  promptSelect: PromptSelect,
  hasEnvCredentials: boolean,
  interactive: boolean,
): Promise<AgentMailSetupMode> {
  if (mode) return parseMode(target, mode);
  if (!interactive) {
    throw new Error(
      `${target} AgentMail setup needs a mode in non-interactive use. Pass --mode signup, existing, manual, or env.`,
    );
  }
  return promptSelect<AgentMailSetupMode>({
    message: target === "agentMail" ? "AgentMail setup mode:" : "visitorAuth delivery setup mode:",
    choices: [
      {
        name: "Create an AgentMail account",
        value: "signup",
      },
      {
        name: "Create a new inbox in an existing AgentMail account",
        value: "existing",
      },
      {
        name: "Manually connect an existing AgentMail inbox",
        value: "manual",
      },
      ...(hasEnvCredentials
        ? [
            {
              name: "Use AgentMail credentials already configured in .env",
              value: "env" as const,
            },
          ]
        : []),
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

function assertSharedCredentialMode(
  target: AgentMailSetupTarget,
  mode: AgentMailSetupMode,
  otherConsumers: readonly MountedAugmentConfig[],
  diskEnv: AgentMailDiskEnv,
): void {
  if (otherConsumers.length === 0) return;
  if (target === "visitorAuth") {
    if (
      mode === "env" &&
      usableInboxEmail(usableEnvValue(diskEnv.AGENTMAIL_INBOX_EMAIL) ?? undefined)
    ) {
      return;
    }
    throw new Error(
      "agentMail and visitorAuth share one AgentMail inbox and API key. Configure agentMail first, " +
        "then run `auggy agentmail setup visitorAuth --mode env` so visitorAuth reuses those credentials.",
    );
  }

  const visitorUsesAgentMail = otherConsumers.some((augment) => {
    const agentMail = isRecord(augment.options.agentMail) ? augment.options.agentMail : undefined;
    return agentMail?.transport !== "console";
  });
  if (visitorUsesAgentMail && mode !== "env") {
    throw new Error(
      "visitorAuth already uses the shared AgentMail inbox and API key. Reuse those credentials with " +
        "`auggy agentmail setup agentMail --mode env`; automatic setup will not replace them.",
    );
  }
}

function unsupportedSetupMountError(
  target: AgentMailSetupTarget,
  mountedAugments: readonly MountedAugmentConfig[],
): Error {
  if (mountedAugments.filter((augment) => augment.type === target).length > 1) {
    return new Error(
      `Automatic AgentMail setup found multiple ${target} instances. Shared AGENTMAIL_* credentials cannot be assigned safely; configure every instance manually.`,
    );
  }
  return new Error(
    `${target} is mounted inline or under a custom name. Automatic AgentMail setup only updates the canonical referenced ` +
      `augments/${target}/augment.yaml mount; configure this instance manually or migrate it first.`,
  );
}

function parseTarget(value: string): AgentMailSetupTarget {
  const normalized = value.trim().toLowerCase();
  if (normalized === "visitorauth") return "visitorAuth";
  if (normalized === "agentmail") return "agentMail";
  throw new Error('AgentMail setup supports "agentMail" or "visitorAuth".');
}

function parseMode(target: AgentMailSetupTarget, value: string): AgentMailSetupMode {
  if (value === "signup" || value === "existing" || value === "manual" || value === "env") {
    return value;
  }
  // Preserve the RC.11 non-interactive spelling while presenting the clearer
  // manual mode in the operator menu.
  if (value === "connect") return "connect";
  throw new Error(
    `Invalid ${target} AgentMail setup mode "${value}". Use signup, existing, manual, or env.`,
  );
}

function assertModeOptionCompatibility(
  target: AgentMailSetupTarget,
  mode: AgentMailSetupMode,
  opts: AgentMailSetupOptions,
): void {
  const allowedByMode: Record<AgentMailSetupMode, ReadonlySet<keyof AgentMailSetupOptions>> = {
    signup: new Set(["humanEmail", "username", "yes"]),
    existing: new Set(["apiKey", "username", "displayName", "yes"]),
    manual: new Set(["apiKey", "inboxId"]),
    connect: new Set(["apiKey", "inboxId"]),
    env: new Set(),
  };
  const setupFlags: Array<[keyof AgentMailSetupOptions, string]> = [
    ["humanEmail", "--human-email"],
    ["username", "--username"],
    ["displayName", "--display-name"],
    ["apiKey", "--api-key"],
    ["inboxId", "--inbox-id"],
    ["yes", "--yes"],
  ];
  const ignored = setupFlags.flatMap(([key, flag]) =>
    opts[key] !== undefined && !allowedByMode[mode].has(key) ? [flag] : [],
  );
  if (ignored.length > 0) {
    throw new Error(
      `${target} AgentMail --mode ${mode} does not use ${ignored.join(", ")}; remove unused setup flags before retrying.`,
    );
  }
}

function assertNonInteractiveSetupInputs(
  target: AgentMailSetupTarget,
  mode: AgentMailSetupMode,
  opts: AgentMailSetupOptions,
  interactive: boolean,
  diskEnv: AgentMailDiskEnv,
): void {
  if (interactive || mode === "env") return;
  if (mode === "signup") {
    throw new Error(
      `${target} AgentMail --mode signup requires an interactive terminal for email verification. ` +
        "For automation, use --mode existing, manual, or env.",
    );
  }
  const missing: string[] = [];
  if (mode === "existing") {
    if (
      !exactApiKey(opts.apiKey, "--api-key") &&
      !exactApiKey(process.env.AGENTMAIL_API_KEY, "AGENTMAIL_API_KEY") &&
      !exactApiKey(diskEnv.AGENTMAIL_API_KEY, ".env AGENTMAIL_API_KEY")
    ) {
      missing.push("--api-key or AGENTMAIL_API_KEY");
    }
    if (!usableOption(opts.username)) missing.push("--username");
    if (!opts.yes) missing.push("--yes");
  }
  if (mode === "manual" || mode === "connect") {
    if (
      !exactApiKey(opts.apiKey, "--api-key") &&
      !exactApiKey(process.env.AGENTMAIL_API_KEY, "AGENTMAIL_API_KEY") &&
      !exactApiKey(diskEnv.AGENTMAIL_API_KEY, ".env AGENTMAIL_API_KEY")
    ) {
      missing.push("--api-key or AGENTMAIL_API_KEY");
    }
    if (
      !exactInboxId(opts.inboxId, "--inbox-id") &&
      !exactInboxId(process.env.AGENTMAIL_INBOX_ID, "AGENTMAIL_INBOX_ID") &&
      !exactInboxId(diskEnv.AGENTMAIL_INBOX_ID, ".env AGENTMAIL_INBOX_ID")
    ) {
      missing.push("--inbox-id or AGENTMAIL_INBOX_ID");
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${target} AgentMail --mode ${mode} needs ${missing.join(", ")} in non-interactive use.`,
    );
  }
}

function exactApiKey(value: string | undefined, source: string): string | null {
  if (value === undefined || value.length === 0) return null;
  return requireExactApiKey(value!, source);
}

function requireExactApiKey(value: string, source: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${source} must not be blank or whitespace-only.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${source} must not contain leading or trailing whitespace.`);
  }
  if (!/^[\x21-\x7e]{1,4096}$/.test(value)) {
    throw new Error(`${source} must be 1 to 4096 printable ASCII characters without whitespace.`);
  }
  return value;
}

function exactInboxId(value: string | undefined, source: string): string | null {
  if (value === undefined || value.length === 0) return null;
  if (!/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw new Error(`${source} must be 1 to 256 printable ASCII characters without whitespace.`);
  }
  return value;
}

function findProjectDotenvProvisioningKeySources(
  agentDir: string,
  invocationDir: string,
): string[] {
  const paths = new Set<string>();
  for (const directory of new Set([agentDir, invocationDir])) {
    const names = readdirSync(directory)
      .filter((name) => /^\.env(?:\.[A-Za-z0-9_-]+)+$/.test(name) || name === ".env")
      .sort();
    for (const name of names) {
      const path = join(directory, name);
      if (!existsSync(path)) continue;
      const containsProvisioningKey = parseEnvFile(readFileSync(path, "utf-8")).some(
        (line) =>
          line.kind === "kv" &&
          line.key === "AGENTMAIL_ACCOUNT_API_KEY" &&
          line.value.trim().length > 0,
      );
      if (containsProvisioningKey) paths.add(path);
    }
  }
  return [...paths].sort();
}

export function formatAgentMailSetupResult(result: AgentMailSetupResult): string {
  const inbox = result.inboxEmail ? `${result.inboxEmail} (${result.inboxId})` : result.inboxId;
  const permissions = (result.requiredPermissions ?? ["inbox_read", "message_send"]).join(", ");
  const permissionText = `Required AgentMail key capabilities: ${permissions}.`;
  const verified = (result.verifiedPermissions ?? ["inbox_read"]).join(", ");
  const verificationText = `Verified read capabilities: ${verified}.`;
  const capabilities = result.enabledCapabilities ?? [];
  const inboundEnabled = capabilities.includes("receive and triage incoming mail");
  const credentialText =
    result.mode === "signup"
      ? "Auggy saved the API key AgentMail returned for the new account; it did not create or exchange another key."
      : result.mode === "existing"
        ? "Auggy created the inbox with your supplied account key and saved that exact same key for runtime use."
        : "Auggy saved the exact API key you supplied; it did not create, rotate, replace, or scope a key.";
  const readyText =
    result.target === "visitorAuth"
      ? [
          "visitorAuth is configured to use AgentMail for magic links.",
          `Confirm that the configured key grants: ${permissions}.`,
        ]
      : inboundEnabled
        ? [
            "AgentMail is configured for outbound email and inbound processing.",
            credentialText,
            `Read access was verified. Write operations still require: ${permissions}.`,
            "Incoming email will be processed according to augments/agentMail/augment.yaml.",
            ...(capabilities.length > 0
              ? [`Enabled AgentMail operations: ${capabilities.join("; ")}.`]
              : []),
            "Review inbound and creator-reviewed reply behavior:",
            "  https://auggy.dev/docs/augment-agentmail",
          ]
        : [
            "AgentMail is configured for outbound email, including visitorAuth magic links.",
            credentialText,
            `Read access was verified. Sending still requires: ${permissions}.`,
            "Incoming email is stored in AgentMail, but Auggy won't read or act on it by default.",
            "To receive email and prepare creator-reviewed replies with Auggy, enable inbound processing:",
            ...(capabilities.length > 0
              ? [`Enabled AgentMail operations: ${capabilities.join("; ")}.`]
              : []),
            "  https://auggy.dev/docs/augment-agentmail",
          ];
  return [
    `${successMark()} AgentMail inbox configured: ${inbox}`,
    `${successMark()} Wrote .env: ${result.envKeys.join(", ")}`,
    `${successMark()} Updated ${displayPath(result.augmentPath)}`,
    verificationText,
    permissionText,
    "",
    ...readyText,
    "",
    "Run:",
    "  auggy doctor",
    "  auggy run",
  ].join("\n");
}

function readAgentNameSnapshot(configPath: string, source: string): string {
  const raw = parseYaml(source) as { name?: unknown } | null;
  if (typeof raw?.name === "string" && raw.name.trim().length > 0) return raw.name.trim();
  throw new Error(`agent.yaml at ${configPath} is missing a non-empty name.`);
}

function readAgentIdSnapshot(configPath: string, source: string): string {
  const raw = parseYaml(source) as { id?: unknown } | null;
  if (
    typeof raw?.id === "string" &&
    /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.id)
  ) {
    return raw.id;
  }
  throw new Error(`agent.yaml at ${configPath} is missing a valid immutable id.`);
}

function readAgentMailEnvSnapshot(envPath: string): AgentMailEnvSnapshot {
  if (!existsSync(envPath)) return { existed: false };
  return { existed: true, source: readFileSync(envPath, "utf-8") };
}

function readEffectiveAgentMailDiskEnv(snapshot: AgentMailEnvSnapshot): AgentMailDiskEnv {
  if (!snapshot.existed) return {};
  const values: AgentMailDiskEnv = {};
  const keys = new Set<string>(AGENTMAIL_RUNTIME_ENV_KEYS);
  for (const line of parseEnvFile(snapshot.source!)) {
    if (line.kind !== "kv" || !keys.has(line.key) || values[line.key as AgentMailRuntimeEnvKey]) {
      continue;
    }
    // Match loadEnvFile: an empty first definition is skipped, then the first
    // nonempty value wins for the lifetime of the runtime process.
    if (line.value) values[line.key as AgentMailRuntimeEnvKey] = line.value;
  }
  return values;
}

function readExistingEnvCredentials(
  values: AgentMailDiskEnv,
): { inboxId: string; apiKey: string } | null {
  const apiKey = runtimeEnvValue("AGENTMAIL_API_KEY", values.AGENTMAIL_API_KEY);
  const inboxId = runtimeEnvValue("AGENTMAIL_INBOX_ID", values.AGENTMAIL_INBOX_ID);
  if (!apiKey || !inboxId) return null;
  return { apiKey, inboxId };
}

function assertAmbientDiskEnvParity(diskEnv: AgentMailDiskEnv): void {
  for (const key of AGENTMAIL_RUNTIME_ENV_KEYS) {
    const ambient = runtimeEnvValue(key, process.env[key]);
    const disk = runtimeEnvValue(key, diskEnv[key]);
    if (ambient && disk && ambient !== disk) throw ambientEnvConflictError(key);
  }
}

function assertManualEnvSafe(opts: AgentMailSetupOptions, diskEnv: AgentMailDiskEnv): void {
  assertAmbientDiskEnvParity(diskEnv);
  const selected = {
    AGENTMAIL_API_KEY: exactApiKey(opts.apiKey, "--api-key") ?? undefined,
    AGENTMAIL_INBOX_ID: exactInboxId(opts.inboxId, "--inbox-id") ?? undefined,
  };
  assertSelectedCredentialsMatchAmbientEnv(diskEnv, selected);
}

function assertNewInboxEnvSafe(opts: AgentMailSetupOptions, diskEnv: AgentMailDiskEnv): void {
  assertAmbientDiskEnvParity(diskEnv);
  assertSelectedCredentialsMatchAmbientEnv(diskEnv, {
    AGENTMAIL_API_KEY: exactApiKey(opts.apiKey, "--api-key") ?? undefined,
  });
  for (const key of ["AGENTMAIL_INBOX_ID", "AGENTMAIL_INBOX_EMAIL"] as const) {
    if (runtimeEnvValue(key, process.env[key]) || runtimeEnvValue(key, diskEnv[key])) {
      throw new Error(
        `AgentMail existing-account mode cannot replace ${key}. Use --mode env for the configured inbox, ` +
          "or remove all AGENTMAIL_INBOX_* values before creating another inbox. Setup did not contact AgentMail.",
      );
    }
  }
}

function assertSignupEnvSafe(diskEnv: AgentMailDiskEnv): void {
  assertAmbientDiskEnvParity(diskEnv);
  const configured = AGENTMAIL_RUNTIME_ENV_KEYS.filter(
    (key) => runtimeEnvValue(key, process.env[key]) || runtimeEnvValue(key, diskEnv[key]),
  );
  if (configured.length > 0) {
    throw new Error(
      `AgentMail signup mode cannot replace existing ${configured.join(", ")}. Use --mode env, or remove ` +
        "all AGENTMAIL_* runtime credentials before creating a new account. Setup did not contact AgentMail.",
    );
  }
}

function assertSelectedCredentialsMatchAmbientEnv(
  diskEnv: AgentMailDiskEnv,
  selected: Partial<Record<AgentMailRuntimeEnvKey, string>>,
): void {
  for (const key of AGENTMAIL_RUNTIME_ENV_KEYS) {
    const value = runtimeEnvValue(key, selected[key]);
    if (!value) continue;
    const ambient = runtimeEnvValue(key, process.env[key]);
    const priorDisk = runtimeEnvValue(key, diskEnv[key]);
    const comparableValue = comparableRuntimeCredential(key, value);
    if (
      (ambient && comparableRuntimeCredential(key, ambient) !== comparableValue) ||
      (priorDisk && comparableRuntimeCredential(key, priorDisk) !== comparableValue)
    ) {
      throw existingRuntimeCredentialMismatchError(key);
    }
  }
}

function comparableRuntimeCredential(key: AgentMailRuntimeEnvKey, value: string): string {
  return key === "AGENTMAIL_INBOX_EMAIL" ? value.toLowerCase() : value;
}

function existingRuntimeCredentialMismatchError(key: AgentMailRuntimeEnvKey): Error {
  return new Error(
    `AgentMail manual mode cannot replace the existing ${key} runtime credential. ` +
      "Reuse the exact existing credentials or use --mode env. To intentionally replace them, remove the " +
      "AGENTMAIL_* values from .env and unset exported AGENTMAIL_* values before retrying; " +
      "setup did not change local files.",
  );
}

function ambientEnvConflictError(key: AgentMailRuntimeEnvKey): Error {
  return new Error(
    `${key} exported in the setup process conflicts with the agent's .env credentials. ` +
      `Make it match .env and reuse the credentials with --mode env. To replace them, remove the AGENTMAIL_* ` +
      `values from .env and unset exported AGENTMAIL_* values before retrying; ` +
      "setup did not change local files.",
  );
}

async function verifyAgentMailRuntimeReadAccess(
  input: {
    apiKey: string;
    inboxId: string;
    apiBaseUrl?: string;
    allowInsecureHttpWithCredentials?: boolean;
  },
  requirements: {
    messageRead: boolean;
    draftRead: boolean;
  },
): Promise<{ emailAddress: string; verifiedPermissions: string[] }> {
  const provider: AgentMailProvider = createAgentMailProvider(input);
  const verified = ["inbox_read"];
  const identity = await provider.verifyAccess();
  const emailAddress = usableInboxEmail(identity.emailAddress);
  if (!emailAddress) {
    throw new Error("AgentMail did not return a canonical inbox email address.");
  }
  if (requirements.messageRead) {
    await provider.listMessages({ limit: 1 });
    verified.push("message_read");
  }
  if (requirements.draftRead) {
    await provider.listDrafts({ limit: 1 });
    verified.push("draft_read");
  }
  return { emailAddress, verifiedPermissions: verified };
}

function agentMailAccessVerificationError(
  error: unknown,
  inboxId: string,
  requirements: { messageRead: boolean; draftRead: boolean },
): Error {
  const details =
    error instanceof AgentMailProviderError
      ? ` AgentMail classified the failure as ${error.details.code}${error.details.httpStatus ? ` (${error.details.httpStatus})` : ""}.`
      : "";
  const capability = requirements.draftRead
    ? "inbox_read, message_read, and draft_read"
    : requirements.messageRead
      ? "inbox_read and message_read"
      : "inbox_read";
  return new Error(
    `Could not verify the supplied AgentMail key's read access to inbox ${inboxId}.${details} ` +
      `Grant ${capability} within this inbox's scope, then retry setup. No credentials were saved.`,
  );
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

function enabledPermissionNames(permissions: AgentMailRequiredPermissions): string[] {
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

function runtimeEnvValue(key: AgentMailRuntimeEnvKey, value: string | undefined): string | null {
  if (key === "AGENTMAIL_API_KEY") {
    if (value?.startsWith("${")) return null;
    return exactApiKey(value, key);
  }
  if (key === "AGENTMAIL_INBOX_ID") {
    if (value?.startsWith("${")) return null;
    return exactInboxId(value, key);
  }
  return usableEnvValue(value);
}

function missingEnvCredentials(target: AgentMailSetupTarget): never {
  throw new Error(
    "AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID are not set in .env. " +
      (target === "agentMail"
        ? "Run setup with --mode signup, existing, or manual."
        : "Run setup with --mode signup, existing, or manual for the inbox visitorAuth should use."),
  );
}
