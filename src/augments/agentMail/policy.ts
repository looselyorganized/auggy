import { createHash } from "node:crypto";
import type { PeerIdentity, TrustLevel } from "../../types";
import { canonicalizeEmail, isWellFormedEmail } from "../visitorAuth/email-validation";
import type { ValidatedAgentMailConfig } from "./config";
import type { AgentMailMessageClassification } from "./provider";

export type AgentMailAdmissionDecision =
  | {
      admitted: true;
      sender: string;
      peer: PeerIdentity;
      replyDisposition: "none" | "review";
    }
  | {
      admitted: false;
      reason: "malformed_sender" | "classification_blocked" | "sender_not_allowed";
    };

export type AgentMailOutboundPolicyDecision =
  | { allowed: true; recipients: string[]; subject: string }
  | {
      allowed: false;
      reason:
        | "trust_not_allowed"
        | "recipient_malformed"
        | "recipient_not_allowed"
        | "recipient_limit_exceeded"
        | "subject_invalid"
        | "body_limit_exceeded";
    };

function matchesPattern(address: string, pattern: string): boolean {
  if (!pattern.startsWith("*@")) return address === pattern;
  return address.endsWith(pattern.slice(1));
}

function senderPeer(address: string): PeerIdentity {
  const digest = createHash("sha256").update(address).digest("hex");
  return {
    id: `mail_${digest.slice(0, 32)}`,
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "agentMail",
  };
}

/**
 * Admit one provider message without confusing a From address with Auggy
 * identity. Even an allowed sender remains a public, untrusted peer.
 */
export function evaluateAgentMailInbound(
  input: { sender: string; classification: AgentMailMessageClassification },
  config: ValidatedAgentMailConfig,
): AgentMailAdmissionDecision {
  const sender = canonicalizeEmail(input.sender);
  if (!isWellFormedEmail(sender)) return { admitted: false, reason: "malformed_sender" };
  if (input.classification !== "received") {
    return { admitted: false, reason: "classification_blocked" };
  }
  const senderAllowed =
    config.inbound.senderPolicy === "any" ||
    config.inbound.allowedSenders.some((pattern) => matchesPattern(sender, pattern));
  if (config.inbound.mode === "none" || !senderAllowed) {
    return { admitted: false, reason: "sender_not_allowed" };
  }
  return {
    admitted: true,
    sender,
    peer: senderPeer(sender),
    replyDisposition: config.replies.mode === "review" ? "review" : "none",
  };
}

function trustAllowed(trustLevel: TrustLevel, allowed: readonly TrustLevel[]): boolean {
  return allowed.includes(trustLevel);
}

/** Validate and normalize a direct outbound request before provider access. */
export function evaluateAgentMailOutbound(
  input: { trustLevel: TrustLevel; recipients: readonly string[]; subject: string; text: string },
  config: ValidatedAgentMailConfig,
): AgentMailOutboundPolicyDecision {
  if (!trustAllowed(input.trustLevel, config.outbound.allowedTrustLevels)) {
    return { allowed: false, reason: "trust_not_allowed" };
  }
  if (input.recipients.length === 0 || input.recipients.length > config.outbound.maxRecipients) {
    return { allowed: false, reason: "recipient_limit_exceeded" };
  }
  const recipients: string[] = [];
  for (const rawRecipient of input.recipients) {
    const recipient = canonicalizeEmail(rawRecipient);
    if (!isWellFormedEmail(recipient)) {
      return { allowed: false, reason: "recipient_malformed" };
    }
    if (
      config.outbound.allowedRecipients !== undefined &&
      !config.outbound.allowedRecipients.some((pattern) => matchesPattern(recipient, pattern))
    ) {
      return { allowed: false, reason: "recipient_not_allowed" };
    }
    recipients.push(recipient);
  }
  if (new Set(recipients).size !== recipients.length) {
    return { allowed: false, reason: "recipient_malformed" };
  }
  if (input.subject.length === 0 || input.subject.length > 998 || /[\r\n\0]/.test(input.subject)) {
    return { allowed: false, reason: "subject_invalid" };
  }
  if (Buffer.byteLength(input.text, "utf8") > config.outbound.bodyMaxBytes) {
    return { allowed: false, reason: "body_limit_exceeded" };
  }
  return {
    allowed: true,
    recipients,
    subject: `${config.outbound.subjectPrefix}${input.subject}`,
  };
}

/** Sending a provider-native reply draft is always a fresh creator action. */
export function maySendAgentMailDraft(trustLevel: TrustLevel): boolean {
  return trustLevel === "creator";
}
