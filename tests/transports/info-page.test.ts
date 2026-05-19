import { describe, expect, it } from "bun:test";
import { renderInfoPage } from "@/transports/info-page";
import type { AgentCard } from "@/types";

function mockCard(overrides: { name?: string; purpose?: string } = {}): AgentCard {
  return {
    provider: { name: overrides.name ?? "zip" },
    purpose: overrides.purpose,
    capabilities: { streaming: false, pushNotifications: false, memory: false, transport: true },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
}

describe("renderInfoPage — HTML escaping", () => {
  it("escapes <script> tags in agent name (no raw <script> substring remains)", () => {
    const html = renderInfoPage(mockCard({ name: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersand and double-quote", () => {
    const html = renderInfoPage(mockCard({ name: 'Bob & "official"' }));
    expect(html).toContain("Bob &amp; &quot;official&quot;");
  });

  it("escapes single quote (apostrophe)", () => {
    const html = renderInfoPage(mockCard({ name: "Alice's agent" }));
    expect(html).toContain("Alice&#39;s agent");
  });
});
