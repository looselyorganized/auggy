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
  type AgentMailOwnedInbox,
  type AgentMailProvisioningClient,
  type AgentMailProvisioningTarget,
  type AgentMailRuntimeKeyPermissions,
} from "../agentmail-provisioning";
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
const AGENTMAIL_OTP_MAX_ATTEMPTS = 3;
const AGENTMAIL_USERNAME_MAX_ATTEMPTS = 3;
const AGENTMAIL_RUNTIME_ENV_KEYS = [
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "AGENTMAIL_INBOX_EMAIL",
] as const;

type AgentMailRuntimeEnvKey = (typeof AGENTMAIL_RUNTIME_ENV_KEYS)[number];

interface ScopedRuntimeKeyEvidence {
  id: string;
  name: string;
}

interface AgentMailSetupCredentials {
  inboxId: string;
  apiKey: string;
  email?: string;
  scopedRuntimeKey?: ScopedRuntimeKeyEvidence;
  deferredTermination?: DeferredSetupTermination;
}

interface DeferredSetupTermination {
  close(): NodeJS.Signals | undefined;
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
  runtimeKeyId?: string;
  runtimeKeyName?: string;
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
  const agentId = readAgentIdSnapshot(expectedAgentConfig);
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
  let mode: AgentMailSetupMode = await resolveMode(
    opts.mode,
    prompts.select,
    envCredentials !== null,
    interactive,
  );
  assertModeOptionCompatibility(mode, opts);
  assertNonInteractiveSetupInputs(mode, opts, interactive);
  assertSharedCredentialMode(target, mode, otherConsumers, diskEnv);
  if (mode === "signup" || mode === "existing") {
    assertNoAutomaticRuntimeCredentialRotation(diskEnv);
  } else {
    assertAmbientDiskEnvParity(diskEnv);
  }
  if (
    (mode === "signup" || mode === "existing") &&
    runtimeKeyName(agentName, target).length > 256
  ) {
    throw new Error(
      "Agent name is too long for an AgentMail runtime-key name (maximum 256 characters).",
    );
  }
  let credentials: AgentMailSetupCredentials;
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
        prompts.confirm,
        agentDir,
        deps.cwd ?? process.cwd(),
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
      prompts.confirm,
      agentDir,
      deps.cwd ?? process.cwd(),
    );
  } else {
    credentials = await runManualFlow(opts, prompts);
  }
  if (mode === "manual") {
    assertSelectedCredentialsMatchAmbientEnv(diskEnv, {
      AGENTMAIL_API_KEY: credentials.apiKey,
      AGENTMAIL_INBOX_ID: credentials.inboxId,
    });
  }
  let resolvedCredentials: AgentMailSetupCredentials = credentials;
  let envKeys: string[] | undefined;
  let setupError: unknown;
  try {
    resolvedCredentials =
      target === "agentMail" ? await ensureInboxEmail(credentials, provisioner) : credentials;
    const envValues = {
      AGENTMAIL_API_KEY: resolvedCredentials.apiKey,
      AGENTMAIL_INBOX_ID: resolvedCredentials.inboxId,
      ...(target === "agentMail"
        ? { AGENTMAIL_INBOX_EMAIL: requireInboxEmail(resolvedCredentials.email) }
        : {}),
    };
    if (mode === "manual") assertSelectedCredentialsMatchAmbientEnv(diskEnv, envValues);
    envKeys = commitAgentMailSetup({
      configPath,
      expectedAgentConfig,
      envPath,
      expectedEnv,
      augmentPath,
      expectedAugmentConfig: configPlan.expectedAugmentConfig,
      updatedAugmentConfig: configPlan.updatedAugmentConfig,
      envValues,
    });
  } catch (error) {
    setupError = error;
  }
  const deferredSignal = credentials.deferredTermination?.close();
  if (setupError) {
    if (!credentials.scopedRuntimeKey) throw setupError;
    const key = credentials.scopedRuntimeKey;
    throw new Error(
      `AgentMail created scoped runtime key "${key.name}" (${key.id}), but local setup did not commit. ` +
        "Review and revoke that orphaned key in AgentMail before retrying. " +
        `Local commit error: ${safeErrorMessage(setupError)}${
          deferredSignal
            ? ` Setup also received ${deferredSignal} while reconciling the mutation.`
            : ""
        }`,
    );
  }
  if (deferredSignal) {
    throw new Error(
      `AgentMail setup received ${deferredSignal} while creating the scoped runtime key. ` +
        "The provider mutation and local credential commit completed safely; inspect .env before retrying.",
    );
  }

  return {
    agentName,
    target,
    mode,
    inboxId: resolvedCredentials.inboxId,
    inboxEmail: resolvedCredentials.email,
    envPath,
    augmentPath,
    envKeys: envKeys!,
    requiredPermissions: enabledPermissionNames(configPlan.runtimeKeyPermissions),
    ...(resolvedCredentials.scopedRuntimeKey
      ? {
          runtimeKeyId: resolvedCredentials.scopedRuntimeKey.id,
          runtimeKeyName: resolvedCredentials.scopedRuntimeKey.name,
        }
      : {}),
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
): Promise<AgentMailSetupCredentials> {
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
  await verifyAgentMailSignup(target, signup.apiKey, provisioner, prompts.input);

  const inbox =
    target === "agentMail"
      ? await lookupCanonicalInbox(provisioner, signup.apiKey, signup.inboxId)
      : undefined;
  const runtimeKey = await createScopedRuntimeKey(
    target,
    agentName,
    signup.apiKey,
    signup.inboxId,
    runtimeKeyPermissions,
    provisioner,
  );
  return {
    inboxId: signup.inboxId,
    apiKey: runtimeKey.apiKey,
    email: inbox?.email,
    scopedRuntimeKey: runtimeKey.evidence,
    deferredTermination: runtimeKey.deferredTermination,
  };
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
  promptConfirm: PromptConfirm,
  agentDir: string,
  invocationDir: string,
): Promise<AgentMailSetupCredentials> {
  const parentApiKey = await resolveProvisioningAccountApiKey(
    opts.apiKey,
    prompts.password,
    agentDir,
    invocationDir,
  );
  const initialUsername = await resolveUsername(agentName, opts.username, prompts.input);
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

  const inbox = await resolveExistingAccountInbox({
    target,
    agentName,
    agentId,
    parentApiKey,
    initialUsername,
    displayName: normalizedDisplayName,
    provisioner,
    promptInput: prompts.input,
    promptConfirm,
    interactive,
  });
  const runtimeKey = await createScopedRuntimeKey(
    target,
    agentName,
    parentApiKey,
    inbox.inboxId,
    runtimeKeyPermissions,
    provisioner,
  );
  return {
    inboxId: inbox.inboxId,
    apiKey: runtimeKey.apiKey,
    email: inbox.email,
    scopedRuntimeKey: runtimeKey.evidence,
    deferredTermination: runtimeKey.deferredTermination,
  };
}

async function resolveExistingAccountInbox(input: {
  target: AgentMailSetupTarget;
  agentName: string;
  agentId: string;
  parentApiKey: string;
  initialUsername: string;
  displayName: string;
  provisioner: AgentMailProvisioningClient;
  promptInput: PromptInput;
  promptConfirm: PromptConfirm;
  interactive: boolean;
}): Promise<AgentMailOwnedInbox> {
  const clientId = buildAgentMailClientId(input.agentId, input.target);
  let username = input.initialUsername;
  for (let attempt = 1; attempt <= AGENTMAIL_USERNAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await input.provisioner.createInbox({
        apiKey: input.parentApiKey,
        username,
        displayName: input.displayName,
        clientId,
        metadata: { source: "auggy-cli", agent: input.agentName, augment: input.target },
      });
    } catch (error) {
      if (!isDefinitiveInboxAddressCollision(error)) throw error;

      const reusable = await findCompatibleOwnedInbox(
        input.provisioner,
        input.parentApiKey,
        input.agentId,
        input.target,
        `${username}@agentmail.to`,
      );
      if (reusable && input.interactive) {
        const reuse = await input.promptConfirm({
          message: `${reusable.email} already belongs to this Auggy agent in your AgentMail account. Reuse it?`,
          default: true,
        });
        if (reuse) return reusable;
      }

      if (!input.interactive || attempt === AGENTMAIL_USERNAME_MAX_ATTEMPTS) {
        throw inboxAddressCollisionRecoveryError(username);
      }
      try {
        const nextUsername = await input.promptInput({
          message: `${username}@agentmail.to is taken. Choose another inbox username:`,
          default: `${slugForAgentMail(input.agentName)}-${attempt + 1}`,
          validate: (candidate) =>
            validAgentMailUsername(candidate.trim()) ||
            "use letters, numbers, hyphens, or underscores",
        });
        username = slugForAgentMail(nextUsername);
        if (!validAgentMailUsername(username)) {
          throw new Error(`Invalid AgentMail username "${nextUsername}".`);
        }
      } catch (promptError) {
        if (!isPromptCancellation(promptError)) throw promptError;
        throw new Error(
          "AgentMail inbox selection was cancelled. No inbox was adopted, no runtime key was created, and no local credentials were changed.",
        );
      }
    }
  }
  throw inboxAddressCollisionRecoveryError(username);
}

async function findCompatibleOwnedInbox(
  provisioner: AgentMailProvisioningClient,
  accountApiKey: string,
  agentId: string,
  target: AgentMailSetupTarget,
  expectedEmail: string,
): Promise<AgentMailOwnedInbox | undefined> {
  if (!provisioner.listInboxes) return undefined;
  let inboxes: AgentMailOwnedInbox[];
  try {
    inboxes = await provisioner.listInboxes(accountApiKey);
  } catch {
    // A failed read cannot prove ownership. A different username remains a
    // safe recovery path because the failed create was a definitive collision.
    return undefined;
  }
  const otherTarget: AgentMailSetupTarget = target === "agentMail" ? "visitorAuth" : "agentMail";
  const compatibleClientIds = new Set([
    buildAgentMailClientId(agentId, target),
    buildAgentMailClientId(agentId, otherTarget),
  ]);
  const matches = inboxes.filter(
    (inbox) =>
      inbox.email.toLowerCase() === expectedEmail.toLowerCase() &&
      inbox.clientId !== undefined &&
      compatibleClientIds.has(inbox.clientId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isDefinitiveInboxAddressCollision(error: unknown): boolean {
  return (
    error instanceof AgentMailProvisioningApiError &&
    error.operation === "/inboxes" &&
    error.status === 403 &&
    error.providerCode === "resource_taken" &&
    !error.outcomeUnknown
  );
}

function inboxAddressCollisionRecoveryError(username: string): Error {
  return new Error(
    `AgentMail inbox ${username}@agentmail.to is already taken. No inbox was adopted, no runtime key was created, and no local credentials were changed. ` +
      "Retry with a different --username, or connect an existing inbox explicitly with --mode manual.",
  );
}

async function runManualFlow(
  opts: AgentMailSetupOptions,
  prompts: {
    input: PromptInput;
    password: PromptPassword;
  },
): Promise<AgentMailSetupCredentials> {
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

async function verifyAgentMailSignup(
  target: AgentMailSetupTarget,
  signupApiKey: string,
  provisioner: AgentMailProvisioningClient,
  promptInput: PromptInput,
): Promise<void> {
  for (let attempt = 1; attempt <= AGENTMAIL_OTP_MAX_ATTEMPTS; attempt += 1) {
    let otpCode: string;
    try {
      otpCode = await promptInput({
        message:
          attempt === 1
            ? "AgentMail verification code:"
            : `AgentMail verification code (attempt ${attempt} of ${AGENTMAIL_OTP_MAX_ATTEMPTS}):`,
        validate: (value) => value.trim().length > 0 || "verification code required",
      });
    } catch (error) {
      if (isPromptCancellation(error)) throw signupVerificationRecoveryError(target);
      throw error;
    }

    try {
      const verified = await provisioner.verify(signupApiKey, otpCode.trim());
      if (verified.verified) return;
    } catch (error) {
      if (!isDefinitiveInvalidVerificationCode(error)) throw error;
    }
  }
  throw signupVerificationRecoveryError(target);
}

async function createScopedRuntimeKey(
  target: AgentMailSetupTarget,
  agentName: string,
  parentApiKey: string,
  inboxId: string,
  permissions: AgentMailRuntimeKeyPermissions,
  provisioner: AgentMailProvisioningClient,
): Promise<{
  apiKey: string;
  evidence: ScopedRuntimeKeyEvidence;
  deferredTermination: DeferredSetupTermination;
}> {
  const name = runtimeKeyName(agentName, target);
  const deferredTermination = deferSetupTermination();
  try {
    const key = await provisioner.createInboxApiKey({
      apiKey: parentApiKey,
      inboxId,
      name,
      permissions,
    });
    return {
      apiKey: key.apiKey,
      evidence: { id: key.apiKeyId, name },
      deferredTermination,
    };
  } catch (error) {
    const deferredSignal = deferredTermination.close();
    if (!hasOutcomeUnknown(error)) {
      if (!deferredSignal) throw error;
      throw new Error(
        `${safeErrorMessage(error)} Setup also received ${deferredSignal} while reconciling the failed mutation.`,
      );
    }
    throw new Error(
      `${safeErrorMessage(error)} Review AgentMail for a scoped key named "${name}" and revoke ` +
        `any orphan before retrying setup.${
          deferredSignal
            ? ` Setup also received ${deferredSignal} while reconciling the mutation.`
            : ""
        }`,
    );
  }
}

function deferSetupTermination(): DeferredSetupTermination {
  let deferredSignal: NodeJS.Signals | undefined;
  let closed = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      deferredSignal ??= signal;
    };
    handlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
  return {
    close(): NodeJS.Signals | undefined {
      if (closed) return deferredSignal;
      closed = true;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      return deferredSignal;
    },
  };
}

interface AgentMailConfigPlan {
  expectedAugmentConfig: string;
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
    expectedAugmentConfig,
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
      "agentMail and visitorAuth share one AgentMail inbox and runtime key. Configure agentMail first, " +
        "then run `auggy agentmail setup visitorAuth --mode env` so visitorAuth reuses those credentials.",
    );
  }

  const visitorUsesAgentMail = otherConsumers.some((augment) => {
    const agentMail = isRecord(augment.options.agentMail) ? augment.options.agentMail : undefined;
    return agentMail?.transport !== "console";
  });
  if (visitorUsesAgentMail && mode !== "env") {
    throw new Error(
      "visitorAuth already uses the shared AgentMail inbox and runtime key. Reuse those credentials with " +
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

function signupVerificationRecoveryError(target: AgentMailSetupTarget): Error {
  return new Error(
    "AgentMail verification did not complete after the available attempts. No local credentials were changed. " +
      "Sign in to AgentMail to confirm the account and obtain an account API key, then run:\n\n" +
      `  auggy agentmail setup ${target} --mode existing`,
  );
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

function isDefinitiveInvalidVerificationCode(error: unknown): boolean {
  if (
    !(error instanceof AgentMailProvisioningApiError) ||
    error.operation !== "/agent/verify" ||
    error.outcomeUnknown ||
    ![400, 401, 403, 422].includes(error.status)
  ) {
    return false;
  }
  const code = error.providerCode?.toLowerCase() ?? "";
  if (/^(invalid|incorrect)_(otp|code)$/.test(code) || code === "verification_failed") {
    return true;
  }
  return error.issues.some((issue) => issue.path.at(-1) === "otp_code");
}

function hasOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeUnknown" in error &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true
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

async function resolveProvisioningAccountApiKey(
  explicit: string | undefined,
  promptPassword: PromptPassword,
  agentDir: string,
  invocationDir: string,
): Promise<string> {
  if (usableOption(explicit)) return explicit!.trim();

  const ambient = usableEnvValue(process.env.AGENTMAIL_ACCOUNT_API_KEY);
  if (ambient) {
    const dotenvSources = findProjectDotenvProvisioningKeySources(agentDir, invocationDir);
    if (dotenvSources.length > 0) {
      throw new Error(
        "AGENTMAIL_ACCOUNT_API_KEY is a provisioning-only account credential and must not be stored in project dotenv files. " +
          `Remove it from ${dotenvSources.map((path) => displayPath(path)).join(", ")}, then use the masked prompt or a genuinely process-scoped environment variable. ` +
          "Setup did not contact AgentMail or change local files.",
      );
    }
    return ambient;
  }

  const prompted = await promptPassword({
    message: "AgentMail API key that can create inboxes:",
    mask: "*",
    validate: (value) => value.trim().length > 0 || "AgentMail API key required",
  });
  return prompted.trim();
}

function findProjectDotenvProvisioningKeySources(
  agentDir: string,
  invocationDir: string,
): string[] {
  const nodeEnv = process.env.NODE_ENV;
  const names = [
    ".env",
    ".env.local",
    ...(nodeEnv && /^[A-Za-z0-9_-]+$/.test(nodeEnv)
      ? [`.env.${nodeEnv}`, `.env.${nodeEnv}.local`]
      : []),
  ];
  const paths = new Set<string>();
  for (const directory of new Set([agentDir, invocationDir])) {
    for (const name of names) {
      const path = join(directory, name);
      if (!existsSync(path)) continue;
      const containsProvisioningKey = parseEnvFile(readFileSync(path, "utf-8")).some(
        (line) =>
          line.kind === "kv" &&
          line.key === "AGENTMAIL_ACCOUNT_API_KEY" &&
          usableOption(line.value),
      );
      if (containsProvisioningKey) paths.add(path);
    }
  }
  return [...paths].sort();
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
  return value.length <= 64 && VALID_NAME_RE.test(value);
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

function readAgentNameSnapshot(configPath: string, source: string): string {
  const raw = parseYaml(source) as { name?: unknown } | null;
  if (typeof raw?.name === "string" && raw.name.trim().length > 0) return raw.name.trim();
  throw new Error(`agent.yaml at ${configPath} is missing a non-empty name.`);
}

function readAgentIdSnapshot(source: string): string | null {
  const raw = parseYaml(source) as { id?: unknown } | null;
  if (typeof raw?.id === "string" && raw.id.length > 0) return raw.id;
  return null;
}

function requireAgentMailProvisioningAgentId(agentId: string | null, configPath: string): string {
  if (agentId && IMMUTABLE_AGENT_ID_RE.test(agentId)) return agentId;
  throw new Error(
    `${displayPath(configPath)} must contain a valid immutable aug1_ UUID before AgentMail can create an inbox.`,
  );
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
  const apiKey = usableEnvValue(values.AGENTMAIL_API_KEY);
  const inboxId = usableEnvValue(values.AGENTMAIL_INBOX_ID);
  if (!apiKey || !inboxId) return null;
  return { apiKey, inboxId };
}

function assertAmbientDiskEnvParity(diskEnv: AgentMailDiskEnv): void {
  for (const key of AGENTMAIL_RUNTIME_ENV_KEYS) {
    const ambient = usableEnvValue(process.env[key]);
    const disk = usableEnvValue(diskEnv[key]);
    if (ambient && disk && ambient !== disk) throw ambientEnvConflictError(key);
  }
}

function assertNoAutomaticRuntimeCredentialRotation(diskEnv: AgentMailDiskEnv): void {
  const existingKeys = AGENTMAIL_RUNTIME_ENV_KEYS.filter(
    (key) => usableEnvValue(diskEnv[key]) || usableEnvValue(process.env[key]),
  );
  if (existingKeys.length > 0) {
    throw new Error(
      `Existing AgentMail runtime credentials (${existingKeys.join(", ")}) will not be rotated automatically. ` +
        "Reuse the current inbox and runtime key with --mode env. To provision replacements, first revoke the old " +
        "runtime key, remove the AGENTMAIL_* values from .env, and unset exported AGENTMAIL_* values before retrying; " +
        "setup did not contact AgentMail or change local files.",
    );
  }
}

function assertSelectedCredentialsMatchAmbientEnv(
  diskEnv: AgentMailDiskEnv,
  selected: Partial<Record<AgentMailRuntimeEnvKey, string>>,
): void {
  for (const key of AGENTMAIL_RUNTIME_ENV_KEYS) {
    const value = usableEnvValue(selected[key]);
    if (!value) continue;
    const ambient = usableEnvValue(process.env[key]);
    const priorDisk = usableEnvValue(diskEnv[key]);
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
    `Manual AgentMail setup cannot replace the existing ${key} runtime credential. ` +
      "Reuse the exact existing credentials or use --mode env. To intentionally replace them, first revoke the old " +
      "runtime key, remove the AGENTMAIL_* values from .env, and unset exported AGENTMAIL_* values before retrying; " +
      "setup did not change local files.",
  );
}

function ambientEnvConflictError(key: AgentMailRuntimeEnvKey): Error {
  return new Error(
    `${key} exported in the setup process conflicts with the agent's .env credentials. ` +
      `Make it match .env and reuse the credentials with --mode env. To replace them, first revoke the old runtime ` +
      `key, remove the AGENTMAIL_* values from .env, and unset exported AGENTMAIL_* values before retrying; ` +
      "setup did not change local files.",
  );
}

async function ensureInboxEmail(
  credentials: AgentMailSetupCredentials,
  provisioner: AgentMailProvisioningClient,
): Promise<AgentMailSetupCredentials & { email: string }> {
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
