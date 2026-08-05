import { describe, expect, it } from "bun:test";
import { hasMailDashboard, selectMailDashboard } from "./mail-dashboard";
import type { DashboardData, MailInstanceProjection } from "./types";

describe("Mail dashboard projection", () => {
  it("selects multiple typed instances and preserves only metadata/action targets", () => {
    const west = instance("mail-west", "west@example.com");
    const east = instance("mail-east", "east@example.com");
    const dashboard = baseDashboard({
      mail: { schemaVersion: 1, instances: [west, east] },
    });

    expect(selectMailDashboard(dashboard)?.instances.map((item) => item.augmentName)).toEqual([
      "mail-west",
      "mail-east",
    ]);
    expect(hasMailDashboard(dashboard)).toBeTrue();
    expect(JSON.stringify(selectMailDashboard(dashboard))).not.toContain("private body");
  });

  it("does not expose the feature when no AgentMail projection exists", () => {
    const dashboard = baseDashboard();
    expect(selectMailDashboard(dashboard)).toBeNull();
    expect(hasMailDashboard(dashboard)).toBeFalse();
  });

  it("adapts current AgentMail blocks as read-only queues", () => {
    const dashboard = baseDashboard({
      blocks: [
        {
          augmentName: "agent-mail",
          title: "AgentMail",
          sections: [
            { kind: "status", level: "ok", message: "Inbound websocket ready" },
            {
              kind: "keyValue",
              rows: [
                { label: "Inbox ID", value: "ibx_1" },
                { label: "Inbox email", value: "agent@example.com" },
                { label: "Inbound mode", value: "websocket" },
                { label: "Inbound runtime", value: "ready" },
              ],
            },
            {
              kind: "table",
              columns: [
                "Review ID",
                "Trust",
                "State",
                "Recipients",
                "Subject",
                "Expires",
                "Inspect",
              ],
              rows: [
                [
                  "review_1",
                  "public",
                  "pending",
                  "m***@example.com",
                  "Quarterly update",
                  "2026-08-01T12:00:00.000Z",
                  "/agentmail/reviews/review_1",
                ],
              ],
            },
            {
              kind: "table",
              columns: ["Message", "State", "Version", "Review", "Updated"],
              rows: [
                [
                  "message_1",
                  "open",
                  "2",
                  "(none)",
                  "2026-07-30T12:00:00.000Z",
                ],
              ],
            },
          ],
        },
      ],
    });

    const selected = selectMailDashboard(dashboard)?.instances[0];
    expect(selected).toMatchObject({
      augmentName: "agent-mail",
      inboxId: "ibx_1",
      inboxEmail: "agent@example.com",
      inbound: { mode: "websocket", state: "ready" },
    });
    expect(selected?.reviews[0]?.actions).toEqual({});
    expect(selected?.attention[0]?.actions).toEqual({});
  });

  it("drops malformed items and unsafe detail paths from otherwise valid projections", () => {
    const valid = instance("mail-west", "west@example.com");
    const dashboard = baseDashboard({
      mail: {
        schemaVersion: 1,
        instances: [
          {
            ...valid,
            reviews: [
              {
                ...valid.reviews[0]!,
                detailPath: "/agentmail/mail-west/reviews/../console",
              },
            ],
          },
        ],
      },
    });
    expect(selectMailDashboard(dashboard)?.instances[0]?.reviews).toEqual([]);
  });

  it("neutralizes control and bidirectional override characters in displayed metadata", () => {
    const valid = instance("mail-west", "west@example.com");
    valid.reviews[0]!.subject = "Invoice\u0000\u202Egpj.exe";
    const dashboard = baseDashboard({
      mail: { schemaVersion: 1, instances: [valid] },
    });
    expect(selectMailDashboard(dashboard)?.instances[0]?.reviews[0]?.subject).toBe(
      "Invoice��gpj.exe",
    );
  });

  it("accepts only the credential-free AgentMail Console root", () => {
    const valid = instance("mail-west", "west@example.com");
    valid.externalConsoleUrl = "https://console.agentmail.to/";
    expect(
      selectMailDashboard(
        baseDashboard({ mail: { schemaVersion: 1, instances: [valid] } }),
      )?.instances[0]?.externalConsoleUrl,
    ).toBe("https://console.agentmail.to");

    const unsafeUrls = [
      "http://console.agentmail.to",
      "https://console.agentmail.to.evil.example",
      "https://user:password@console.agentmail.to",
      "https://console.agentmail.to/inboxes/west@example.com",
      "https://console.agentmail.to/?token=secret",
      "https://console.agentmail.to/#inbox",
      "not a URL",
    ];
    for (const externalConsoleUrl of unsafeUrls) {
      const candidate = instance("mail-west", "west@example.com");
      candidate.externalConsoleUrl = externalConsoleUrl;
      const selected = selectMailDashboard(
        baseDashboard({ mail: { schemaVersion: 1, instances: [candidate] } }),
      )?.instances[0];
      expect(selected?.augmentName).toBe("mail-west");
      expect(selected?.externalConsoleUrl).toBeUndefined();
    }
  });

  it("preserves only the exact projected recovery action contracts", () => {
    const valid = instance("mail-west", "west@example.com");
    valid.reviews[0] = {
      ...valid.reviews[0]!,
      status: "sending",
      actions: {
        approve: { actionId: "agentmail-review-approve-wrong" },
        reconcileSent: { actionId: "agentmail-review-reconcile-sent" },
        reconcileFailed: { actionId: "agentmail-review-reconcile-failed" },
      },
    };
    valid.attention.push({
      rowKey: "incident_1",
      messageId: "message_1",
      status: "ambiguous",
      version: 4,
      subject: "Uncertain webhook",
      sender: "sender@example.com",
      receivedAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:01:00.000Z",
      detailPath: "/agentmail/mail-west/messages/message_1",
      actions: {
        dismiss: { actionId: "agentmail-attention-dismiss-wrong" },
        reconcileProcessed: { actionId: "agentmail-inbound-reconcile-handled" },
        reconcilePending: { actionId: "agentmail-inbound-reconcile-no-effect" },
      },
    });

    const selected = selectMailDashboard(
      baseDashboard({ mail: { schemaVersion: 1, instances: [valid] } }),
    )?.instances[0];

    expect(selected?.reviews[0]?.actions).toEqual({
      reconcileSent: { actionId: "agentmail-review-reconcile-sent" },
      reconcileFailed: { actionId: "agentmail-review-reconcile-failed" },
    });
    expect(selected?.attention[0]?.rowKey).toBe("incident_1");
    expect(selected?.attention[0]?.actions).toEqual({
      reconcileProcessed: { actionId: "agentmail-inbound-reconcile-handled" },
      reconcilePending: { actionId: "agentmail-inbound-reconcile-no-effect" },
    });
  });

  it("preserves bounded public-inbound quota metadata", () => {
    const valid = instance("mail-public", "public@example.com");
    valid.inbound = {
      mode: "websocket",
      state: "ready",
      senderPolicy: "any",
      allowedSenderCount: 0,
      rateLimit: {
        globalMaxPerHour: 100,
        perSenderMaxPerHour: 5,
        rollingGlobalUsage: 12,
        globalRejections: 3,
        perSenderRejections: 7,
        lastRejectedAt: "2026-07-31T12:00:00.000Z",
      },
    };

    expect(
      selectMailDashboard(
        baseDashboard({ mail: { schemaVersion: 1, instances: [valid] } }),
      )?.instances[0]?.inbound,
    ).toEqual(valid.inbound);
  });

  it("rejects malformed or impossible public-inbound quota metadata", () => {
    const cases = [
      { senderPolicy: "everyone" },
      { allowedSenderCount: 1_001 },
      { senderPolicy: "any", allowedSenderCount: 0 },
      { senderPolicy: "allowlist", allowedSenderCount: 0 },
      { senderPolicy: "disabled", allowedSenderCount: 0 },
      {
        senderPolicy: "disabled",
        allowedSenderCount: 0,
        rateLimit: {
          globalMaxPerHour: 10,
          perSenderMaxPerHour: 1,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
        },
      },
      {
        senderPolicy: "any",
        allowedSenderCount: 1,
        rateLimit: {
          globalMaxPerHour: 10,
          perSenderMaxPerHour: 1,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
        },
      },
      {
        mode: "none",
        senderPolicy: "any",
        allowedSenderCount: 0,
        rateLimit: {
          globalMaxPerHour: 10,
          perSenderMaxPerHour: 1,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
        },
      },
      {
        rateLimit: {
          globalMaxPerHour: 10,
          perSenderMaxPerHour: 11,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
        },
      },
      {
        rateLimit: {
          globalMaxPerHour: 10_001,
          perSenderMaxPerHour: 1,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
        },
      },
      {
        senderPolicy: "any",
        allowedSenderCount: 0,
        rateLimit: {
          globalMaxPerHour: 10,
          perSenderMaxPerHour: 1,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
          lastRejectedAt: "not-a-timestamp",
        },
      },
      {
        senderPolicy: "any",
        allowedSenderCount: 0,
        rateLimit: {
          globalMaxPerHour: 10,
          perSenderMaxPerHour: 1,
          rollingGlobalUsage: 0,
          globalRejections: 0,
          perSenderRejections: 0,
          lastRejectedAt: "July 31, 2026",
        },
      },
    ];

    for (const inboundOverride of cases) {
      const valid = instance("mail-public", "public@example.com");
      const candidate = {
        ...valid,
        inbound: { ...valid.inbound, ...inboundOverride },
      } as MailInstanceProjection;
      expect(
        selectMailDashboard(
          baseDashboard({ mail: { schemaVersion: 1, instances: [candidate] } }),
        ),
      ).toBeNull();
    }
  });
});

function instance(augmentName: string, inboxEmail: string): MailInstanceProjection {
  return {
    augmentName,
    inboxId: `ibx_${augmentName}`,
    inboxEmail,
    status: { level: "ok", message: "Inbound websocket ready" },
    inbound: { mode: "websocket", state: "ready" },
    reviews: [
      {
        rowKey: "review_1",
        reviewId: "review_1",
        status: "pending",
        subject: "Quarterly update",
        correspondent: "m***@example.com",
        expiresAt: "2026-08-01T12:00:00.000Z",
        detailPath: `/agentmail/${augmentName}/reviews/review_1`,
        actions: {
          approve: { actionId: "agentmail-review-approve" },
        },
      },
    ],
    attention: [],
  };
}

function baseDashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    card: { provider: { name: "agent" } },
    auggyVersion: "test",
    agentMeta: null,
    augments: [],
    tools: { totalTools: 0, entries: [] },
    routes: {
      summary: {
        totalRoutes: 0,
        publicRoutes: 0,
        privateRoutes: 0,
        publicRoutePaths: [],
      },
      entries: [],
    },
    web: {
      allowAnonymous: { value: false },
      publicIntegration: { value: false },
      trustedProxies: [],
      corsOrigins: [],
      visitorTokensEnabled: false,
      externalAuthEnabled: false,
    },
    blocks: [],
    csrfTokens: [],
    skills: { installed: [], available: [], skillsDir: null },
    ...overrides,
  };
}
