/**
 * Svix-verified AgentMail webhook admission.
 *
 * Signature verification is owned by the HTTP transport policy. This adapter
 * receives only the parsed, verified event context, validates the AgentMail
 * envelope against the configured inbox, and durably enqueues it before
 * acknowledging delivery.
 */

import { defineRoute, json, webhook } from "../../helpers";
import type { AugmentHttpRoute } from "../../types";
import { AgentMailLedgerConflictError, type AgentMailInboundLedger } from "./inbound-ledger";
import {
  AGENTMAIL_RECEIVED_EVENT_TYPES,
  AgentMailPayloadError,
  normalizeAgentMailReceivedEvent,
} from "./provider";

const DEFAULT_PATH = "/webhooks/agentmail";
const DEFAULT_SECRET_ENV = "AGENTMAIL_WEBHOOK_SECRET";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface AgentMailWebhookRouteOptions {
  inboxId: string;
  ledger: AgentMailInboundLedger;
  path?: string;
  secretEnv?: string;
  timestampToleranceSeconds?: number;
  maxBodyBytes?: number;
}

export function createAgentMailWebhookRoute(
  options: AgentMailWebhookRouteOptions,
): AugmentHttpRoute {
  const inboxId = requireNonEmpty(options.inboxId, "inboxId");
  const secretEnv = requireNonEmpty(options.secretEnv ?? DEFAULT_SECRET_ENV, "secretEnv");
  const path = options.path ?? DEFAULT_PATH;

  return defineRoute.post(path, {
    auth: "none",
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    policy: webhook.signature("svix", {
      secretEnv,
      ...(options.timestampToleranceSeconds !== undefined
        ? { timestampToleranceSeconds: options.timestampToleranceSeconds }
        : {}),
    }),
    handler: ({ webhook: verified }) => {
      if (verified?.provider !== "svix") {
        return json({ error: "webhook-verification-required" }, 500);
      }

      const eventType = eventTypeOf(verified.event);
      if (eventType === undefined) {
        return json({ error: "webhook-payload-invalid" }, 400);
      }
      if (!AGENTMAIL_RECEIVED_EVENT_TYPES.some((receivedType) => receivedType === eventType)) {
        // Authenticated non-received events are intentionally outside this
        // receiver. Acknowledge them so a broad provider subscription cannot
        // create an unbounded retry loop.
        return new Response(null, { status: 204 });
      }

      try {
        const envelope = normalizeAgentMailReceivedEvent(verified.event, "webhook", inboxId);
        const result = options.ledger.enqueue(envelope);
        return json({ accepted: true, duplicate: result.status === "duplicate" });
      } catch (error) {
        if (error instanceof AgentMailPayloadError) {
          return json({ error: "webhook-payload-invalid" }, 400);
        }
        if (error instanceof AgentMailLedgerConflictError) {
          return json({ error: "webhook-ledger-conflict" }, 409);
        }
        throw error;
      }
    },
  });
}

function eventTypeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const eventType = (value as { event_type?: unknown }).event_type;
  return typeof eventType === "string" && eventType.length > 0 ? eventType : undefined;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`agentMail webhook: ${field} must be a non-empty string`);
  }
  return value;
}
