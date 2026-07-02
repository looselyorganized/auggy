import { confirm, input, password, select } from "@inquirer/prompts";
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createAgentMailProvisioningClient,
  VISITOR_AUTH_AGENTMAIL_PERMISSIONS,
  type AgentMailProvisioningClient,
} from "../agentmail-provisioning";
import { successMark } from "../_shared/styles";
import { displayPath } from "../display-path";
import { parseEnvFile } from "../env-parse";
import { upsertEnvValues } from "../env-writer";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import { VALID_NAME_RE } from "../config-parser";

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

  const provisioner =
    deps.provisioner ?? createAgentMailProvisioningClient({ apiBaseUrl: opts.baseUrl });
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
        ? await runSignupFlow(target, agentName, opts, provisioner, prompts)
        : mode === "existing"
          ? await runExistingAccountFlow(target, agentName, agentId, opts, provisioner, prompts)
          : await runManualFlow(opts, prompts);

  const envKeys = upsertEnvValues(envPath, {
    AGENTMAIL_API_KEY: credentials.apiKey,
    AGENTMAIL_INBOX_ID: credentials.inboxId,
  });
  patchAgentMailConfig(target, augmentPath);

  return {
    agentName,
    target,
    mode,
    inboxId: credentials.inboxId,
    inboxEmail: credentials.email,
    envPath,
    augmentPath,
    envKeys,
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

  const runtimeKey = await provisioner.createInboxApiKey({
    apiKey: signup.apiKey,
    inboxId: signup.inboxId,
    name: runtimeKeyName(agentName, target),
    permissions: VISITOR_AUTH_AGENTMAIL_PERMISSIONS,
  });
  return { inboxId: signup.inboxId, apiKey: runtimeKey.apiKey };
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
    permissions: VISITOR_AUTH_AGENTMAIL_PERMISSIONS,
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

function patchAgentMailConfig(target: AgentMailSetupTarget, augmentPath: string): void {
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

  if (target === "visitorAuth") {
    const currentAgentMail =
      config.agentMail && typeof config.agentMail === "object" && !Array.isArray(config.agentMail)
        ? (config.agentMail as Record<string, unknown>)
        : {};

    config.agentMail = {
      ...currentAgentMail,
      transport: "agentmail",
      apiKey: "${AGENTMAIL_API_KEY}",
      inboxId: "${AGENTMAIL_INBOX_ID}",
    };
  } else {
    config.apiKey = "${AGENTMAIL_API_KEY}";
    config.inboxId = "${AGENTMAIL_INBOX_ID}";
  }

  doc.config = config;
  writeFileSync(augmentPath, stringifyYaml(doc));
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
  const readyText =
    result.target === "visitorAuth"
      ? "visitorAuth will now send magic links with AgentMail."
      : "agentMail will now send outbound email with AgentMail.";
  return [
    `${successMark()} AgentMail inbox ready: ${inbox}`,
    `${successMark()} Wrote .env: ${result.envKeys.join(", ")}`,
    `${successMark()} Updated ${displayPath(result.augmentPath)}`,
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

function readExistingEnvCredentials(
  envPath: string,
): { inboxId: string; apiKey: string; email?: string } | null {
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
