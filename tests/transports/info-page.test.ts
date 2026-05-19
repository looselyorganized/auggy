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

describe("renderInfoPage — HTML structure", () => {
  it("returns a valid HTML document", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</html>");
  });

  it("title is `<name> — Auggy agent`", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<title>zip — Auggy agent</title>");
  });

  it("h1 is the agent name", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<h1>zip</h1>");
  });

  it("includes viewport meta tag", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it("includes noindex robots meta tag (crawler suppression)", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("includes Open Graph tags with name + purpose", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta property="og:title" content="zip — Auggy agent">');
    expect(html).toContain('<meta property="og:description" content="concierge agent">');
    expect(html).toContain('<meta property="og:type" content="website">');
  });

  it("includes alternate link to /.well-known/agent-card.json", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain(
      '<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">',
    );
  });

  it("includes meta description with purpose", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta name="description" content="concierge agent">');
  });

  it("includes purpose paragraph in body when purpose is non-empty", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<p>concierge agent</p>");
  });
});
