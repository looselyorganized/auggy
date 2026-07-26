import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ParsedConfig } from "./types";
import { scopedAgentNamespace } from "./agent-isolation";

export const RUNTIME_STATE_INVENTORY_VERSION = 1;

export type RuntimeStateBackupPlane =
  | "runtime-volume"
  | "project-source"
  | "external"
  | "volatile"
  | "disabled";

export interface RuntimeStateStoreInventoryEntry {
  id: string;
  owner: string;
  namespace: string;
  kind: "sqlite" | "json" | "file" | "directory" | "external" | "memory";
  backupPlane: RuntimeStateBackupPlane;
  relativePath?: string;
  schema?: string;
  retention: string;
  restoreOrder: number;
  replayCritical: boolean;
  required: boolean;
}

export interface RuntimeStateExternalPrerequisite {
  id: string;
  owner: string;
  reason: string;
}

export interface RuntimeStateInventory {
  version: typeof RUNTIME_STATE_INVENTORY_VERSION;
  agent: { id: string; name: string };
  configShapeSha256: string;
  stores: RuntimeStateStoreInventoryEntry[];
  externalPrerequisites: RuntimeStateExternalPrerequisite[];
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

/**
 * Pure counterpart to the runtime resolver's durable-path mapping. It never
 * creates directories and is safe to use for inventory and preflight.
 */
export function resolveRuntimeStatePath(
  configuredPath: string,
  agentDir: string,
  runtimeDataRoot: string | undefined,
  label: string,
): string {
  const resolvedAgentPath = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(agentDir, configuredPath);
  if (!runtimeDataRoot) return resolvedAgentPath;

  const root = resolve(runtimeDataRoot);
  if (isAbsolute(configuredPath)) {
    if (!isContained(root, resolvedAgentPath)) {
      throw new Error(
        `[runtime-state] ${label} must stay within its state directory/runtime data root`,
      );
    }
    return resolvedAgentPath;
  }
  if (isContained(root, resolvedAgentPath)) return resolvedAgentPath;

  const target = resolve(root, configuredPath);
  if (!isContained(root, target)) {
    throw new Error(
      `[runtime-state] ${label} must stay within its state directory/runtime data root`,
    );
  }
  return target;
}

export function runtimeVolumeRelativePath(root: string, target: string, label: string): string {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (!isContained(normalizedRoot, normalizedTarget) || normalizedRoot === normalizedTarget) {
    throw new Error(`[runtime-state] ${label} must name a child of the runtime data root`);
  }
  return relative(normalizedRoot, normalizedTarget).split(sep).join("/");
}

export function mutableFileMemoryRuntimePath(runtimeDataRoot: string, augmentName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(augmentName)) {
    throw new Error(`[runtime-state] fileMemory name "${augmentName}" is not a safe namespace`);
  }
  return join(resolve(runtimeDataRoot), "file-memory", `${augmentName}.md`);
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("runtime state inventory shape contains an unsupported value");
}

function stateConfigShape(config: ParsedConfig): unknown {
  return {
    id: config.id,
    augments: config.augments.map((augment) => {
      const options = augment.options ?? {};
      const shape: Record<string, unknown> = { name: augment.name, type: augment.type };
      for (const key of [
        "backend",
        "dbPath",
        "layeredMemoryDbPath",
        "retentionDays",
        "scope",
        "table",
        "namespace",
      ]) {
        if (options[key] !== undefined) shape[key] = options[key];
      }
      if (augment.type === "fileMemory") {
        shape.mutable = options.mutable;
        shape.source = options.source;
      }
      if (augment.type === "filesystem") {
        shape.mounts = (options.mounts as Array<Record<string, unknown>> | undefined)?.map(
          (mount) => ({ name: mount.name, path: mount.path, writable: mount.writable }),
        );
      }
      if (augment.type === "webTransport") {
        const consoleChat = options.consoleChat as Record<string, unknown> | undefined;
        const idempotency = options.idempotency as Record<string, unknown> | undefined;
        shape.consoleChat = consoleChat ? { dbPath: consoleChat.dbPath } : undefined;
        shape.idempotency = idempotency ? { dbPath: idempotency.dbPath } : undefined;
      }
      if (augment.type === "notify") {
        shape.destinations = (options.destinations as Array<Record<string, unknown>> | undefined)
          ?.filter((destination) => destination.transport === "log-to-file")
          .map((destination) => ({ name: destination.name, path: destination.path }));
      }
      if (augment.type === "telegramTransport") {
        const replay = options.replay as Record<string, unknown> | undefined;
        shape.replay = replay
          ? {
              dbPath: replay.dbPath,
              retentionMs: replay.retentionMs,
              maxEntries: replay.maxEntries,
            }
          : undefined;
      }
      return shape;
    }),
    coordination: config.settings.coordination
      ? {
          mode: config.settings.coordination.mode,
          namespace: config.settings.coordination.namespace,
        }
      : undefined,
  };
}

function addStore(
  stores: RuntimeStateStoreInventoryEntry[],
  entry: RuntimeStateStoreInventoryEntry,
): void {
  if (stores.some((candidate) => candidate.id === entry.id)) {
    throw new Error(`[runtime-state] duplicate inventory id "${entry.id}"`);
  }
  if (
    entry.backupPlane === "runtime-volume" &&
    entry.relativePath &&
    stores.some(
      (candidate) =>
        candidate.backupPlane === "runtime-volume" &&
        candidate.relativePath === entry.relativePath &&
        candidate.id !== entry.id,
    )
  ) {
    throw new Error(
      `[runtime-state] runtime volume path "${entry.relativePath}" has multiple owners`,
    );
  }
  stores.push(entry);
}

function sqliteEntry(input: {
  id: string;
  owner: string;
  namespace: string;
  path: string | null;
  runtimeDataRoot?: string;
  schema: string;
  retention: string;
  restoreOrder: number;
  replayCritical: boolean;
  required?: boolean;
}): RuntimeStateStoreInventoryEntry {
  if (input.path === null || input.path === ":memory:") {
    return {
      id: input.id,
      owner: input.owner,
      namespace: input.namespace,
      kind: "memory",
      backupPlane: "disabled",
      schema: input.schema,
      retention: "process lifetime only; explicitly non-restorable",
      restoreOrder: input.restoreOrder,
      replayCritical: input.replayCritical,
      required: false,
    };
  }
  const relativePath = input.runtimeDataRoot
    ? runtimeVolumeRelativePath(input.runtimeDataRoot, input.path, input.id)
    : undefined;
  return {
    id: input.id,
    owner: input.owner,
    namespace: input.namespace,
    kind: "sqlite",
    backupPlane: relativePath ? "runtime-volume" : "project-source",
    ...(relativePath ? { relativePath } : {}),
    schema: input.schema,
    retention: input.retention,
    restoreOrder: input.restoreOrder,
    replayCritical: input.replayCritical,
    required: input.required ?? true,
  };
}

export function buildRuntimeStateInventory(
  config: ParsedConfig,
  options: { agentDir: string; runtimeDataRoot?: string },
): RuntimeStateInventory {
  const agentDir = resolve(options.agentDir);
  const runtimeDataRoot = options.runtimeDataRoot ? resolve(options.runtimeDataRoot) : undefined;
  const ownedStateRoot = runtimeDataRoot ?? agentDir;
  const stores: RuntimeStateStoreInventoryEntry[] = [];
  const externalPrerequisites: RuntimeStateExternalPrerequisite[] = [];
  const namespace = config.id;

  addStore(stores, {
    id: "runtime-identity",
    owner: "runtime",
    namespace,
    kind: "json",
    backupPlane: runtimeDataRoot ? "runtime-volume" : "disabled",
    ...(runtimeDataRoot ? { relativePath: ".auggy-state-identity.json" } : {}),
    schema: "runtime-state-identity/v1",
    retention: "lifetime of the logical agent volume",
    restoreOrder: 0,
    replayCritical: true,
    required: Boolean(runtimeDataRoot),
  });

  addStore(stores, {
    id: "admin-overrides",
    owner: "runtime",
    namespace,
    kind: "json",
    backupPlane: runtimeDataRoot ? "runtime-volume" : "project-source",
    ...(runtimeDataRoot ? { relativePath: "admin-overrides.json" } : {}),
    schema: "admin-overrides/v1",
    retention: "until replaced by an authenticated operator action",
    restoreOrder: 10,
    replayCritical: true,
    required: false,
  });

  for (const augment of config.augments) {
    const opts = augment.options ?? {};
    const owner = `augment:${augment.name}`;
    switch (augment.type) {
      case "fileMemory": {
        if (opts.mutable !== true) break;
        const source = runtimeDataRoot
          ? mutableFileMemoryRuntimePath(runtimeDataRoot, augment.name)
          : resolveRuntimeStatePath(
              String(opts.source),
              agentDir,
              ownedStateRoot,
              `fileMemory ${augment.name} source`,
            );
        addStore(stores, {
          id: `file-memory:${augment.name}`,
          owner,
          namespace,
          kind: "file",
          backupPlane: runtimeDataRoot ? "runtime-volume" : "project-source",
          ...(runtimeDataRoot
            ? {
                relativePath: runtimeVolumeRelativePath(
                  runtimeDataRoot,
                  source,
                  `file-memory:${augment.name}`,
                ),
              }
            : {}),
          schema: "utf8-text/v1",
          retention: "until creator-authorized replacement",
          restoreOrder: 20,
          replayCritical: false,
          required: true,
        });
        break;
      }
      case "filesystem": {
        const mounts = (opts.mounts as Array<Record<string, unknown>> | undefined) ?? [];
        for (const mount of mounts) {
          if (mount.writable !== true || typeof mount.path !== "string") continue;
          const path = resolve(agentDir, mount.path);
          const inVolume = runtimeDataRoot ? isContained(runtimeDataRoot, path) : false;
          addStore(stores, {
            id: `filesystem:${augment.name}:${String(mount.name)}`,
            owner,
            namespace,
            kind: "directory",
            backupPlane: inVolume ? "runtime-volume" : "project-source",
            ...(inVolume && runtimeDataRoot
              ? {
                  relativePath: runtimeVolumeRelativePath(
                    runtimeDataRoot,
                    path,
                    `filesystem:${augment.name}`,
                  ),
                }
              : {}),
            schema: "opaque-files/v1",
            retention: "operator/application managed",
            restoreOrder: 70,
            replayCritical: false,
            required: true,
          });
        }
        break;
      }
      case "layeredMemory": {
        if ((opts.backend ?? "sqlite") === "supabase") {
          externalPrerequisites.push({
            id: `layered-memory:${augment.name}`,
            owner,
            reason: "Supabase state requires a provider-owned recovery point",
          });
          addStore(stores, {
            id: `layered-memory:${augment.name}`,
            owner,
            namespace: scopedAgentNamespace(config.id, opts.namespace as string | undefined, "ep"),
            kind: "external",
            backupPlane: "external",
            schema: "operator-managed Supabase table",
            retention: `${String(opts.retentionDays ?? 30)} days by runtime cleanup policy`,
            restoreOrder: 30,
            replayCritical: false,
            required: true,
          });
          break;
        }
        const path = resolveRuntimeStatePath(
          String(opts.dbPath ?? "./memory.db"),
          agentDir,
          ownedStateRoot,
          "layeredMemory dbPath",
        );
        addStore(
          stores,
          sqliteEntry({
            id: `layered-memory:${augment.name}`,
            owner,
            namespace: scopedAgentNamespace(config.id, opts.namespace as string | undefined, "ep"),
            path,
            runtimeDataRoot,
            schema: "LMEM/v1",
            retention: `${String(opts.retentionDays ?? 30)} days by runtime cleanup policy`,
            restoreOrder: 30,
            replayCritical: false,
          }),
        );
        if (opts.autoSave !== undefined) {
          addStore(stores, {
            id: `layered-memory-extraction-buffer:${augment.name}`,
            owner,
            namespace: scopedAgentNamespace(config.id, opts.namespace as string | undefined, "ep"),
            kind: "memory",
            backupPlane: "volatile",
            schema: "process-local/v1",
            retention: "bounded per peer/thread and discarded on restart",
            restoreOrder: 100,
            replayCritical: false,
            required: false,
          });
        }
        break;
      }
      case "supabaseMemory":
        externalPrerequisites.push({
          id: `supabase-memory:${augment.name}`,
          owner,
          reason: "Supabase state requires a provider-owned recovery point",
        });
        addStore(stores, {
          id: `supabase-memory:${augment.name}`,
          owner,
          namespace: scopedAgentNamespace(
            config.id,
            opts.namespace as string | undefined,
            "memory",
          ),
          kind: "external",
          backupPlane: "external",
          schema: "operator-managed Supabase table",
          retention: "operator-managed",
          restoreOrder: 30,
          replayCritical: false,
          required: true,
        });
        break;
      case "budgets": {
        const path = resolveRuntimeStatePath(
          String(opts.dbPath ?? "./budgets.db"),
          agentDir,
          ownedStateRoot,
          "budgets dbPath",
        );
        addStore(
          stores,
          sqliteEntry({
            id: `budgets:${augment.name}`,
            owner,
            namespace,
            path,
            runtimeDataRoot,
            schema: "BUDG/v1",
            retention: opts.retentionDays
              ? `${String(opts.retentionDays)} days by runtime cleanup policy`
              : "unbounded until operator configures retentionDays",
            restoreOrder: 40,
            replayCritical: true,
          }),
        );
        break;
      }
      case "visitorAuth": {
        const path = resolveRuntimeStatePath(
          String(opts.dbPath ?? "./visitor-auth.db"),
          agentDir,
          ownedStateRoot,
          "visitorAuth dbPath",
        );
        addStore(
          stores,
          sqliteEntry({
            id: `visitor-auth:${augment.name}`,
            owner,
            namespace,
            path,
            runtimeDataRoot,
            schema: "VAUT/v1",
            retention: "identities and revocations retained until explicit deletion",
            restoreOrder: 20,
            replayCritical: true,
          }),
        );
        addStore(stores, {
          id: `visitor-auth-rate-limit:${augment.name}`,
          owner,
          namespace,
          kind: "memory",
          backupPlane: "volatile",
          schema: "process-local/v1",
          retention: "bounded request window; resets on restart",
          restoreOrder: 100,
          replayCritical: false,
          required: false,
        });
        break;
      }
      case "webTransport": {
        const idempotency = opts.idempotency as { dbPath?: string | null } | undefined;
        const idempotencyRaw = idempotency?.dbPath ?? "./data/web-idempotency.db";
        const idempotencyPath =
          idempotency?.dbPath === null
            ? null
            : resolveRuntimeStatePath(
                idempotencyRaw,
                agentDir,
                ownedStateRoot,
                "webTransport idempotency.dbPath",
              );
        addStore(
          stores,
          sqliteEntry({
            id: `web-idempotency:${augment.name}`,
            owner,
            namespace,
            path: idempotencyPath,
            runtimeDataRoot,
            schema: "AUID/v2",
            retention: "configured replay window; terminal unknown records fail closed",
            restoreOrder: 50,
            replayCritical: true,
          }),
        );
        addStore(stores, {
          id: `web-idempotency-waiters:${augment.name}`,
          owner,
          namespace,
          kind: "memory",
          backupPlane: "volatile",
          schema: "process-local/v1",
          retention: "bounded in-flight waiters; terminal state is persisted separately",
          restoreOrder: 100,
          replayCritical: false,
          required: false,
        });

        const consoleChat = opts.consoleChat as { dbPath?: string | null } | undefined;
        if (!(consoleChat === undefined && opts.adminRoute === false)) {
          const consolePath =
            consoleChat?.dbPath === null
              ? null
              : resolveRuntimeStatePath(
                  consoleChat?.dbPath ?? "./data/console-chat.db",
                  agentDir,
                  ownedStateRoot,
                  "webTransport consoleChat.dbPath",
                );
          addStore(
            stores,
            sqliteEntry({
              id: `console-chat:${augment.name}`,
              owner,
              namespace,
              path: consolePath,
              runtimeDataRoot,
              schema: "CCHT/v4",
              retention: "until authenticated deletion; tombstones remain replay-critical",
              restoreOrder: 60,
              replayCritical: true,
            }),
          );
        }
        break;
      }
      case "telegramTransport": {
        const replay = (opts.replay as { dbPath?: string; retentionMs?: number } | undefined) ?? {};
        const path = resolveRuntimeStatePath(
          replay.dbPath ?? "./data/telegram-replay.db",
          agentDir,
          ownedStateRoot,
          `telegramTransport ${augment.name} replay.dbPath`,
        );
        addStore(
          stores,
          sqliteEntry({
            id: `telegram-replay:${augment.name}`,
            owner,
            namespace: scopedAgentNamespace(
              config.id,
              (replay as { namespace?: string }).namespace,
              augment.name,
            ),
            path,
            runtimeDataRoot,
            schema: "TGRP/v2",
            retention: `${String(replay.retentionMs ?? 30 * 24 * 60 * 60 * 1000)}ms and maxEntries`,
            restoreOrder: 50,
            replayCritical: true,
          }),
        );
        break;
      }
      case "agentMail": {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(augment.name)) {
          throw new Error(
            `[runtime-state] agentMail name "${augment.name}" is not a safe namespace`,
          );
        }
        const stateDir = runtimeDataRoot
          ? join(runtimeDataRoot, "agent-mail", augment.name)
          : agentDir;
        const path = runtimeDataRoot
          ? resolveRuntimeStatePath(
              String(opts.dbPath ?? "./agent-mail.db"),
              stateDir,
              stateDir,
              `agentMail ${augment.name} dbPath`,
            )
          : resolveRuntimeStatePath(
              String(opts.dbPath ?? "./agent-mail.db"),
              agentDir,
              ownedStateRoot,
              `agentMail ${augment.name} dbPath`,
            );
        addStore(
          stores,
          sqliteEntry({
            id: `agentmail-ledger:${augment.name}`,
            owner,
            namespace,
            path,
            runtimeDataRoot,
            schema: "AMIL/v2",
            retention: "terminal inbound work retained according to ledger policy",
            restoreOrder: 50,
            replayCritical: true,
            required:
              ((opts.inbound as Record<string, unknown> | undefined)?.mode ?? "none") !== "none",
          }),
        );
        for (const [filename, schema] of [
          ["agent-mail-state.json", "agent-mail-rate/v2"],
          ["agent-mail-reviews.json", "agent-mail-reviews/v1"],
        ] as const) {
          addStore(stores, {
            id: `${schema}:${augment.name}`,
            owner,
            namespace,
            kind: "json",
            backupPlane: runtimeDataRoot ? "runtime-volume" : "project-source",
            ...(runtimeDataRoot
              ? {
                  relativePath: runtimeVolumeRelativePath(
                    runtimeDataRoot,
                    join(stateDir, filename),
                    `${schema}:${augment.name}`,
                  ),
                }
              : {}),
            schema,
            retention: "bounded runtime policy; ambiguous attempts retained for reconciliation",
            restoreOrder: 50,
            replayCritical: true,
            required: false,
          });
        }
        externalPrerequisites.push({
          id: `agentmail-provider:${augment.name}`,
          owner,
          reason: "the provider mailbox and already-sent messages are outside the runtime volume",
        });
        break;
      }
      case "link": {
        const path = resolveRuntimeStatePath(
          String(opts.dbPath ?? "./link.db"),
          agentDir,
          ownedStateRoot,
          "link dbPath",
        );
        addStore(
          stores,
          sqliteEntry({
            id: `link-task-store:${augment.name}`,
            owner,
            namespace,
            path,
            runtimeDataRoot,
            schema: "@auggy/link package-owned",
            retention: "package-owned",
            restoreOrder: 50,
            replayCritical: true,
          }),
        );
        break;
      }
      case "notify": {
        const destinations =
          (opts.destinations as Array<Record<string, unknown>> | undefined) ?? [];
        const deliveryPath = resolveRuntimeStatePath(
          (opts.dbPath as string | undefined) ??
            (runtimeDataRoot ? `notify-${augment.name}.db` : `./data/notify-${augment.name}.db`),
          agentDir,
          ownedStateRoot,
          `notify ${augment.name} dbPath`,
        );
        addStore(
          stores,
          sqliteEntry({
            id: `notify-delivery:${augment.name}`,
            owner,
            namespace,
            path: deliveryPath,
            runtimeDataRoot,
            schema: "NTFY/v1",
            retention:
              "up to 30 days and 10000 terminal attempts; unresolved outcome-unknown incidents require operator recovery",
            restoreOrder: 50,
            replayCritical: true,
            required: true,
          }),
        );
        for (const destination of destinations) {
          if (destination.transport !== "log-to-file" || typeof destination.path !== "string") {
            continue;
          }
          const path = resolveRuntimeStatePath(
            destination.path,
            agentDir,
            ownedStateRoot,
            `notify ${String(destination.name)} path`,
          );
          addStore(stores, {
            id: `notify-log:${augment.name}:${String(destination.name)}`,
            owner,
            namespace,
            kind: "file",
            backupPlane: runtimeDataRoot ? "runtime-volume" : "project-source",
            ...(runtimeDataRoot
              ? {
                  relativePath: runtimeVolumeRelativePath(
                    runtimeDataRoot,
                    path,
                    `notify-log:${augment.name}`,
                  ),
                }
              : {}),
            schema: "jsonl/v1",
            retention: "unbounded append-only operator log",
            restoreOrder: 70,
            replayCritical: false,
            required: false,
          });
        }
        break;
      }
      case "custom":
        externalPrerequisites.push({
          id: `custom-augment:${augment.name}`,
          owner,
          reason: "custom augment persistence has no declarative recovery contract",
        });
        break;
      case "webFetch":
      case "knowledge":
      case "skills":
      case "bash":
      case "mcp":
      case "turnControl":
        // No built-in durable mutable store. Operator-owned project files and
        // external server state remain in their respective recovery planes.
        break;
      default: {
        const unhandled: never = augment.type;
        throw new Error(`[runtime-state] unhandled augment type ${String(unhandled)}`);
      }
    }
  }

  if (config.settings.coordination) {
    externalPrerequisites.push({
      id: "postgres-coordination",
      owner: "runtime coordination preview",
      reason: "PostgreSQL coordination state requires a matching database recovery point",
    });
    addStore(stores, {
      id: "postgres-coordination",
      owner: "runtime coordination preview",
      namespace: config.settings.coordination.namespace,
      kind: "external",
      backupPlane: "external",
      schema: "postgres coordination migration ledger",
      retention: "operator-managed",
      restoreOrder: 10,
      replayCritical: true,
      required: true,
    });
  }

  for (const entry of [
    {
      id: "kernel-scheduler",
      owner: "kernel",
      retention: "process lifetime; queued work is not restored",
      replayCritical: true,
    },
    {
      id: "runtime-signals",
      owner: "kernel",
      retention: "process lifetime; counters reset on each start attempt",
      replayCritical: false,
    },
  ]) {
    addStore(stores, {
      ...entry,
      namespace,
      kind: "memory",
      backupPlane: "volatile",
      schema: "process-local/v1",
      restoreOrder: 100,
      required: false,
    });
  }

  stores.sort((a, b) => a.restoreOrder - b.restoreOrder || a.id.localeCompare(b.id));
  externalPrerequisites.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: RUNTIME_STATE_INVENTORY_VERSION,
    agent: { id: config.id, name: config.name },
    configShapeSha256: createHash("sha256")
      .update("auggy-runtime-state-config-shape-v1\0")
      .update(stableJson(stateConfigShape(config)))
      .digest("hex"),
    stores,
    externalPrerequisites,
  };
}
