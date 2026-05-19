import { describe, expect, it } from "bun:test";
import { renderAdminPage } from "@/transports/admin/admin-renderer";
import type { AdminInfoBlock, AgentCard } from "@/types";

function card(name = "zip"): AgentCard {
  return {
    provider: { name },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      memory: false,
      transport: true,
    },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
}

describe("admin-renderer — page shell", () => {
  it("returns valid HTML document", () => {
    const html = renderAdminPage({ card: card(), blocks: [], getCsrfToken: () => "tok" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("includes agent name in title and h1", () => {
    const html = renderAdminPage({ card: card("zip"), blocks: [], getCsrfToken: () => "tok" });
    expect(html).toContain("<title>zip — admin</title>");
    expect(html).toContain("<h1>zip</h1>");
  });

  it("includes robots noindex meta", () => {
    const html = renderAdminPage({ card: card(), blocks: [], getCsrfToken: () => "tok" });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("escapes agent name in title + h1", () => {
    const html = renderAdminPage({
      card: card("<script>alert(1)</script>"),
      blocks: [],
      getCsrfToken: () => "tok",
    });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("includes flash message when provided", () => {
    const html = renderAdminPage({
      card: card(),
      blocks: [],
      getCsrfToken: () => "tok",
      flashMessage: "Test sent successfully",
    });
    expect(html).toContain("Test sent successfully");
  });

  it("escapes flash message", () => {
    const html = renderAdminPage({
      card: card(),
      blocks: [],
      getCsrfToken: () => "tok",
      flashMessage: '<img onerror="alert(1)" src=x>',
    });
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;img");
  });

  it("includes footer security notice", () => {
    const html = renderAdminPage({ card: card(), blocks: [], getCsrfToken: () => "tok" });
    expect(html).toContain("Admin credentials are visible in browser devtools");
  });
});

describe("admin-renderer — block rendering", () => {
  it("renders a block with title", () => {
    const block: AdminInfoBlock = {
      augmentName: "test",
      title: "Test Augment",
      sections: [{ kind: "status", level: "ok", message: "all systems go" }],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("<h2>Test Augment</h2>");
  });

  it("skips blocks with no sections and no actions", () => {
    const block: AdminInfoBlock = {
      augmentName: "empty",
      title: "Empty",
      sections: [],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).not.toContain("<h2>Empty</h2>");
  });

  it("renders multiple blocks in order", () => {
    const blocks: AdminInfoBlock[] = [
      {
        augmentName: "a",
        title: "Alpha",
        sections: [{ kind: "status", level: "ok", message: "a" }],
      },
      {
        augmentName: "b",
        title: "Beta",
        sections: [{ kind: "status", level: "ok", message: "b" }],
      },
    ];
    const html = renderAdminPage({ card: card(), blocks, getCsrfToken: () => "tok" });
    const alphaIdx = html.indexOf("Alpha");
    const betaIdx = html.indexOf("Beta");
    expect(alphaIdx).toBeGreaterThan(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
  });
});

describe("admin-renderer — sections by kind", () => {
  it("keyValue: renders rows as <dl>", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Daily budget", value: "$30" },
            { label: "Used today", value: "$12", source: "yaml" },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("<dt>Daily budget</dt>");
    expect(html).toContain("$30");
    expect(html).toContain("yaml");
  });

  it("keyValue: escapes label + value", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "keyValue",
          rows: [{ label: "<bad>", value: "<also-bad>" }],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).not.toContain("<bad>");
    expect(html).toContain("&lt;bad&gt;");
  });

  it("table: renders header + body rows", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "table",
          columns: ["Peer", "Cost"],
          rows: [
            ["creator", "$8.20"],
            ["vis_abc", "$3.10"],
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("<th>Peer</th>");
    expect(html).toContain("<th>Cost</th>");
    expect(html).toContain("<td>creator</td>");
    expect(html).toContain("<td>$8.20</td>");
  });

  it("table: includes caption when provided", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "table",
          columns: ["c"],
          rows: [["v"]],
          caption: "Showing 1 of 1",
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("<caption>Showing 1 of 1</caption>");
  });

  it("status: renders with appropriate level class", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [{ kind: "status", level: "warn", message: "watch out" }],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("status-warn");
    expect(html).toContain("watch out");
  });

  it("eventStream: renders events as a table", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "eventStream",
          events: [
            {
              timestamp: "16:42:01",
              type: "budget.turn_admitted",
              summary: "creator $0.42",
            },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("16:42:01");
    expect(html).toContain("budget.turn_admitted");
    expect(html).toContain("creator $0.42");
  });
});

describe("admin-renderer — keyValue reset button (S6)", () => {
  it("renders reset button next to a keyValue row when resetAction is set", () => {
    const block: AdminInfoBlock = {
      augmentName: "budgets",
      title: "Budgets",
      sections: [
        {
          kind: "keyValue",
          rows: [
            {
              label: "Daily cap",
              value: "$30",
              source: "/admin override",
              resetAction: { id: "budget-cap-reset", label: "Reset to yaml" },
            },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok-x" });
    expect(html).toContain("budget-cap-reset");
    expect(html).toContain("Reset to yaml");
    expect(html).toContain('action="/admin/action/budget-cap-reset"');
    expect(html.indexOf("tok-x")).toBeGreaterThan(0);
  });

  it("does not render reset button when resetAction is absent", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "keyValue",
          rows: [{ label: "X", value: "Y" }],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).not.toContain("Reset to yaml");
    expect(html).not.toContain('class="reset-form"');
  });
});

describe("admin-renderer — actions + CSRF", () => {
  it("renders an augment-level action as a form with CSRF input", () => {
    const block: AdminInfoBlock = {
      augmentName: "notify",
      title: "Notify",
      sections: [],
      actions: [
        {
          id: "notify-test",
          label: "Send test notification",
          confirmRequired: false,
        },
      ],
    };
    const html = renderAdminPage({
      card: card(),
      blocks: [block],
      getCsrfToken: () => "csrf-tok-123",
    });
    expect(html).toContain('action="/admin/action/notify-test"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="_csrf"');
    expect(html).toContain('value="csrf-tok-123"');
    expect(html).toContain("Send test notification");
  });

  it("renders action inputs as form fields", () => {
    const block: AdminInfoBlock = {
      augmentName: "budgets",
      title: "Budgets",
      sections: [],
      actions: [
        {
          id: "budget-cap-adjust",
          label: "Adjust daily budget",
          confirmRequired: true,
          inputs: [{ name: "value", label: "USD", type: "number", required: true, default: "30" }],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain('name="value"');
    expect(html).toContain('type="number"');
    expect(html).toContain('value="30"');
    expect(html).toContain("required");
  });

  it("confirmRequired adds onsubmit confirm", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [],
      actions: [
        {
          id: "danger",
          label: "Dangerous Action",
          confirmRequired: true,
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).toContain("onsubmit=");
    expect(html).toContain("confirm(");
  });

  it("confirmRequired uses generic message (not interpolated action label) — M1 fix", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [],
      actions: [
        {
          id: "danger",
          label: "Bob's cap",
          confirmRequired: true,
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], getCsrfToken: () => "tok" });
    expect(html).not.toContain("Bob's cap?");
    expect(html).not.toContain("Bob&#39;s cap?");
    expect(html).toContain("Confirm this action?");
  });
});
