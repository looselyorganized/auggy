/**
 * Augment resolver — AugmentConfig[] → Augment[].
 *
 * Maps each augment declaration from agent.yaml to a concrete Augment
 * object by dispatching to the appropriate factory function. Built-in
 * augments resolve by type name; custom augments resolve by dynamic
 * import of a local .ts file.
 *
 * Special handling:
 *  - supabaseMemory: constructs a SupabaseLikeClient from supabaseUrl
 *    + supabaseKey options via @supabase/supabase-js.
 *  - fileMemory, filesystem: resolves relative paths against agentDir.
 *  - All augments: overrides the auto-generated augment name with the
 *    operator's chosen instance name from the config.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileMemory } from "../augments/fileMemory";
import { supabaseMemory } from "../augments/supabaseMemory";
import { filesystem } from "../augments/filesystem";
import { webTransport } from "../transports/web-transport";
import { webFetch } from "../augments/webFetch";
import { knowledgeRoot } from "../augments/knowledge";
import { skills } from "../augments/skills";
import { bash } from "../augments/bash";
import { notify } from "../augments/notify";
import { mcp } from "../augments/mcp";
import { agentMail } from "../augments/agentMail";
import { telegramTransport } from "../augments/telegramTransport";
import { turnControl, type TurnControlOptions } from "../augments/turnControl";
import { visitorAuth } from "../augments/visitorAuth";
import type { VisitorAuthOptions, VisitorAuthAugmentExtras } from "../augments/visitorAuth/types";
// `link` (value) used to be statically imported here, which transitively
// loaded `@auggy/link` at boot regardless of whether any agent selected the
// link augment (Codex 1st-pass finding #3). After Phase 5 the value is
// loaded lazily inside the `case "link":` branch via dynamic-import, and
// `@auggy/link` itself resolves from the agent dir via importFromAgent.
// Type imports remain — they're erased at compile, no runtime cost.
import type {
  LinkAugmentAgentCard,
  LinkAugmentInternalOptions,
  LinkPeerConfig,
} from "../augments/link";
import type {
  AgentMailAugmentOptions,
  Augment,
  ContextOrigin,
  CreatorConfig,
  NotifyAugmentOptions,
  TelegramTransportOptions,
} from "../types";
import type { AugmentConfig } from "./types";
import type { BudgetsAugmentOptions } from "../augments/budgets";
import { validateBundledSkills } from "./skill-validator";
import { auggySelf, type AuggySelfAgentMetadata } from "./auggy-self-augment";

// ---------------------------------------------------------------------------
// Path resolution helper
// ---------------------------------------------------------------------------

function resolvePath(path: string, agentDir: string): string {
  if (path.startsWith("/")) return path;
  return resolve(agentDir, path);
}

// ---------------------------------------------------------------------------
// Built-in resolvers
// ---------------------------------------------------------------------------

function resolveFileMemory(opts: Record<string, unknown>, agentDir: string): Augment {
  const source = opts.source as string;
  const resolvedSource = resolvePath(source, agentDir);
  const isLearnedBehaviorStore =
    opts.label === "learned" && /(^|\/)learned(?:-behaviors)?\.md$/.test(resolvedSource);
  const learnedBehaviorBase = isLearnedBehaviorStore
    ? resolvedSource.replace(/learned(?:-behaviors)?\.md$/, "")
    : undefined;

  return fileMemory({
    label: opts.label as string,
    source: learnedBehaviorBase ? `${learnedBehaviorBase}learned-behaviors.md` : resolvedSource,
    fallbackSources: learnedBehaviorBase ? [`${learnedBehaviorBase}learned.md`] : undefined,
    mutable: opts.mutable as boolean,
    origin: isLearnedBehaviorStore ? "operator" : (opts.origin as ContextOrigin),
    writeTrustLevels: isLearnedBehaviorStore
      ? ["creator"]
      : (opts.writeTrustLevels as ("creator" | "agent" | "public")[] | undefined),
    priority: opts.priority as "required" | "high" | "normal" | "low" | "evictable",
    placement: opts.placement as "system" | "preamble" | "assistant-preamble",
    eviction: opts.eviction as "never" | "summarize" | "drop",
    ttl: opts.ttl as "turn" | "session" | "persistent" | undefined,
  });
}

async function resolveLayeredMemory(
  opts: Record<string, unknown>,
  agentDir: string,
): Promise<Augment> {
  const { layeredMemory } = await import("../augments/layeredMemory");
  const backend = (opts.backend as string | undefined) ?? "sqlite";
  const namespace = (opts.namespace as string | undefined) ?? "ep";
  const retentionDays = opts.retentionDays as number | undefined;
  const autoSave =
    opts.autoSave && typeof opts.autoSave === "object" && !Array.isArray(opts.autoSave)
      ? (opts.autoSave as Parameters<typeof layeredMemory>[0]["autoSave"])
      : undefined;

  if (backend === "sqlite") {
    const dbPath = opts.dbPath as string | undefined;
    return layeredMemory({
      backend: "sqlite",
      dbPath: dbPath ? resolvePath(dbPath, agentDir) : resolvePath("./memory.db", agentDir),
      namespace,
      retentionDays,
      autoSave,
    });
  }

  if (backend === "supabase") {
    const supabaseUrl = opts.supabaseUrl as string | undefined;
    const supabaseKey = opts.supabaseKey as string | undefined;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "layeredMemory: supabase backend requires supabaseUrl and supabaseKey options",
      );
    }
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(supabaseUrl, supabaseKey) as unknown as Parameters<
      typeof layeredMemory
    >[0]["client"];
    return layeredMemory({
      backend: "supabase",
      client,
      table: (opts.table as string | undefined) ?? "agent_memory",
      namespace,
      retentionDays,
      autoSave,
    });
  }

  throw new Error(`layeredMemory: unknown backend "${backend}"`);
}

async function resolveSupabaseMemory(opts: Record<string, unknown>): Promise<Augment> {
  const { supabaseUrl, supabaseKey, ...rest } = opts;
  if (typeof supabaseUrl !== "string" || typeof supabaseKey !== "string") {
    throw new Error(
      "supabaseMemory requires supabaseUrl and supabaseKey options (use ${ENV_VAR} interpolation)",
    );
  }

  // Lazy import — only load @supabase/supabase-js when supabaseMemory is used.
  // The real SupabaseClient has narrower types than SupabaseLikeClient
  // (e.g. data is null on error), so we cast through unknown.
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(supabaseUrl, supabaseKey) as unknown as Parameters<
    typeof supabaseMemory
  >[0]["client"];

  return supabaseMemory({
    namespace: rest.namespace as string,
    client,
    table: rest.table as string,
    mutable: rest.mutable as boolean,
    origin: rest.origin as ContextOrigin,
    priority: rest.priority as "required" | "high" | "normal" | "low" | "evictable",
    placement: rest.placement as "system" | "preamble" | "assistant-preamble",
    eviction: rest.eviction as "never" | "summarize" | "drop",
    searchLimit: rest.searchLimit as number | undefined,
  });
}

function resolveFilesystem(opts: Record<string, unknown>, agentDir: string): Augment {
  const mounts = (opts.mounts as Array<Record<string, unknown>>).map((m) => ({
    name: m.name as string,
    path: resolvePath(m.path as string, agentDir),
    writable: m.writable as boolean | undefined,
    deletable: m.deletable as boolean | undefined,
    maxReadSize: m.maxReadSize as number | undefined,
    maxWriteSize: m.maxWriteSize as number | undefined,
    searchExcludes: m.searchExcludes as string[] | undefined,
  }));

  return filesystem({
    mounts,
    skillFile: opts.skillFile ? resolvePath(opts.skillFile as string, agentDir) : undefined,
  });
}

/**
 * Resolve the built-in `skills` augment (ADR-030). The `dir` option is
 * resolved against agentDir using the same relative→absolute pattern as
 * other agent-dir-relative paths, then handed to the augment factory.
 *
 * Default `dir` is `./skills` to match the scaffold layout (`auggy create`
 * copies bundled skill folders to `<agentDir>/skills/<augment>/`).
 */
function resolveSkills(opts: Record<string, unknown>, agentDir: string): Augment {
  const rawDir = (opts.dir as string | undefined) ?? "./skills";
  return skills({ dir: resolvePath(rawDir, agentDir) });
}

function resolveWebTransport(
  opts: Record<string, unknown>,
  agentDir: string,
  creator: CreatorConfig | undefined,
  lateBindings: {
    revocationCheck: ((id: string) => boolean) | null;
    identityLookup: VisitorAuthAugmentExtras["resolveVisitorIdentity"] | null;
  },
): Augment {
  const vtBase = opts.visitorTokens as
    | { enabled?: boolean; ttlSeconds?: number; signingKey?: string; agentBinding?: string }
    | undefined;
  return webTransport({
    port: opts.port as number,
    auth: opts.auth as { type: "bearer"; token: string },
    cors: opts.cors as { origins: string[] } | undefined,
    maxMessageLength: opts.maxMessageLength as number | undefined,
    access: opts.access as { agents?: Array<{ id: string; sharedSecret: string }> } | undefined,
    concurrency: opts.concurrency as number | undefined,
    maxQueueDepth: opts.maxQueueDepth as number | undefined,
    rateLimitPerPeer: opts.rateLimitPerPeer as { maxPerMinute: number } | undefined,
    visitorTokens: vtBase
      ? {
          ...vtBase,
          revocationCheck: (id: string) => lateBindings.revocationCheck?.(id) ?? false,
          identityLookup: (id: string) => lateBindings.identityLookup?.(id) ?? null,
        }
      : undefined,
    // G3: explicit yaml value must reach webTransport so the yaml > env >
    // default precedence works end-to-end. Without this forward, agent.yaml's
    // allowAnonymous is silently dropped and the env/default rule wins every
    // time — breaking the "operator's most-explicit choice wins" contract.
    allowAnonymous: opts.allowAnonymous as boolean | undefined,
    publicIntegration: opts.publicIntegration as boolean | undefined,
    // Wire the agent dir through to webTransport so the /console module can
    // read/write `.env`, `identity.md`, and admin-overrides.json. Without
    // this, the Credentials and Identity tabs render "agent directory not
    // configured" errors.
    agentDir,
    creator,
  });
}

function resolveWebFetch(opts: Record<string, unknown>): Augment {
  return webFetch({
    timeoutMs: opts.timeoutMs as number | undefined,
    maxRedirects: opts.maxRedirects as number | undefined,
    userAgent: opts.userAgent as string | undefined,
    defaultHeaders: opts.defaultHeaders as Record<string, string> | undefined,
  });
}

async function resolveCustom(config: AugmentConfig, agentDir: string): Promise<Augment> {
  if (!config.source) {
    throw new Error(`Custom augment "${config.name}": source path is required`);
  }

  const absPath = resolvePath(config.source, agentDir);
  let mod: Record<string, unknown>;
  try {
    mod = await import(absPath);
  } catch (err) {
    throw new Error(
      `Custom augment "${config.name}": failed to import "${absPath}": ${(err as Error).message}`,
    );
  }

  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error(
      `Custom augment "${config.name}": "${absPath}" must have a default export that is a function (got ${typeof factory})`,
    );
  }

  return factory(config.options ?? {}) as Augment;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveBash(opts: Record<string, unknown>, agentDir: string): Augment {
  const scripts = (opts.scripts as Array<Record<string, unknown>> | undefined)?.map((s) => ({
    name: s.name as string,
    description: s.description as string,
    command: s.command as string,
    workingDir: s.workingDir ? resolvePath(s.workingDir as string, agentDir) : undefined,
    timeout: s.timeout as number | undefined,
  }));

  return bash({
    risk: opts.risk as "scripts-only" | "restricted" | "standard" | "unrestricted" | undefined,
    allowedCommands: opts.allowedCommands as string[] | undefined,
    blockedCommands: opts.blockedCommands as string[] | undefined,
    workingDir: opts.workingDir ? resolvePath(opts.workingDir as string, agentDir) : undefined,
    inheritEnv: opts.inheritEnv as boolean | undefined,
    env: opts.env as Record<string, string> | undefined,
    timeout: opts.timeout as number | undefined,
    maxOutputBytes: opts.maxOutputBytes as number | undefined,
    maxToolCallsPerTurn: opts.maxToolCallsPerTurn as number | undefined,
    scripts,
  });
}

async function resolveLink(opts: Record<string, unknown>, agentDir: string): Promise<Augment> {
  const card = opts.agentCard as Record<string, unknown>;
  const agentCard: LinkAugmentAgentCard = {
    id: card.id as string,
    name: card.name as string,
    description: card.description as string,
    endpointUrl: card.endpointUrl as string,
    capabilities: card.capabilities as string[] | undefined,
  };

  const peersRaw = (opts.peers as Record<string, Record<string, unknown>> | undefined) ?? {};
  const peers: Record<string, LinkPeerConfig> = {};
  for (const [name, p] of Object.entries(peersRaw)) {
    peers[name] = {
      url: p.url as string,
      bearer: p.bearer as string,
      participantId: p.participantId as string,
      inboundBearer: p.inboundBearer as string,
      inboundBearerId: p.inboundBearerId as string,
    };
  }

  const linkOpts: LinkAugmentInternalOptions = {
    port: opts.port as number | undefined,
    dbPath: resolvePath(opts.dbPath as string, agentDir),
    agentCard,
    peers,
    agentDir,
  };

  // Dynamic-import the factory — keeps `@auggy/link` out of core's boot-time
  // module graph. The relative import is internal to auggy (resolves through
  // this package's own files); the factory's body then uses importFromAgent
  // to reach `@auggy/link` in the AGENT's node_modules.
  const { link } = await import("../augments/link");
  return await link(linkOpts);
}

function resolveVisitorAuth(opts: Record<string, unknown>, agentDir: string): Augment {
  const dbPath = (opts.dbPath as string | undefined) ?? "./visitor-auth.db";
  // CRITICAL: distinguish `null` (operator opt-out) from `undefined` (defaults to ./memory.db).
  // Using ?? would coerce both to the default string — wrong for opt-out semantics.
  const layeredMemoryDbPath =
    opts.layeredMemoryDbPath === null
      ? null
      : ((opts.layeredMemoryDbPath as string | undefined) ?? "./memory.db");

  const config: VisitorAuthOptions = {
    publicUrl: opts.publicUrl as string,
    dbPath: resolvePath(dbPath, agentDir),
    agentMail: opts.agentMail as VisitorAuthOptions["agentMail"],
    signingKey: opts.signingKey as string,
    agentBinding: opts.agentBinding as string | undefined,
    rateLimit: opts.rateLimit as VisitorAuthOptions["rateLimit"],
    reverifyAfterDays: opts.reverifyAfterDays as number | undefined,
    tokenTtlMinutes: opts.tokenTtlMinutes as number | undefined,
    notifyOnFirstVerify: opts.notifyOnFirstVerify as VisitorAuthOptions["notifyOnFirstVerify"],
    layeredMemoryDbPath:
      layeredMemoryDbPath === null ? null : resolvePath(layeredMemoryDbPath, agentDir),
    // G34: forward the production-override flag. The `agentMail.transport`
    // discriminator already flows through `opts.agentMail` above; no separate
    // wiring needed for it.
    allowConsoleInProduction: opts.allowConsoleInProduction as boolean | undefined,
  };
  return visitorAuth(config);
}

/**
 * Resolve an array of augment configs into concrete Augment objects.
 * Built-in types dispatch to their factory functions; custom types
 * use dynamic import of local .ts files.
 */
export async function resolveAugments(
  configs: AugmentConfig[],
  agentDir: string,
  resolverOpts: { creator?: CreatorConfig; selfInspection?: AuggySelfAgentMetadata } = {},
): Promise<Augment[]> {
  const augments: Augment[] = [];
  type NotifyToolExecute = NonNullable<Augment["tools"]>[number]["execute"];
  const notifyDestinationNames = new Set<string>();
  const notifyExecutorsByDestination = new Map<string, NotifyToolExecute>();

  for (const config of configs) {
    if (config.type !== "notify") continue;
    const destinations =
      (config.options?.destinations as Array<Record<string, unknown>> | undefined) ?? [];
    for (const destination of destinations) {
      if (typeof destination.name === "string") notifyDestinationNames.add(destination.name);
    }
  }

  const dispatchBudgetNotification: BudgetsAugmentOptions["notificationDispatcher"] = async (
    payload,
  ) => {
    const execute = notifyExecutorsByDestination.get(payload.destination);
    if (!execute) {
      throw new Error(
        `notify destination "${payload.destination}" is not mounted or has no notify tool`,
      );
    }

    const result = await execute(
      {
        to: payload.destination,
        summary: payload.summary,
        reason: payload.reason,
      },
      {
        turnId: payload.turnId,
        threadId: payload.threadId,
        peer: null,
      },
    );
    const content = typeof result === "string" ? result : result.content;
    let parsed: { status?: string; message?: string; detail?: string };
    try {
      parsed = JSON.parse(content) as { status?: string; message?: string; detail?: string };
    } catch {
      throw new Error(`notify returned non-JSON result: ${content.slice(0, 120)}`);
    }
    if (parsed.status !== "sent") {
      throw new Error(
        `notify returned ${parsed.status ?? "unknown"}: ${parsed.detail ?? parsed.message ?? "no detail"}`,
      );
    }
  };

  // Deferred-closure for C1: webTransport gets a stable callback reference
  // before visitorAuth is resolved; the callback reads lateBindings.revocationCheck
  // which is populated after the loop completes.
  const lateBindings: {
    revocationCheck: ((id: string) => boolean) | null;
    identityLookup: VisitorAuthAugmentExtras["resolveVisitorIdentity"] | null;
  } = {
    revocationCheck: null,
    identityLookup: null,
  };

  // Fix F2 — single-source signingKey + conservative handling of operator's
  // explicit `enabled` setting.
  //
  // visitorAuth is the sole authority for signingKey: it mints tokens so it
  // MUST own the key. webTransport only verifies them; receiving the key via
  // injection avoids operators having to duplicate the secret across two
  // config blocks (where a mismatch silently breaks the flow).
  //
  // Auto-defaulting rules:
  //  - When visitorAuth is absent: auto-disable ONLY when operator left enabled
  //    unset. Explicit enabled: true is respected (custom minter scenario).
  //  - When visitorAuth is present: inject signingKey + auto-enable ONLY when
  //    operator did not explicitly set enabled: false. Explicit false is
  //    respected (unusual but legal).
  //
  // Iterates ALL webTransport configs (not just the first) so a multi-
  // transport setup gets consistent injection (fixes Codex C-H2).
  {
    const vaConfig = configs.find((c) => c.type === "visitorAuth");
    const wtConfigs = configs.filter((c) => c.type === "webTransport");

    for (const wtConfig of wtConfigs) {
      const wtOpts = (wtConfig.options ?? {}) as Record<string, unknown>;
      const vt = (wtOpts.visitorTokens ?? {}) as Record<string, unknown>;

      // Track whether operator explicitly set `enabled` (truthy or false) vs left it undefined.
      const enabledExplicit = "enabled" in vt;

      if (!vaConfig) {
        // No visitorAuth mounted.
        // If signingKey is set, warn about potential identity loss (operator
        // may have removed visitorAuth between boots, stranding issued tokens).
        if (vt.signingKey !== undefined) {
          console.warn(
            `[augment-resolver] webTransport.visitorTokens.signingKey is set but no visitorAuth augment is mounted. Pre-existing visitor tokens may not be verified (no minter is registered). If you previously had visitorAuth mounted and removed it, all verified visitors will revert to anonymous on next request.`,
          );
        }

        if (!enabledExplicit) {
          // Operator left enabled unset → auto-disable (no minter mounted).
          vt.enabled = false;
          wtOpts.visitorTokens = vt;
          wtConfig.options = wtOpts;
        } else if (vt.enabled === true) {
          // Operator explicitly opted in without visitorAuth. Warn — likely a
          // misconfig that previously silently worked via ephemeral fallback.
          console.warn(
            `[augment-resolver] webTransport.visitorTokens.enabled is true but no visitorAuth augment is mounted. Tokens will not be minted by visitorAuth; if you have a custom token-minter, set visitorTokens.signingKey explicitly. Otherwise, set enabled: false or mount visitorAuth.`,
          );
        }
        // else: enabled: false explicitly set — nothing to do.
        continue;
      }

      // visitorAuth IS mounted.
      const vaSigningKey = (vaConfig.options as Record<string, unknown> | undefined)?.signingKey as
        | string
        | undefined;

      if (vt.enabled === false) {
        // Operator explicitly disabled visitor tokens despite mounting visitorAuth.
        // Respect — visitorAuth's request_auth tool still works, but webTransport
        // won't honor any minted token. Unusual but legal.
        console.warn(
          `[augment-resolver] visitorAuth is mounted but webTransport.visitorTokens.enabled is explicitly false. Verified visitors will not be recognized at the wire. Remove the explicit false to enable visitor recognition.`,
        );
        continue;
      }

      // Normal path: visitorAuth mounted, enabled is true (or undefined → default to true).
      if (vt.signingKey !== undefined && vt.signingKey !== vaSigningKey) {
        console.warn(
          "[augment-resolver] webTransport.visitorTokens.signingKey is set but visitorAuth.signingKey takes precedence. Remove the duplicate from webTransport's config.",
        );
      }
      // Inject visitorAuth's signingKey and enable visitor tokens.
      vt.signingKey = vaSigningKey;
      vt.enabled = true;
      wtOpts.visitorTokens = vt;
      wtConfig.options = wtOpts;
    }
  }

  for (const config of configs) {
    const opts = config.options ?? {};
    let augment: Augment;

    switch (config.type) {
      case "fileMemory":
        augment = resolveFileMemory(opts, agentDir);
        break;
      case "supabaseMemory":
        augment = await resolveSupabaseMemory(opts);
        break;
      case "layeredMemory":
        augment = await resolveLayeredMemory(opts, agentDir);
        break;
      case "filesystem":
        augment = resolveFilesystem(opts, agentDir);
        break;
      case "webTransport":
        augment = resolveWebTransport(opts, agentDir, resolverOpts.creator, lateBindings);
        break;
      case "webFetch":
        augment = resolveWebFetch(opts);
        break;
      case "knowledge":
        augment = knowledgeRoot({
          root: resolvePath((opts.root as string | undefined) ?? "./knowledge", agentDir),
          cacheTtlMs: opts.cacheTtlMs as number | undefined,
        });
        break;
      case "skills":
        augment = resolveSkills(opts, agentDir);
        break;
      case "bash":
        augment = resolveBash(opts, agentDir);
        break;
      case "budgets": {
        const { budgets } = await import("../augments/budgets");
        const dbPath = (opts.dbPath as string | undefined) ?? "./budgets.db";
        const notifications = opts.notifications as BudgetsAugmentOptions["notifications"];
        if (notifications && notifications.enabled !== false) {
          if (!notifyDestinationNames.has(notifications.destination)) {
            throw new Error(
              `[augment-resolver] budgets.notifications.destination "${notifications.destination}" does not match any notify destination. Mount notify and add a destination with that name, or disable budgets.notifications.`,
            );
          }
        }
        augment = budgets({
          dbPath: resolvePath(dbPath, agentDir),
          agentDir,
          caps: opts.caps as BudgetsAugmentOptions["caps"],
          anonymousGlobalLimit: opts.anonymousGlobalLimit as number | undefined,
          dailyBudgetUsd: opts.dailyBudgetUsd as number | undefined,
          cleanupWindowMs: opts.cleanupWindowMs as number | undefined,
          retentionDays: opts.retentionDays as number | undefined,
          notifications,
          notificationDispatcher:
            notifications && notifications.enabled !== false
              ? dispatchBudgetNotification
              : undefined,
        });
        break;
      }
      case "notify": {
        augment = notify({
          destinations: opts.destinations as NotifyAugmentOptions["destinations"],
          rateLimit: opts.rateLimit as NotifyAugmentOptions["rateLimit"],
        });
        break;
      }
      case "mcp":
        augment = mcp({
          agentDir,
          config: opts.config as string | undefined,
          timeoutMs: opts.timeoutMs as number | undefined,
          maxResultBytes: opts.maxResultBytes as number | undefined,
          maxSchemaBytes: opts.maxSchemaBytes as number | undefined,
          maxConcurrentCalls: opts.maxConcurrentCalls as number | undefined,
        });
        break;
      case "agentMail": {
        augment = agentMail({
          apiKey: opts.apiKey as string,
          inboxId: opts.inboxId as string,
          apiBaseUrl: opts.apiBaseUrl as string | undefined,
          dbPath: opts.dbPath as string | undefined,
          outbound: opts.outbound as AgentMailAugmentOptions["outbound"],
          inbound: opts.inbound as AgentMailAugmentOptions["inbound"],
          agentDir,
        });
        break;
      }
      case "telegramTransport":
        augment = telegramTransport({
          ...(opts as unknown as TelegramTransportOptions),
          creator: resolverOpts.creator,
        });
        break;
      case "turnControl":
        augment = turnControl(opts as TurnControlOptions);
        break;
      case "visitorAuth":
        augment = resolveVisitorAuth(opts, agentDir);
        break;
      case "link":
        augment = await resolveLink(opts, agentDir);
        break;
      case "custom":
        augment = await resolveCustom(config, agentDir);
        break;
      default:
        throw new Error(`Unknown augment type: "${config.type}"`);
    }

    // Override the auto-generated augment name with the operator's choice.
    augment = { ...augment, name: config.name };
    if (config.type === "notify") {
      const notifyTool = augment.tools?.find((tool) => tool.name === "notify");
      if (notifyTool) {
        const destinations =
          (config.options?.destinations as Array<Record<string, unknown>> | undefined) ?? [];
        for (const destination of destinations) {
          if (typeof destination.name === "string") {
            notifyExecutorsByDestination.set(destination.name, notifyTool.execute);
          }
        }
      }
    }
    augments.push(augment);
  }

  // Fix C1: wire the visitorAuth revocation check into webTransport's
  // deferred closure. The closure was passed to webTransport during the loop
  // (before visitorAuth was necessarily resolved); populating lateBindings
  // now makes the check active for all subsequent requests.
  //
  // Use index-based lookup (configs[i] → augments[i]) instead of name-based
  // search so that operator-renamed visitorAuth augments (e.g. `name: my-auth`
  // in agent.yaml) still get wired correctly. The `.name` property is
  // overwritten with the config name at line 396 after each factory returns,
  // so `augments.find(a => a.name === "visitor-auth")` would fail for any
  // non-default name and silently disable revocation.
  const vaIdx = configs.findIndex((c) => c.type === "visitorAuth");
  const va = vaIdx >= 0 ? (augments[vaIdx] as Augment & VisitorAuthAugmentExtras) : undefined;
  if (va?.isVisitorRevoked) {
    lateBindings.revocationCheck = va.isVisitorRevoked.bind(va);
  }
  if (va?.resolveVisitorIdentity) {
    lateBindings.identityLookup = va.resolveVisitorIdentity.bind(va);
  }

  // Fix F18: throw when multiple visitorAuth augments are declared.
  // Both would attempt to register GET/POST /visitor-auth/verify routes
  // (the route-collector hard-fails on duplicate registration anyway), and
  // only the first's revocation state would be visible to webTransport.
  // A hard error here is more honest than a warning for a state that's
  // unreachable at runtime.
  const vaCount = configs.filter((c) => c.type === "visitorAuth").length;
  if (vaCount > 1) {
    throw new Error(
      `[augment-resolver] Multiple visitorAuth augments declared (${vaCount}). visitorAuth is supported as a single instance per agent — both would attempt to register GET/POST /visitor-auth/verify routes (rejected by route-collector) and only the first's revocation state would be visible to webTransport. Declare exactly one visitorAuth augment.`,
    );
  }

  // Fix H3: cross-augment validation — visitorAuth.agentBinding MUST match
  // webTransport.visitorTokens.agentBinding when both are configured. A mismatch
  // silently strands visitors: the magic-link flow succeeds, but the next request
  // rejects the minted token because the agentBinding field won't match.
  const vaConfig = configs.find((c) => c.type === "visitorAuth");
  const wtConfig = configs.find((c) => c.type === "webTransport");
  if (vaConfig && wtConfig) {
    const vaBinding = (vaConfig.options as Record<string, unknown> | undefined)?.agentBinding as
      | string
      | undefined;
    const wtBinding = (
      (wtConfig.options as Record<string, unknown> | undefined)?.visitorTokens as
        | Record<string, unknown>
        | undefined
    )?.agentBinding as string | undefined;
    if (vaBinding !== wtBinding) {
      throw new Error(
        `Cross-augment config mismatch: visitorAuth.agentBinding (${vaBinding ?? "unset"}) ` +
          `must match webTransport.visitorTokens.agentBinding (${wtBinding ?? "unset"}). ` +
          `Set them both to the same value (e.g., \${AUGGY_AGENT_ID}) in augments/visitorAuth/augment.yaml and augments/webTransport/augment.yaml.`,
      );
    }
  }

  // Boot-time validation: warn (not error) for any tool-providing augment
  // whose bundled skill is not mounted at <agent-dir>/skills/<folder>/SKILL.md.
  // Per ADR-025 Decision 5 + spec §H. Runs after every factory has produced
  // its tool surface so the discriminator (`tools.length > 0`) is final.
  // MUST run before the skills auto-synth below — the validator pairs
  // augments[i] with configs[i] and bails if lengths mismatch.
  validateBundledSkills(configs, augments, agentDir);

  // Auto-mount `skills` when the agent has a skills/ dir and hasn't declared
  // its own. The skills augment is auggy's model-facing skill surface (ADR-030)
  // — runtime infrastructure, not a feature operators opt into. Production
  // scaffolds always create `<agentDir>/skills/` (the bundled-skill copy step
  // populates it), so this synth fires for real agents. Test harnesses that
  // construct agent dirs without a skills/ subdir won't trigger the synth,
  // which keeps the resolver's length contract predictable for unit tests.
  // Existing scaffolds with an explicit `skills` declaration still work — we
  // don't double-mount.
  const skillsDir = resolvePath("./skills", agentDir);
  const hasSkills = augments.some((a) => a.name === "skills");
  if (!hasSkills && existsSync(skillsDir)) {
    augments.push(skills({ dir: skillsDir }));
  }

  if (resolverOpts.selfInspection) {
    augments.push(
      auggySelf({
        agentDir,
        agent: resolverOpts.selfInspection,
        configs,
        augments,
      }),
    );
  }

  return augments;
}
