/**
 * Console-log adapter for the visitor-auth magic-link flow.
 *
 * Implements the `AgentMailClient` interface so visitorAuth's `request_auth`
 * tool can swap it in transparently — no branching in the send call site.
 * Instead of POSTing to AgentMail, this adapter prints the verification details
 * (with the verify URL embedded verbatim in `input.text`) to stdout. The
 * operator copies the URL from their terminal and opens it in a browser to
 * complete verification.
 *
 * Why this exists (G34, v1.0 concierge-readiness): OSS adopters who run
 * `auggy create && auggy dev && auggy augment add visitorAuth` can now complete
 * the visitor-recognition flow end-to-end without paying for an AgentMail
 * account. AgentMail remains the production-grade default; this adapter
 * is the local-testing alternative.
 *
 * Safety: this adapter writes magic links to stdout. In production
 * environments (NODE_ENV=production), the visitorAuth factory rejects this
 * adapter at boot unless `allowConsoleInProduction: true` is set in
 * agent.yaml — see the factory in `./index.ts`. The guard is there, not
 * here, so the adapter itself stays stateless and trivially testable.
 */

import type {
  AgentMailClient,
  AgentMailInboxInfo,
  SendMessageInput,
  SendMessageResult,
} from "../../agentmail-client";

export interface ConsoleMailClientOptions {
  /**
   * Override the stdout sink. Tests inject an array-push to capture lines
   * without polluting test output. Production omits this and inherits
   * `console.log`.
   */
  sink?: (line: string) => void;
}

export function createConsoleMailClient(opts: ConsoleMailClientOptions = {}): AgentMailClient {
  const sink = opts.sink ?? ((line) => console.log(line));
  return {
    async send(input: SendMessageInput): Promise<SendMessageResult> {
      // Surface the magic link in a grep-friendly header line followed by the
      // verbatim message text. The verify URL appears in `input.text` exactly
      // as it would in a real email — the operator copies from this terminal
      // line into a browser to complete verification.
      const recipient = input.to.join(", ");
      sink(
        `INFO visitorAuth local verification link\n  To: ${recipient}\n  Subject: ${input.subject}\n  ${input.text.replace(/\n/g, "\n  ")}`,
      );
      return {
        status: "sent",
        messageId: `console-${crypto.randomUUID()}`,
        threadId: `console-thread-${crypto.randomUUID()}`,
      };
    },
    async reply(input): Promise<SendMessageResult> {
      sink(
        `INFO visitorAuth local reply\n  Message: ${input.messageId}\n  ${input.text.replace(/\n/g, "\n  ")}`,
      );
      return {
        status: "sent",
        messageId: `console-${crypto.randomUUID()}`,
        threadId: `console-thread-${crypto.randomUUID()}`,
      };
    },
    async forward(input): Promise<SendMessageResult> {
      sink(
        `INFO visitorAuth local forward\n  Message: ${input.messageId}\n  To: ${input.to.join(", ")}`,
      );
      return {
        status: "sent",
        messageId: `console-${crypto.randomUUID()}`,
        threadId: `console-thread-${crypto.randomUUID()}`,
      };
    },
    async getInbox(inboxId: string): Promise<AgentMailInboxInfo> {
      // The console adapter has no inbox; return a synthetic OK so any
      // boot-time inbox validation passes without touching the network.
      return { inboxId, email: "console@localhost.invalid", status: "ok" };
    },
  };
}
