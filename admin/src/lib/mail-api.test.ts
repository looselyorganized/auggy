import { describe, expect, it } from "bun:test";
import {
  fetchMailDetail,
  isStaleMailActionResult,
  MailDetailError,
  MAX_MAIL_BODY_CHARS,
  postMailAction,
} from "./mail-api";

describe("Mail API", () => {
  it("loads and validates exact review details, including reply metadata", async () => {
    let requested = "";
    const detail = await fetchMailDetail("/agentmail/mail-west/reviews/review_1", {
      locationHref: "https://console.example.test/console",
      fetchImpl: async (input) => {
        requested = String(input);
        return json({
          reviewId: "review_1",
          fingerprint: "sha256:fingerprint",
          state: "pending",
          trustLevel: "public",
          expiresAt: "2026-08-01T12:00:00.000Z",
          recipients: ["owner@example.com"],
          subject: "",
          request: {
            kind: "reply",
            messageId: "message_1",
            text: "Exact reply",
            html: "<p>Exact reply</p>",
            replyAll: false,
            labels: ["important", "creator-reviewed"],
          },
        });
      },
    });
    expect(requested).toBe(
      "https://console.example.test/console/api/mail-detail?path=%2Fagentmail%2Fmail-west%2Freviews%2Freview_1",
    );
    expect(detail).toMatchObject({
      kind: "review",
      reviewId: "review_1",
      request: {
        kind: "reply",
        text: "Exact reply",
        html: "<p>Exact reply</p>",
        messageId: "message_1",
        replyAll: false,
        labels: ["important", "creator-reviewed"],
      },
    });
  });

  it("normalizes omitted optional fields without inventing replyAll", async () => {
    const detail = await fetchMailDetail("/agentmail/mail-west/reviews/review_1", {
      locationHref: "https://console.example.test/console",
      fetchImpl: async () =>
        json({
          reviewId: "review_1",
          fingerprint: "sha256:fingerprint",
          state: "pending",
          trustLevel: "public",
          expiresAt: "2026-08-01T12:00:00.000Z",
          recipients: ["owner@example.com"],
          subject: "",
          request: {
            kind: "forward",
            messageId: "message_1",
          },
        }),
    });
    expect(detail).toMatchObject({
      kind: "review",
      subject: "",
      request: {
        kind: "forward",
        text: "",
        messageId: "message_1",
        labels: [],
      },
    });
    expect(detail.kind === "review" && "replyAll" in detail.request).toBeFalse();
  });

  it("rejects malformed immutable queued-action fields at exact bounds", async () => {
    const base = {
      reviewId: "review_1",
      fingerprint: "sha256:fingerprint",
      state: "pending",
      trustLevel: "public",
      expiresAt: "2026-08-01T12:00:00.000Z",
      recipients: ["owner@example.com"],
      subject: "Reply",
    };
    const invalidRequests = [
      { kind: "reply", text: "body" },
      { kind: "forward", messageId: "" },
      { kind: "reply", messageId: "message_1", text: "body", replyAll: "yes" },
      { kind: "send", text: "body", html: "x".repeat(MAX_MAIL_BODY_CHARS + 1) },
      { kind: "send", text: "body", labels: Array.from({ length: 101 }, () => "x") },
      { kind: "send", text: "body", labels: ["x".repeat(201)] },
      { kind: "send", text: "body", labels: [""] },
    ];

    for (const request of invalidRequests) {
      const error = await fetchMailDetail("/agentmail/mail-west/reviews/review_1", {
        locationHref: "https://console.example.test/console",
        fetchImpl: async () => json({ ...base, request }),
      }).catch((reason) => reason);
      expect(error).toBeInstanceOf(MailDetailError);
      expect((error as MailDetailError).code).toBe("invalid");
    }
  });

  it("accepts detail bodies up to the runtime's 1 MiB ceiling", async () => {
    const text = "a".repeat(1024 * 1024);
    const detail = await fetchMailDetail("/agentmail/mail-west/messages/message_1", {
      locationHref: "https://console.example.test/console",
      fetchImpl: async () =>
        json({
          messageId: "message_1",
          sender: "sender@example.com",
          subject: "Large but valid",
          receivedAt: "2026-08-01T12:00:00.000Z",
          text,
        }),
    });
    expect(detail.kind).toBe("message");
    expect(detail.kind === "message" ? detail.text?.length : 0).toBe(1024 * 1024);
  });

  it("rejects non-canonical paths before issuing a request", async () => {
    let called = false;
    const error = await fetchMailDetail("/agentmail/mail-west/reviews/../console", {
      locationHref: "https://console.example.test/console",
      fetchImpl: async () => {
        called = true;
        return json({});
      },
    }).catch((reason) => reason);
    expect(called).toBeFalse();
    expect(error).toBeInstanceOf(MailDetailError);
    expect((error as MailDetailError).code).toBe("invalid");
  });

  it("posts with the exact augment, action, row, and CSRF tuple", async () => {
    let request: { url: string; body: string } | undefined;
    const result = await postMailAction(
      {
        tokens: [
          {
            augmentName: "mail-west",
            actionId: "agentmail-review-approve",
            rowKey: "review_1",
            token: "csrf-exact",
          },
          {
            augmentName: "mail-east",
            actionId: "agentmail-review-approve",
            rowKey: "review_1",
            token: "csrf-wrong-instance",
          },
        ],
        augmentName: "mail-west",
        actionId: "agentmail-review-approve",
        rowKey: "review_1",
        values: { fingerprint: "sha256:fingerprint" },
      },
      {
        locationHref: "https://console.example.test/console",
        fetchImpl: async (input, init) => {
          request = { url: String(input), body: String(init?.body) };
          return json({ ok: true, message: "sent", csrfExpired: false });
        },
      },
    );
    expect(result.ok).toBeTrue();
    expect(request?.url).toBe(
      "https://console.example.test/console/action/mail-west/agentmail-review-approve/row/review_1",
    );
    expect(request?.body).toContain("_csrf=csrf-exact");
    expect(request?.body).toContain("fingerprint=sha256%3Afingerprint");
  });

  it("fails closed when the exact row token is absent and recognizes stale outcomes", async () => {
    const result = await postMailAction({
      tokens: [
        {
          augmentName: "mail-east",
          actionId: "agentmail-review-approve",
          rowKey: "review_1",
          token: "wrong",
        },
      ],
      augmentName: "mail-west",
      actionId: "agentmail-review-approve",
      rowKey: "review_1",
    });
    expect(result).toMatchObject({ ok: false, conflict: true, status: 409 });
    expect(isStaleMailActionResult(result)).toBeTrue();
    expect(
      isStaleMailActionResult({
        ok: false,
        csrfExpired: false,
        message: "Creator attention changed; current version is 4",
      }),
    ).toBeTrue();
  });

  it("fails closed on duplicate exact CSRF tuples", async () => {
    const result = await postMailAction({
      tokens: ["one", "two"].map((token) => ({
        augmentName: "mail-west",
        actionId: "agentmail-review-reject",
        rowKey: "review_1",
        token,
      })),
      augmentName: "mail-west",
      actionId: "agentmail-review-reject",
      rowKey: "review_1",
    });
    expect(result).toMatchObject({ ok: false, conflict: true, status: 409 });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
