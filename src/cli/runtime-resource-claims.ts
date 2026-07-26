import { createHash } from "node:crypto";
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
 * Return non-secret host-local resources that exactly one logical agent may
 * own. Duplicate declarations inside one config are rejected before boot.
 */
export function runtimeResourceClaims(config: ParsedConfig): string[] {
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
  for (const augment of config.augments) {
    const opts = augment.options ?? {};
    if (augment.type === "webTransport") {
      const port = opts.port;
      if (typeof port === "number") add(`tcp-port:${port}`, augment.name);
    } else if (augment.type === "link") {
      const port = (opts.port as number | undefined) ?? 8081;
      add(`tcp-port:${port}`, augment.name);
    } else if (augment.type === "telegramTransport") {
      const token = opts.botToken;
      if (typeof token === "string") add(telegramIdentity(token), augment.name);
      const inbound = opts.inbound as Record<string, unknown> | undefined;
      if (inbound?.mode === "webhook") {
        const webhook = inbound.webhook as Record<string, unknown> | undefined;
        add(`tcp-port:${String(webhook?.port ?? 8081)}`, augment.name);
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
