import { describe, expect, it } from "bun:test";
import { hasMailDashboard, selectMailDashboard } from "./mail-dashboard";
import type { AdminInfoBlock, DashboardData, MailAdminProjection } from "./types";

describe("Mail dashboard projection", () => {
  it("selects block-local provider-native instances", () => {
    const dashboard = baseDashboard({
      blocks: [block("mail-west", "west@example.com"), block("mail-east", "east@example.com")],
    });

    expect(selectMailDashboard(dashboard)?.instances.map((item) => item.augmentName)).toEqual([
      "mail-west",
      "mail-east",
    ]);
    expect(hasMailDashboard(dashboard)).toBeTrue();
  });

  it("does not expose Mail for generic or legacy AgentMail blocks", () => {
    const dashboard = baseDashboard({
      blocks: [
        {
          augmentName: "agentMail",
          title: "AgentMail",
          sections: [
            { kind: "status", level: "ok", message: "Ready" },
            {
              kind: "keyValue",
              rows: [{ label: "Inbox ID", value: "legacy_inbox" }],
            },
          ],
        },
      ],
    });

    expect(selectMailDashboard(dashboard)).toBeNull();
    expect(hasMailDashboard(dashboard)).toBeFalse();
  });

  it("rejects a projection whose mounted augment identity does not match", () => {
    const candidate = block("mail-west", "west@example.com");
    candidate.projection = {
      ...candidate.projection,
      augmentName: "mail-east",
    } as MailAdminProjection;

    expect(selectMailDashboard(baseDashboard({ blocks: [candidate] }))).toBeNull();
  });

  it("drops malformed draft references without rejecting healthy instance status", () => {
    const candidate = block("mail-west", "west@example.com");
    const projection = candidate.projection as MailAdminProjection;
    projection.drafts.push(
      {
        ...projection.drafts[0]!,
        draftId: "",
      },
      {
        ...projection.drafts[0]!,
        draftId: "draft_bad_time",
        providerUpdatedAt: "not-a-time",
      },
    );

    const selected = selectMailDashboard(baseDashboard({ blocks: [candidate] }));
    expect(selected?.instances[0]?.drafts.map((draft) => draft.draftId)).toEqual(["draft_1"]);
  });

  it("accepts new-message drafts without source or thread references", () => {
    const candidate = block("mail-west", "west@example.com");
    const projection = candidate.projection as MailAdminProjection;
    projection.drafts = [
      {
        draftId: "draft_new",
        state: "ready",
        providerUpdatedAt: "2026-08-12T18:00:00.000Z",
      },
    ];

    expect(
      selectMailDashboard(baseDashboard({ blocks: [candidate] }))?.instances[0]?.drafts,
    ).toEqual([
      {
        draftId: "draft_new",
        state: "ready",
        providerUpdatedAt: "2026-08-12T18:00:00.000Z",
      },
    ]);
  });

  it("accepts scheduled and deleted provider states", () => {
    const candidate = block("mail-west", "west@example.com");
    const projection = candidate.projection as MailAdminProjection;
    projection.drafts = [
      {
        ...projection.drafts[0]!,
        draftId: "draft_scheduled",
        state: "scheduled",
        sendAt: "2026-08-13T18:00:00.000Z",
      },
      { ...projection.drafts[0]!, draftId: "draft_deleted", state: "deleted" },
    ];

    expect(
      selectMailDashboard(baseDashboard({ blocks: [candidate] }))?.instances[0]?.drafts.map(
        (draft) => draft.state,
      ),
    ).toEqual(["scheduled", "deleted"]);
  });

  it("requires valid provider scheduling metadata for scheduled drafts", () => {
    for (const sendAt of [undefined, "not-a-time"]) {
      const candidate = block("mail-west", "west@example.com");
      const projection = candidate.projection as MailAdminProjection;
      projection.drafts = [
        {
          ...projection.drafts[0]!,
          state: "scheduled",
          ...(sendAt === undefined ? {} : { sendAt }),
        },
      ];
      expect(
        selectMailDashboard(baseDashboard({ blocks: [candidate] }))?.instances[0]?.drafts,
      ).toEqual([]);
    }
  });

  it("binds retry guidance only to a valid retryable delivery operation", () => {
    const candidate = block("mail-west", "west@example.com");
    const projection = candidate.projection as MailAdminProjection;
    projection.drafts = [
      {
        ...projection.drafts[0]!,
        state: "retryable",
        retryOperationId: "delivery_retry_1",
        retryAt: "2026-08-13T18:00:00.000Z",
      },
    ];
    expect(
      selectMailDashboard(baseDashboard({ blocks: [candidate] }))?.instances[0]?.drafts[0],
    ).toMatchObject({
      state: "retryable",
      retryOperationId: "delivery_retry_1",
      retryAt: "2026-08-13T18:00:00.000Z",
    });

    for (const draft of [
      { ...projection.drafts[0]!, retryOperationId: undefined },
      { ...projection.drafts[0]!, retryAt: "not-a-time" },
      {
        ...projection.drafts[0]!,
        state: "ready" as const,
        retryOperationId: "delivery_retry_1",
      },
    ]) {
      const malformed = block("mail-west", "west@example.com");
      (malformed.projection as MailAdminProjection).drafts = [draft];
      expect(
        selectMailDashboard(baseDashboard({ blocks: [malformed] }))?.instances[0]?.drafts,
      ).toEqual([]);
    }
  });

  it("rejects present but malformed optional draft references", () => {
    const candidate = block("mail-west", "west@example.com");
    const projection = candidate.projection as MailAdminProjection;
    projection.drafts = [
      { ...projection.drafts[0]!, draftId: "draft_bad_source", sourceMessageId: "" },
      { ...projection.drafts[0]!, draftId: "draft_bad_thread", threadId: 42 as never },
    ];

    expect(
      selectMailDashboard(baseDashboard({ blocks: [candidate] }))?.instances[0]?.drafts,
    ).toEqual([]);
  });

  it("neutralizes display control characters in opaque identifiers", () => {
    const candidate = block("mail-west", "west@example.com");
    (candidate.projection as MailAdminProjection).drafts[0]!.draftId =
      "draft\u0000\u202Egpj.exe";

    expect(
      selectMailDashboard(baseDashboard({ blocks: [candidate] }))?.instances[0]?.drafts[0]
        ?.draftId,
    ).toBe("draft��gpj.exe");
  });

  it("accepts only the credential-free AgentMail Console root", () => {
    const valid = block("mail-west", "west@example.com");
    (valid.projection as MailAdminProjection).externalConsoleUrl =
      "https://console.agentmail.to/";
    expect(
      selectMailDashboard(baseDashboard({ blocks: [valid] }))?.instances[0]
        ?.externalConsoleUrl,
    ).toBe("https://console.agentmail.to");

    for (const externalConsoleUrl of [
      "http://console.agentmail.to",
      "https://console.agentmail.to.evil.example",
      "https://user:password@console.agentmail.to",
      "https://console.agentmail.to/inboxes/west@example.com",
      "https://console.agentmail.to/?token=secret",
      "https://console.agentmail.to/#inbox",
      "not a URL",
    ]) {
      const candidate = block("mail-west", "west@example.com");
      (candidate.projection as MailAdminProjection).externalConsoleUrl = externalConsoleUrl;
      const selected = selectMailDashboard(baseDashboard({ blocks: [candidate] }));
      expect(selected?.instances[0]?.augmentName).toBe("mail-west");
      expect(selected?.instances[0]?.externalConsoleUrl).toBeUndefined();
    }
  });

  it("rejects impossible inbound and reply policy combinations", () => {
    const overrides = [
      { inbound: { mode: "none", state: "idle", senderPolicy: "any", allowedSenderCount: 0 } },
      {
        inbound: {
          mode: "websocket",
          state: "ready",
          senderPolicy: "any",
          allowedSenderCount: 0,
        },
      },
      {
        inbound: {
          mode: "websocket",
          state: "ready",
          senderPolicy: "allowlist",
          allowedSenderCount: 0,
          globalMaxPerHour: 100,
          perSenderMaxPerHour: 5,
        },
      },
      { replies: { mode: "automatic", allowReplyAll: false } },
      {
        inbound: { mode: "none", state: "ready", senderPolicy: "disabled", allowedSenderCount: 0 },
      },
      { replies: { mode: "disabled", allowReplyAll: true } },
      {
        inbound: { mode: "none", state: "idle", senderPolicy: "disabled", allowedSenderCount: 0 },
        replies: { mode: "review", allowReplyAll: false },
      },
      {
        inbound: {
          mode: "websocket",
          state: "ready",
          senderPolicy: "any",
          allowedSenderCount: 0,
          globalMaxPerHour: 100,
          perSenderMaxPerHour: 5,
          lastEventAt: "not-a-time",
        },
      },
    ];

    for (const override of overrides) {
      const candidate = block("mail-west", "west@example.com");
      candidate.projection = {
        ...candidate.projection,
        ...override,
      } as MailAdminProjection;
      expect(selectMailDashboard(baseDashboard({ blocks: [candidate] }))).toBeNull();
    }
  });

  it("caps projected instances and drafts", () => {
    const blocks = Array.from({ length: 40 }, (_, index) =>
      block("mail-" + index, index + "@example.com"),
    );
    const projection = blocks[0]!.projection as MailAdminProjection;
    projection.drafts = Array.from({ length: 120 }, (_, index) => ({
      draftId: "draft_" + index,
      sourceMessageId: "message_" + index,
      threadId: "thread_" + index,
      state: "ready",
      providerUpdatedAt: "2026-08-12T18:00:00.000Z",
    }));

    const selected = selectMailDashboard(baseDashboard({ blocks }));
    expect(selected?.instances).toHaveLength(32);
    expect(selected?.instances[0]?.drafts).toHaveLength(100);
  });

  it("contains no legacy editable review contract", () => {
    const selected = selectMailDashboard(
      baseDashboard({ blocks: [block("mail-west", "west@example.com")] }),
    );
    const serialized = JSON.stringify(selected);

    expect(serialized).not.toContain("detailPath");
    expect(serialized).not.toContain("actions");
    expect(serialized).not.toContain("reviewId");
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("recipients");
    expect(serialized).not.toContain("clientId");
    expect(serialized).not.toContain("sendKey");
  });
});

function block(augmentName: string, inboxEmail: string): AdminInfoBlock {
  return {
    augmentName,
    title: "AgentMail",
    sections: [{ kind: "status", level: "ok", message: "Inbound ready" }],
    projection: {
      kind: "mail",
      augmentName,
      inboxId: "ibx_" + augmentName,
      inboxEmail,
      externalConsoleUrl: "https://console.agentmail.to",
      status: { level: "ok", message: "Inbound ready" },
      inbound: {
        mode: "websocket",
        state: "ready",
        senderPolicy: "any",
        allowedSenderCount: 0,
        globalMaxPerHour: 100,
        perSenderMaxPerHour: 5,
        lastCatchUpAt: "2026-08-12T18:00:00.000Z",
      },
      replies: { mode: "review", allowReplyAll: false },
      drafts: [
        {
          draftId: "draft_1",
          sourceMessageId: "message_1",
          threadId: "thread_1",
          state: "ready",
          providerUpdatedAt: "2026-08-12T18:00:00.000Z",
        },
      ],
    },
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
