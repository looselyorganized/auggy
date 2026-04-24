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

import { resolve } from "path";
import { fileMemory } from "../augments/file-memory";
import { supabaseMemory } from "../augments/supabase-memory";
import { filesystem } from "../augments/filesystem";
import { webTransport } from "../transports/web-transport";
import { webFetch } from "../augments/web-fetch";
import { orgContext } from "../augments/org-context";
import { bash } from "../augments/bash";
import type { Augment } from "../types";
import type { AugmentConfig } from "./types";

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

function resolveFileMemory(
  opts: Record<string, unknown>,
  agentDir: string,
): Augment {
  return fileMemory({
    label: opts.label as string,
    source: resolvePath(opts.source as string, agentDir),
    mutable: opts.mutable as boolean,
    origin: opts.origin as "operator" | "system" | "agent" | "peer-derived",
    priority: opts.priority as "required" | "high" | "normal" | "low" | "evictable",
    placement: opts.placement as "system" | "preamble" | "assistant-preamble",
    eviction: opts.eviction as "never" | "summarize" | "drop",
    ttl: opts.ttl as "turn" | "session" | "persistent" | undefined,
  });
}

async function resolveSupabaseMemory(
  opts: Record<string, unknown>,
): Promise<Augment> {
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
  const client = createClient(supabaseUrl, supabaseKey) as unknown as Parameters<typeof supabaseMemory>[0]["client"];

  return supabaseMemory({
    namespace: rest.namespace as string,
    client,
    table: rest.table as string,
    mutable: rest.mutable as boolean,
    origin: rest.origin as "operator" | "system" | "agent" | "peer-derived",
    priority: rest.priority as "required" | "high" | "normal" | "low" | "evictable",
    placement: rest.placement as "system" | "preamble" | "assistant-preamble",
    eviction: rest.eviction as "never" | "summarize" | "drop",
    searchLimit: rest.searchLimit as number | undefined,
  });
}

function resolveFilesystem(
  opts: Record<string, unknown>,
  agentDir: string,
): Augment {
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
    skillFile: opts.skillFile
      ? resolvePath(opts.skillFile as string, agentDir)
      : undefined,
  });
}

function resolveWebTransport(opts: Record<string, unknown>): Augment {
  return webTransport({
    port: opts.port as number,
    auth: opts.auth as { type: "bearer"; token: string },
    cors: opts.cors as { origins: string[] } | undefined,
    maxMessageLength: opts.maxMessageLength as number | undefined,
    trustLevel: opts.trustLevel as "operator" | "facility" | "authenticated" | "untrusted" | undefined,
    concurrency: opts.concurrency as number | undefined,
    maxQueueDepth: opts.maxQueueDepth as number | undefined,
    rateLimitPerPeer: opts.rateLimitPerPeer as { maxPerMinute: number } | undefined,
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

async function resolveCustom(
  config: AugmentConfig,
  agentDir: string,
): Promise<Augment> {
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

function resolveBash(
  opts: Record<string, unknown>,
  agentDir: string,
): Augment {
  const scripts = (opts.scripts as Array<Record<string, unknown>> | undefined)?.map(
    (s) => ({
      name: s.name as string,
      description: s.description as string,
      command: s.command as string,
      workingDir: s.workingDir
        ? resolvePath(s.workingDir as string, agentDir)
        : undefined,
      timeout: s.timeout as number | undefined,
    }),
  );

  return bash({
    risk: opts.risk as "scripts-only" | "restricted" | "standard" | "unrestricted" | undefined,
    allowedCommands: opts.allowedCommands as string[] | undefined,
    blockedCommands: opts.blockedCommands as string[] | undefined,
    workingDir: opts.workingDir
      ? resolvePath(opts.workingDir as string, agentDir)
      : undefined,
    inheritEnv: opts.inheritEnv as boolean | undefined,
    env: opts.env as Record<string, string> | undefined,
    timeout: opts.timeout as number | undefined,
    maxOutputBytes: opts.maxOutputBytes as number | undefined,
    maxToolCallsPerTurn: opts.maxToolCallsPerTurn as number | undefined,
    scripts,
  });
}

/**
 * Resolve an array of augment configs into concrete Augment objects.
 * Built-in types dispatch to their factory functions; custom types
 * use dynamic import of local .ts files.
 */
export async function resolveAugments(
  configs: AugmentConfig[],
  agentDir: string,
): Promise<Augment[]> {
  const augments: Augment[] = [];

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
      case "filesystem":
        augment = resolveFilesystem(opts, agentDir);
        break;
      case "webTransport":
        augment = resolveWebTransport(opts);
        break;
      case "webFetch":
        augment = resolveWebFetch(opts);
        break;
      case "orgContext":
        augment = orgContext({
          baseUrl: opts.baseUrl as string,
          token: opts.token as string | undefined,
          cacheTtlMs: opts.cacheTtlMs as number | undefined,
          escalation: opts.escalation as {
            enabled?: boolean;
            cooldownMs?: number;
            globalMaxPerHour?: number;
            dedupWindowMs?: number;
            dedupThreshold?: number;
          } | undefined,
        });
        break;
      case "bash":
        augment = resolveBash(opts, agentDir);
        break;
      case "custom":
        augment = await resolveCustom(config, agentDir);
        break;
      default:
        throw new Error(`Unknown augment type: "${config.type}"`);
    }

    // Override the auto-generated augment name with the operator's choice.
    augment = { ...augment, name: config.name };
    augments.push(augment);
  }

  return augments;
}
