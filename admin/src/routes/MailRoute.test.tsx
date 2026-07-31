import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ConfirmProvider } from "@/lib/confirm";
import type { MailReviewDetail } from "@/lib/mail-api";
import { NoopToastProvider } from "@/lib/toast";
import type { MailDashboardProjection } from "@/lib/types";
import {
  buildAttentionRecoveryValues,
  buildReviewFailedRecoveryValues,
  buildReviewSentRecoveryValues,
  isMailBodyWithinLimit,
  mailActionFailureMessage,
  MailActionCenter,
  MailActionFeedback,
  MailQueuedActionSummary,
} from "./MailRoute";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("MailActionCenter", () => {
  it("renders multiple inboxes, metadata-only queues, and accessible navigation", () => {
    const html = renderToStaticMarkup(
      <Providers>
        <MailActionCenter
          projection={projection()}
          csrfTokens={[]}
          refresh={async () => undefined}
        />
      </Providers>,
    );

    expect(html).toContain('aria-labelledby="mail-title"');
    expect(html).toContain('for="mail-instance"');
    expect(html).toContain("west@example.com");
    expect(html).toContain("east@example.com");
    expect(html).toContain('aria-label="Pending email reviews"');
    expect(html).toContain('aria-label="Email creator attention"');
    expect(html).not.toContain("private body");
  });

  it("escapes XSS-looking sender and subject metadata", () => {
    const data = projection();
    data.instances[0]!.reviews[0]!.subject =
      '<img src=x onerror="globalThis.compromised=true">';
    data.instances[0]!.attention[0]!.sender = "<script>alert(1)</script>";

    const html = renderToStaticMarkup(
      <Providers>
        <MailActionCenter
          projection={data}
          csrfTokens={[]}
          refresh={async () => undefined}
        />
      </Providers>,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("switches between multiple AgentMail instances", async () => {
    await act(async () => {
      renderer = create(
        <Providers>
          <MailActionCenter
            projection={projection()}
            csrfTokens={[]}
            refresh={async () => undefined}
          />
        </Providers>,
      );
    });
    const select = renderer?.root.findByProps({ id: "mail-instance" });
    await act(async () =>
      select?.props.onChange({ currentTarget: { value: "mail-east" } }),
    );
    expect(nodeText(renderer!.root)).toContain("east@example.com");
    expect(nodeText(renderer!.root)).toContain("East coast message");
  });

  it("renders stale action feedback as an accessible alert", () => {
    const message = mailActionFailureMessage(
      {
        ok: false,
        message: "Review changed and no longer matches this fingerprint",
      },
      "Approval failed.",
    );
    const html = renderToStaticMarkup(<MailActionFeedback message={message} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("changed while it was open");
    expect(html).not.toContain("Approval failed");
  });

  it("renders the exact immutable queued action before approval", () => {
    const detail: MailReviewDetail = {
      kind: "review",
      reviewId: "review_1",
      fingerprint: "sha256:fingerprint",
      state: "pending",
      trustLevel: "creator",
      expiresAt: "2026-08-01T12:00:00.000Z",
      recipients: ["owner@example.com", "ops+urgent@example.com"],
      subject: "Reply <script>alert('subject')</script>",
      request: {
        kind: "reply",
        messageId: "provider_message_123",
        replyAll: true,
        text: "Exact body <img src=x onerror=alert(1)>",
        html: "<p onclick=alert(1)>Exact HTML</p>",
        labels: ["important", "creator-reviewed"],
      },
    };

    const html = renderToStaticMarkup(<MailQueuedActionSummary detail={detail} />);

    expect(html).toContain("Exact queued action");
    expect(html).toContain("reply");
    expect(html).toContain("owner@example.com, ops+urgent@example.com");
    expect(html).toContain("provider_message_123");
    expect(html).toContain("Reply all");
    expect(html).toContain("Yes");
    expect(html).toContain("important, creator-reviewed");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;p onclick=alert(1)&gt;Exact HTML&lt;/p&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<p onclick");
  });

  it("builds only the declared bounded recovery action inputs", () => {
    expect(
      buildReviewSentRecoveryValues(" sha256:fingerprint ", {
        messageId: " provider_message_123 ",
        threadId: " ",
        evidence: " provider dashboard verified ",
      }),
    ).toEqual({
      fingerprint: "sha256:fingerprint",
      messageId: "provider_message_123",
      evidence: "provider dashboard verified",
    });
    expect(
      buildReviewSentRecoveryValues("fingerprint", {
        messageId: "message",
        threadId: " thread_123 ",
        evidence: "evidence",
      }),
    ).toEqual({
      fingerprint: "fingerprint",
      messageId: "message",
      threadId: "thread_123",
      evidence: "evidence",
    });
    expect(buildReviewFailedRecoveryValues(" fingerprint ", " no provider record ")).toEqual({
      fingerprint: "fingerprint",
      reason: "no provider record",
    });
    expect(buildAttentionRecoveryValues(7, " ledger checked ")).toEqual({
      version: "7",
      evidence: "ledger checked",
    });
  });

  it("enforces the 1 MiB revision limit in UTF-8 bytes", () => {
    expect(isMailBodyWithinLimit("a".repeat(1024 * 1024))).toBeTrue();
    expect(isMailBodyWithinLimit("é".repeat(512 * 1024))).toBeTrue();
    expect(isMailBodyWithinLimit(`${"é".repeat(512 * 1024)}a`)).toBeFalse();
  });
});

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NoopToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </NoopToastProvider>
  );
}

function nodeText(node: ReactTestInstance | ReactTestRenderer["root"]): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : nodeText(child)))
    .join("");
}

function projection(): MailDashboardProjection {
  return {
    schemaVersion: 1,
    instances: [
      {
        augmentName: "mail-west",
        inboxId: "ibx_west",
        inboxEmail: "west@example.com",
        status: { level: "ok", message: "Inbound websocket ready" },
        inbound: { mode: "websocket", state: "ready" },
        reviews: [
          {
            rowKey: "review_1",
            reviewId: "review_1",
            status: "pending",
            subject: "Reply to Mike",
            correspondent: "m***@example.com",
            expiresAt: "2026-08-01T12:00:00.000Z",
            detailPath: "/agentmail/mail-west/reviews/review_1",
            actions: {
              approve: { actionId: "agentmail-review-approve" },
              revise: { actionId: "agentmail-review-revise" },
              reject: { actionId: "agentmail-review-reject" },
            },
          },
        ],
        attention: [
          {
            rowKey: "message_1",
            messageId: "message_1",
            status: "open",
            version: 2,
            subject: "Invoice question",
            sender: "sender@example.com",
            receivedAt: "2026-07-30T10:00:00.000Z",
            updatedAt: "2026-07-30T10:01:00.000Z",
            detailPath: "/agentmail/mail-west/messages/message_1",
            actions: {
              dismiss: { actionId: "agentmail-attention-dismiss" },
            },
          },
        ],
      },
      {
        augmentName: "mail-east",
        inboxId: "ibx_east",
        inboxEmail: "east@example.com",
        status: { level: "warn", message: "Polling delayed" },
        inbound: { mode: "polling", state: "degraded" },
        reviews: [
          {
            rowKey: "review_east",
            reviewId: "review_east",
            status: "pending",
            subject: "East coast message",
            correspondent: "e***@example.com",
            expiresAt: "2026-08-01T12:00:00.000Z",
            detailPath: "/agentmail/mail-east/reviews/review_east",
            actions: {},
          },
        ],
        attention: [],
      },
    ],
  };
}
