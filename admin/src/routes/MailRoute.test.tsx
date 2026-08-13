import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import type { MailDashboardProjection, MailInstanceProjection } from "@/lib/types";
import { formatTimestamp, MailActionCenter } from "./MailRoute";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("MailActionCenter", () => {
  it("renders provider-native status, exact chat guidance, and no editable mail data", () => {
    const html = render(projection());

    expect(html).toContain('aria-labelledby="mail-title"');
    expect(html).toContain("west@example.com");
    expect(html).toContain("public senders");
    expect(html).toContain("100/hour");
    expect(html).toContain("5/sender");
    expect(html).toContain("show draft");
    expect(html).toContain("&lt;draft-id&gt;");
    expect(html).toContain("send draft");
    expect(html).toContain('href="/chat/new"');
    expect(html).toContain('aria-label="Managed AgentMail drafts"');
    expect(html).toContain("draft_west");
    expect(html).toContain("Ready for review");
    expect(html).toContain('href="https://console.agentmail.to"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("private body");
    expect(html).not.toContain("recipient@example.com");
  });

  it("switches between mounted inboxes", async () => {
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <MailActionCenter projection={projection()} />
        </MemoryRouter>,
      );
    });
    const select = renderer?.root.findByProps({ id: "mail-instance" });
    await act(async () => {
      select?.props.onChange({ currentTarget: { value: "mail-east" } });
    });

    expect(nodeText(renderer!.root)).toContain("east@example.com");
    expect(nodeText(renderer!.root)).toContain("Send outcome unknown");
    const externalLink = renderer!.root
      .findAllByType("a")
      .find((link) => link.props.href === "https://console.agentmail.to");
    expect(externalLink?.props["aria-label"]).toBe(
      "Open east@example.com in AgentMail (opens in a new tab)",
    );
  });

  it("renders an empty provider draft state", () => {
    const data = projection();
    data.instances[0]!.drafts = [];
    const html = render({ instances: [data.instances[0]!] });

    expect(html).toContain("No managed drafts");
    expect(html).toContain("Draft content stays in AgentMail");
  });

  it("omits the provider action when no safe URL is projected", () => {
    const data = projection();
    delete data.instances[0]!.externalConsoleUrl;
    const html = render({ instances: [data.instances[0]!] });

    expect(html).not.toContain("Open in AgentMail");
    expect(html).not.toContain("console.agentmail.to");
  });

  it("escapes opaque provider identifiers", () => {
    const data = projection();
    data.instances[0]!.drafts[0]!.draftId = '<img src=x onerror="alert(1)">';
    data.instances[0]!.drafts[0]!.sourceMessageId = "<script>alert(1)</script>";
    data.instances[0]!.drafts[0] = {
      ...data.instances[0]!.drafts[0]!,
      state: "retryable",
      retryOperationId: '<svg onload="alert(1)">',
    };
    const html = render({ instances: [data.instances[0]!] });

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;svg");
  });

  it("presents stale and failed states distinctly", () => {
    const data = projection();
    data.instances[0]!.drafts.push(
      draft("draft_stale", "stale"),
      draft("draft_failed", "failed"),
    );
    const html = render({ instances: [data.instances[0]!] });

    expect(html).toContain("Changed in AgentMail");
    expect(html).toContain("Needs attention");
  });

  it("renders optional provenance and provider lifecycle states truthfully", () => {
    const data = projection();
    data.instances[0]!.drafts = [
      {
        draftId: "draft_new",
        state: "ready",
        providerUpdatedAt: "2026-08-12T18:00:00.000Z",
      },
      {
        ...draft("draft_scheduled", "scheduled"),
        sendAt: "2026-08-13T18:00:00.000Z",
      },
      draft("draft_sending", "sending"),
      {
        ...draft("draft_retryable", "retryable"),
        retryOperationId: "delivery_retry_1",
        retryAt: "2026-08-13T19:00:00.000Z",
      },
      draft("draft_sent", "sent"),
      draft("draft_deleted", "deleted"),
    ];
    const html = render({ instances: [data.instances[0]!] });

    expect(html).toContain("New message draft");
    expect(html).toContain("Scheduled in AgentMail");
    expect(html).toContain("Scheduled for");
    expect(html).toContain('dateTime="2026-08-13T18:00:00.000Z"');
    expect(html).toContain("Sending");
    expect(html).toContain("Retry required");
    expect(html).toContain("retry mail delivery delivery_retry_1");
    expect(html).toContain("Retry after");
    expect(html).toContain("Sent");
    expect(html).toContain("Deleted in AgentMail");
    expect(html).not.toContain("provider-native");
    expect(html).not.toContain(">undefined<");
  });

  it("makes degraded and stale-dashboard states explicit", () => {
    const data = projection();
    data.instances[0]!.status = { level: "warn", message: "Inbound reconnecting" };
    data.instances[0]!.inbound.state = "degraded";
    data.instances[0]!.inbound.lastErrorCode = "socket_closed";

    const degraded = render({ instances: [data.instances[0]!] });
    expect(degraded).toContain('role="alert"');
    expect(degraded).toContain("Mail needs attention");
    expect(degraded).toContain("Inbound reconnecting");
    expect(degraded).toContain("socket_closed");

    const stale = renderToStaticMarkup(
      <MemoryRouter>
        <MailActionCenter
          projection={{ instances: [data.instances[0]!] }}
          refreshError="Dashboard refresh failed"
        />
      </MemoryRouter>,
    );
    expect(stale).toContain("Mail status may be stale");
    expect(stale).toContain("Dashboard refresh failed");

    data.instances[0]!.status = { level: "error", message: "Provider unavailable" };
    const unavailable = renderToStaticMarkup(
      <MemoryRouter>
        <MailActionCenter
          projection={{ instances: [data.instances[0]!] }}
          refreshError="Dashboard refresh failed"
        />
      </MemoryRouter>,
    );
    expect(unavailable).toContain("Mail is unavailable");
    expect(unavailable).toContain("Provider unavailable");
    expect(unavailable).toContain("Latest dashboard refresh also failed");
    expect(unavailable).toContain("text-destructive");
  });
});

describe("formatTimestamp", () => {
  it("fails safely for malformed timestamps", () => {
    expect(formatTimestamp("not-a-date")).toBe("Unknown time");
  });
});

function render(value: MailDashboardProjection): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MailActionCenter projection={value} />
    </MemoryRouter>,
  );
}

function nodeText(node: ReactTestInstance | ReactTestRenderer["root"]): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : nodeText(child)))
    .join("");
}

function draft(draftId: string, state: MailInstanceProjection["drafts"][number]["state"]) {
  return {
    draftId,
    sourceMessageId: "message_" + draftId,
    threadId: "thread_" + draftId,
    state,
    providerUpdatedAt: "2026-08-12T18:00:00.000Z",
  };
}

function projection(): MailDashboardProjection {
  return {
    instances: [
      {
        augmentName: "mail-west",
        inboxId: "ibx_west",
        inboxEmail: "west@example.com",
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
        drafts: [draft("draft_west", "ready")],
      },
      {
        augmentName: "mail-east",
        inboxId: "ibx_east",
        inboxEmail: "east@example.com",
        externalConsoleUrl: "https://console.agentmail.to",
        status: { level: "warn", message: "Send outcome needs review" },
        inbound: {
          mode: "none",
          state: "idle",
          senderPolicy: "disabled",
          allowedSenderCount: 0,
        },
        replies: { mode: "disabled", allowReplyAll: false },
        drafts: [draft("draft_east", "ambiguous")],
      },
    ],
  };
}
