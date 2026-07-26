import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { assertImmutableAgentId } from "./agent-isolation";
import type { ParsedConfig } from "./types";

function telegramIdentity(botToken: string): string {
  const numericId = botToken.match(/^(\d+):/)?.[1];
  if (numericId) return `telegram-bot:${numericId}`;
  const fingerprint = createHash("sha256")
    .update("auggy-telegram-bot-token\0")
    .update(botToken)
    .digest("hex");
  return `telegram-token-sha256:${fingerprint}`;
}

/**
 * Return non-secret CLI-user-local resources that exactly one logical agent
 * may own. Duplicate declarations inside one config are rejected before boot.
 */
export function runtimeResourceClaims(config: ParsedConfig, agentDir: string): string[] {
  assertImmutableAgentId(config.id);
  const owners = new Map<string, string>();

  const add = (claim: string, owner: string) => {
    const existing = owners.get(claim);
    if (existing) {
      throw new Error(
        `[runtime-resource] ${claim} is configured by both "${existing}" and "${owner}"`,
      );
    }
    owners.set(claim, owner);
  };

  add(`agent-id:${config.id}`, "agent identity");
  add(agentStateRootClaim(agentDir), "agent state directory");
  for (const augment of config.augments) {
    const opts = augment.options ?? {};
    if (augment.type === "webTransport") {
      const port = opts.port;
      if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
        throw new Error(
          `[runtime-resource] webTransport "${augment.name}" requires an integer port from 1 to 65535`,
        );
      }
      add(`tcp-port:${String(port)}`, augment.name);
    } else if (augment.type === "link") {
      const port = (opts.port as number | undefined) ?? 8081;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(
          `[runtime-resource] link "${augment.name}" requires an integer port from 1 to 65535`,
        );
      }
      add(`tcp-port:${port}`, augment.name);
    } else if (augment.type === "telegramTransport") {
      const token = opts.botToken;
      if (typeof token === "string") add(telegramIdentity(token), augment.name);
      const inbound = opts.inbound as Record<string, unknown> | undefined;
      if (inbound?.mode === "webhook") {
        const webhook = inbound.webhook as Record<string, unknown> | undefined;
        const port = (webhook?.port as number | undefined) ?? 8081;
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
          throw new Error(
            `[runtime-resource] telegramTransport "${augment.name}" webhook requires an integer port from 1 to 65535`,
          );
        }
        add(`tcp-port:${port}`, augment.name);
      }
    } else if (augment.type === "agentMail") {
      const inbound = opts.inbound as Record<string, unknown> | undefined;
      if ((inbound?.mode ?? "none") !== "none" && typeof opts.inboxId === "string") {
        add(`agentmail-inbox:${opts.inboxId}`, augment.name);
      }
    }
  }

  return [...owners.keys()].sort();
}

/** Stable, non-secret lease key for one canonical local state directory. */
export function agentStateRootClaim(agentDir: string): string {
  const canonicalAgentDir = realpathSync.native(agentDir);
  const stateRoot = statSync(canonicalAgentDir);
  if (!stateRoot.isDirectory()) {
    throw new Error("[runtime-resource] agent state root must be a directory");
  }
  const rootFingerprint = createHash("sha256")
    .update("auggy-agent-state-root\0")
    .update(String(stateRoot.dev))
    .update(":")
    .update(String(stateRoot.ino))
    .digest("hex");
  return `agent-state-root-sha256:${rootFingerprint}`;
}
