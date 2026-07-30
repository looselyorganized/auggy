import { describe, expect, it } from "bun:test";
import type { DashboardData } from "@/lib/types";
import { buildRuntimeEndpointRows, selectAgentMailInboxEmail } from "./Header";

describe("selectAgentMailInboxEmail", () => {
  it("selects the exact Inbox email row from the AgentMail block", () => {
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
      {
        augmentName: "agent-mail",
        title: "AgentMail",
        sections: [
          { kind: "status", level: "ok", message: "Ready" },
          {
            kind: "keyValue",
            rows: [
              { label: "Inbox ID", value: "inbox_123" },
              { label: "Inbox email", value: " hello@agentmail.to " },
            ],
          },
        ],
      },
    ];

    expect(selectAgentMailInboxEmail(blocks)).toBe("hello@agentmail.to");
  });

  it("omits absent, blank, unavailable, and non-exact labels", () => {
    const blocks: DashboardData["blocks"] = [
      {
        augmentName: "agent-mail",
        title: "AgentMail",
        sections: [
          {
            kind: "keyValue",
            rows: [
              { label: "Inbox Email", value: "case-mismatch@example.com" },
              { label: "Inbox email", value: "   " },
              { label: "Inbox email", value: "(unavailable — run AgentMail setup)" },
            ],
          },
        ],
      },
    ];

    expect(selectAgentMailInboxEmail(blocks)).toBeUndefined();
    expect(selectAgentMailInboxEmail([])).toBeUndefined();
  });

  it("renders every distinct AgentMail inbox address without singular ambiguity", () => {
    const blocks: DashboardData["blocks"] = ["one@example.com", "two@example.com", "one@example.com"].map(
      (value) => ({
        augmentName: "agent-mail",
        title: "AgentMail",
        sections: [{ kind: "keyValue", rows: [{ label: "Inbox email", value }] }],
      }),
    );

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
