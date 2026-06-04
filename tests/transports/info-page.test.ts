import { describe, expect, it } from "bun:test";
import { renderAgentIntegrationPage, renderInfoPage } from "@/transports/info-page";
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

  it("shows the default backend-home heading and visible agent name", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<h1>This agent backend is online.</h1>");
    expect(html).toContain("zip is ready");
  });

  it("includes viewport meta tag", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
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

  it("omits the alternate agent-card link by default", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).not.toContain(
      '<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">',
    );
  });

  it("includes alternate link to /.well-known/agent-card.json when publicIntegration is enabled", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }), {
      publicIntegration: true,
    });
    expect(html).toContain(
      '<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">',
    );
  });

  it("includes meta description with purpose", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta name="description" content="concierge agent">');
  });

  it("includes purpose copy in body when purpose is non-empty", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<p class="purpose">concierge agent</p>');
  });
});

describe("renderAgentIntegrationPage", () => {
  it("renders public integration details and links the canonical agent card", () => {
    const html = renderAgentIntegrationPage(
      mockCard({ name: "zip", purpose: "concierge agent" }),
    );
    expect(html).toContain("<title>zip — integration</title>");
    expect(html).toContain("<h1>Integration details for zip.</h1>");
    expect(html).toContain("POST /agent/run");
    expect(html).toContain("AG-UI over HTTP");
    expect(html).toContain(
      '<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">',
    );
  });

  it("escapes public integration page fields", () => {
    const html = renderAgentIntegrationPage(
      mockCard({ name: "<script>alert(1)</script>", purpose: "Concierge <demo> & co" }),
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Concierge &lt;demo&gt; &amp; co");
  });
});

describe("renderInfoPage — fallbacks and edge cases", () => {
  it("falls back to 'An Auggy agent' when name is empty string", () => {
    const html = renderInfoPage(mockCard({ name: "", purpose: "x" }));
    expect(html).toContain("<title>An Auggy agent</title>");
    expect(html).toContain("An Auggy agent is ready");
    expect(html).toContain('<meta property="og:title" content="An Auggy agent">');
  });

  it("falls back to 'An Auggy agent' when name is whitespace-only", () => {
    const html = renderInfoPage(mockCard({ name: "   \t\n", purpose: "x" }));
    expect(html).toContain("<title>An Auggy agent</title>");
    expect(html).toContain("An Auggy agent is ready");
  });

  it("omits the body purpose paragraph when purpose is undefined", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: undefined }));
    expect(html).not.toContain("<p></p>");
    expect(html).toContain('<meta name="description" content="">');
  });

  it("omits the body purpose paragraph when purpose is empty string", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "" }));
    expect(html).not.toContain("<p></p>");
    expect(html).toContain('<meta name="description" content="">');
  });

  it("omits the body purpose paragraph when purpose is whitespace-only", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "   \t\n" }));
    expect(html).not.toContain("<p></p>");
    expect(html).toContain('<meta name="description" content="">');
  });

  it("includes + escapes purpose when purpose contains HTML metacharacters", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "Concierge <demo> & co" }));
    expect(html).toContain('<p class="purpose">Concierge &lt;demo&gt; &amp; co</p>');
    expect(html).toContain('<meta name="description" content="Concierge &lt;demo&gt; &amp; co">');
  });
});
