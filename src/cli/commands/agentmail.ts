import { confirm, input, password, select } from "@inquirer/prompts";
import { Command } from "commander";
import { opendirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import { renderEnvValues } from "../env-writer";
import { writeFileSafely } from "../safe-write";
import {
  AUTHORING_LIMITS,
  type AuthoringDocument,
  type FileSnapshot,
  type MutationPlan,
  type ProjectMutationLease,
  type PublicationFaultHook,
  type PublicationResult,
  type RawRecord,
} from "../authoring/contracts";
import { decodeSnapshotText, readFileSnapshot, sameFileIdentity } from "../authoring/document-io";
import { assertInlineAuthoring } from "../authoring/document";
import { selectInspectionDocument } from "../authoring/inspection-selection";
import { planAugmentMutation } from "../augment-metadata";
import { acquireProjectMutationLease, publishMutationPlan } from "../authoring/publication";
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
  file: FileSnapshot;
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
  /** Explicit failure injection for tests; never supplied by CLI flags or environment. */
  publicationFault?: PublicationFaultHook;
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
  // Classify the declaration graph before acquiring locks or reading credentials.
  const document = selectInspectionDocument(opts.agent, opts.config, {
    cwd: deps.cwd ?? (deps.auggyDir ? join(deps.auggyDir, "agents") : undefined),
  });
  assertInlineAuthoring(document);
  const agentDir = document.projectDir;
  const agentName = readAgentNameSnapshot(document);
  const agentId = readAgentIdSnapshot(document);
  const mountedAugments = readMountedAugmentConfigs(document);
  const target = resolveSetupTarget(targetArg, mountedAugments);
  if (!isCanonicalSetupTargetInstalled(target, mountedAugments)) {
    if (mountedAugments.some((augment) => augment.type === target)) {
      throw unsupportedSetupMountError(target, mountedAugments);
    }
    throw new Error(
      `${target} is not installed for ${agentName}.\n\n` +
        `  Run \`auggy augment add ${target}\` first.`,
    );
  }
  const configPlan = planAgentMailConfig(document, target, mountedAugments);
  const otherTarget: AgentMailSetupTarget = target === "agentMail" ? "visitorAuth" : "agentMail";
  const otherConsumers = mountedAugments.filter((augment) => augment.type === otherTarget);
  if (otherConsumers.length > 0 && !isCanonicalSetupTargetInstalled(otherTarget, mountedAugments)) {
    throw new Error(
      `Automatic setup cannot safely change shared AGENTMAIL_* credentials while a custom or additional ${otherTarget} instance is mounted. Configure all AgentMail consumers manually.`,
    );
  }
  // Every graph/credential writer takes these leases in this order.
  const projectLease = acquireProjectMutationLease(agentDir);
  try {
    return await withAgentEnvMutationLock(agentDir, () =>
      runAgentMailSetupLocked(opts, deps, {
        document,
        agentDir,
        agentName,
        agentId,
        target,
        configPlan,
        otherConsumers,
        projectLease,
      }),
    );
  } finally {
    projectLease.release();
  }
}

async function runAgentMailSetupLocked(
  opts: AgentMailSetupOptions,
  deps: AgentMailCommandDeps,
  prepared: {
    document: AuthoringDocument;
    agentDir: string;
    agentName: string;
    agentId: string;
    target: AgentMailSetupTarget;
    configPlan: AgentMailConfigPlan;
    otherConsumers: MountedAugmentConfig[];
    projectLease: ProjectMutationLease;
  },
): Promise<AgentMailSetupResult> {
  const {
    document,
    agentDir,
    agentName,
    agentId,
    target,
    configPlan,
    otherConsumers,
    projectLease,
  } = prepared;
  const configPath = document.configPath;
  assertSnapshotUnchanged(
    document.config,
    "agent.yaml changed before AgentMail setup acquired its locks",
  );
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
  const envPath = join(agentDir, ".env");
  const expectedEnv = readAgentMailEnvSnapshot(envPath);
  const diskEnv = readEffectiveAgentMailDiskEnv(expectedEnv);
  const envCredentials = readExistingEnvCredentials(diskEnv);
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
    document,
    plan: configPlan.mutation,
    projectLease,
    envPath,
    expectedEnv,
    envValues,
    fault: deps.publicationFault,
  });

  return {
    agentName,
    target,
    mode,
    inboxId: resolvedCredentials.inboxId,
    inboxEmail: resolvedCredentials.email,
    envPath,
    augmentPath: configPath,
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
  mutation: MutationPlan;
  requiredPermissions: AgentMailRequiredPermissions;
  enabledCapabilities: string[];
}

function planAgentMailConfig(
  document: AuthoringDocument,
  target: AgentMailSetupTarget,
  mountedAugments: readonly MountedAugmentConfig[],
): AgentMailConfigPlan {
  const config: Record<string, unknown> = {
    ...mountedAugments.find((entry) => entry.name === target)!.options,
  };
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
    } catch {
      throw new Error(
        "AgentMail options are invalid; review the declared capabilities before setup. No credentials were read or changed.",
      );
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

  return {
    mutation: planAugmentMutation(
      document,
      "agentmail-config",
      [{ kind: "set-augment-options", name: target, options: config as RawRecord }],
      [],
      [
        readFileSnapshot(join(document.projectDir, ".gitignore"), AUTHORING_LIMITS.outputBytes, {
          allowMissing: true,
        }),
      ],
    ),
    requiredPermissions,
    enabledCapabilities:
      target === "agentMail"
        ? describeAgentMailCapabilities(requirements)
        : ["send visitorAuth magic links"],
  };
}

interface MountedAugmentConfig {
  name: string;
  type: string;
  options: Record<string, unknown>;
}

/** Raw declarations never resolve environment values or import augment code. */
function readMountedAugmentConfigs(document: AuthoringDocument): MountedAugmentConfig[] {
  return document.declarations.map((entry) => {
    if (entry.options !== undefined && !isRecord(entry.options)) {
      throw new Error("Augment options must be an object before automatic AgentMail setup.");
    }
    return {
      name: entry.name!,
      type: entry.type,
      options: isRecord(entry.options) ? entry.options : {},
    };
  });
}

function commitAgentMailSetup(input: {
  document: AuthoringDocument;
  plan: MutationPlan;
  projectLease: ProjectMutationLease;
  envPath: string;
  expectedEnv: AgentMailEnvSnapshot;
  envValues: Record<string, string>;
  fault?: PublicationFaultHook;
}): string[] {
  const output = renderEnvValues(input.expectedEnv.source, input.envValues);
  if (Buffer.byteLength(output) > AUTHORING_LIMITS.documentBytes)
    throw new Error("Agent credentials exceed the supported byte limit; no files were changed.");
  // Revalidate every config preimage after awaited provider calls, before secrets change.
  for (const snapshot of input.plan.inputs)
    assertSnapshotUnchanged(snapshot, "agent.yaml changed while AgentMail setup was running");
  assertSnapshotUnchanged(input.expectedEnv.file, ".env changed while AgentMail setup was running");
  writeFileSafely(input.envPath, output, { mode: 0o600 });
  let envPostimage: FileSnapshot;
  try {
    envPostimage = readFileSnapshot(input.envPath, AUTHORING_LIMITS.documentBytes);
    if (!envPostimage.exists || decodeSnapshotText(envPostimage.bytes) !== output)
      throw new Error("Credential output changed");
  } catch {
    throw new Error(
      "AgentMail credential output could not be verified. Configuration was not published; preserve .env and review it manually before retrying.",
    );
  }
  let publication: PublicationResult;
  try {
    publication = publishMutationPlan(input.plan, {
      lease: input.projectLease,
      fault: input.fault,
    });
  } catch {
    const restored = compensateAgentMailEnv(input, envPostimage);
    throw new Error(
      restored
        ? "AgentMail configuration publication failed before activation. Previous credentials were restored; review project state before retrying."
        : "AgentMail configuration publication failed and safe credential restoration could not be proved. Preserve .env and review configuration and private operation receipts before retrying.",
    );
  }
  if (publication.status === "complete") {
    try {
      assertSnapshotUnchanged(
        envPostimage,
        ".env changed during AgentMail configuration publication",
      );
    } catch {
      throw new Error(
        `AgentMail configuration was published by operation ${publication.operationId}, but .env changed before completion. Preserve the newer credentials and review configuration before retrying.`,
      );
    }
    return Object.keys(input.envValues);
  }
  const restored =
    publication.activation === "original" && compensateAgentMailEnv(input, envPostimage);
  throw new Error(
    `AgentMail configuration publication ${publication.status}; operation ${publication.operationId}. Configuration is ${publication.activation}. ` +
      (restored
        ? "Previous credentials were restored after verifying original configuration and unchanged credential output. "
        : "Credentials were retained because safe restoration could not be proved. ") +
      "Preserve the private receipt and use guarded rollback before retrying setup.",
  );
}

function compensateAgentMailEnv(
  input: { document: AuthoringDocument; envPath: string; expectedEnv: AgentMailEnvSnapshot },
  envPostimage: FileSnapshot,
): boolean {
  try {
    // A thrown or returned publication failure is not proof that activation stayed original.
    const config = readFileSnapshot(input.document.configPath, AUTHORING_LIMITS.documentBytes);
    const original = input.document.config;
    if (
      !config.exists ||
      config.sha256 !== original.sha256 ||
      (config.identity.mode & 0o777) !== (original.identity.mode & 0o777)
    )
      return false;
    assertSnapshotUnchanged(
      envPostimage,
      ".env changed during AgentMail configuration publication",
    );
    if (input.expectedEnv.existed) {
      writeFileSafely(input.envPath, input.expectedEnv.source!, { mode: 0o600 });
    } else {
      rmSync(input.envPath);
    }
    const restored = readAgentMailEnvSnapshot(input.envPath);
    return (
      restored.existed === input.expectedEnv.existed && restored.source === input.expectedEnv.source
    );
  } catch {
    return false;
  }
}

function assertSnapshotUnchanged(expected: FileSnapshot, reason: string): void {
  const current = readFileSnapshot(
    expected.path,
    Math.max(AUTHORING_LIMITS.documentBytes, expected.exists ? expected.identity.size : 0),
    { allowMissing: true },
  );
  if (
    current.exists !== expected.exists ||
    (current.exists &&
      expected.exists &&
      (current.sha256 !== expected.sha256 ||
        !sameFileIdentity(current.identity, expected.identity)))
  ) {
    throw new Error(`${reason}; setup did not overwrite the newer file.`);
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
  mountedAugments: readonly MountedAugmentConfig[],
): AgentMailSetupTarget {
  if (targetArg !== undefined) return parseTarget(targetArg);

  const installedTargets = (["agentMail", "visitorAuth"] as const).filter((target) =>
    isCanonicalSetupTargetInstalled(target, mountedAugments),
  );
  if (installedTargets.length === 1) return installedTargets[0]!;
  if (installedTargets.length === 0) {
    if (
      mountedAugments.some(
        (augment) => augment.type === "agentMail" || augment.type === "visitorAuth",
      )
    ) {
      throw new Error(
        "AgentMail setup found only custom-named or duplicate AgentMail-compatible augments. " +
          "Automatic setup supports one canonical inline agentMail/visitorAuth instance per type; configure these instances manually.",
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
  mountedAugments: readonly MountedAugmentConfig[],
): boolean {
  const sameTypeConsumers = mountedAugments.filter((augment) => augment.type === target);
  return sameTypeConsumers.length === 1 && sameTypeConsumers[0]!.name === target;
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
    `${target} is mounted under a custom name. Automatic AgentMail setup only updates one canonical inline ` +
      `${target} declaration in agent.yaml; configure this instance manually.`,
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
  let entries = 0;
  let totalBytes = 0;
  for (const directory of new Set([agentDir, invocationDir])) {
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++entries > AUTHORING_LIMITS.yamlNodes)
          throw new Error(
            "Dotenv discovery exceeds the supported directory limit; select a smaller invocation directory.",
          );
        if (!/^\.env(?:\.[A-Za-z0-9_-]+)+$/.test(entry.name) && entry.name !== ".env") continue;
        const path = join(directory, entry.name);
        const file = readFileSnapshot(path, AUTHORING_LIMITS.documentBytes, { allowMissing: true });
        if (!file.exists) continue;
        totalBytes += file.bytes.byteLength;
        if (totalBytes > AUTHORING_LIMITS.aggregateInputBytes)
          throw new Error("Dotenv discovery exceeds the supported byte limit.");
        const containsProvisioningKey = parseEnvFile(decodeSnapshotText(file.bytes)).some(
          (line) =>
            line.kind === "kv" &&
            line.key === "AGENTMAIL_ACCOUNT_API_KEY" &&
            line.value.trim().length > 0,
        );
        if (containsProvisioningKey) paths.add(path);
      }
    } finally {
      handle.closeSync();
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
            "Incoming email will be processed according to the agentMail options in agent.yaml.",
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

function readAgentNameSnapshot(document: AuthoringDocument): string {
  const name = document.value.name;
  if (typeof name === "string" && name.trim().length > 0) return name.trim();
  throw new Error("agent.yaml is missing a non-empty name.");
}

function readAgentIdSnapshot(document: AuthoringDocument): string {
  const id = document.value.id;
  if (
    typeof id === "string" &&
    /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  )
    return id;
  throw new Error("agent.yaml is missing a valid immutable id.");
}

function readAgentMailEnvSnapshot(envPath: string): AgentMailEnvSnapshot {
  const file = readFileSnapshot(envPath, AUTHORING_LIMITS.documentBytes, { allowMissing: true });
  return file.exists
    ? { file, existed: true, source: decodeSnapshotText(file.bytes) }
    : { file, existed: false };
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
