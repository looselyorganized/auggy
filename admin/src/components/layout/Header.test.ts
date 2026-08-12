import { describe, expect, it } from "bun:test";
import type { AdminInfoBlock, DashboardData } from "@/lib/types";
import { buildRuntimeEndpointRows, selectAgentMailInboxEmail } from "./Header";

describe("selectAgentMailInboxEmail", () => {
  it("selects inbox email only from the provider-native Mail projection", () => {
    const blocks: DashboardData["blocks"] = [
      {
        augmentName: "other",
        title: "Other",
        sections: [
          {
            kind: "keyValue",
            rows: [{ label: "Inbox email", value: "wrong@example.com" }],
          },
        ],
      },
      mailBlock("support", " hello@agentmail.to "),
    ];

    expect(selectAgentMailInboxEmail(blocks)).toBe("hello@agentmail.to");
  });

  it("ignores generic legacy rows and invalid projected addresses", () => {
    const blocks: DashboardData["blocks"] = [
      {
        augmentName: "agent-mail",
        title: "AgentMail",
        sections: [
          {
            kind: "keyValue",
            rows: [{ label: "Inbox email", value: "legacy@example.com" }],
          },
        ],
      },
      mailBlock("invalid", "(unavailable)"),
    ];

    expect(selectAgentMailInboxEmail(blocks)).toBeUndefined();
    expect(selectAgentMailInboxEmail([])).toBeUndefined();
  });

  it("renders every distinct mounted inbox without singular ambiguity", () => {
    const blocks: DashboardData["blocks"] = [
      mailBlock("support", "one@example.com"),
      mailBlock("billing", "two@example.com"),
      mailBlock("duplicate", "one@example.com"),
    ];

    expect(selectAgentMailInboxEmail(blocks)).toBe("one@example.com, two@example.com");
  });
});

describe("buildRuntimeEndpointRows", () => {
  it("keeps runtime and health details without promoting a legacy agent card", () => {
    const rows = buildRuntimeEndpointRows("https://agent.example");

    expect(rows).toEqual([
      ["Runtime URL", "https://agent.example"],
      ["Health", "https://agent.example/health"],
    ]);
    expect(rows.map(([label]) => label)).not.toContain("Agent card");
  });

  it("uses explicit unknown values when rendered without a browser origin", () => {
    expect(buildRuntimeEndpointRows("")).toEqual([
      ["Runtime URL", "unknown"],
      ["Health", "unknown"],
    ]);
  });
});

function mailBlock(augmentName: string, inboxEmail: string): AdminInfoBlock {
  return {
    augmentName,
    title: "AgentMail",
    sections: [],
    projection: {
      kind: "mail",
      augmentName,
      inboxId: "inbox_" + augmentName,
      inboxEmail,
      status: { level: "ok", message: "Ready" },
      inbound: {
        mode: "none",
        state: "idle",
        senderPolicy: "disabled",
        allowedSenderCount: 0,
      },
      replies: { mode: "disabled", allowReplyAll: false },
      drafts: [],
    },
  };
}
