import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { selectBrowserConnection } from "@/lib/integration-guidance";
import type { WebDashboardState } from "@/lib/types";
import { BrowserIntegrationPanel } from "./BrowserIntegrationPanel";

function posture(patch: Partial<WebDashboardState> = {}): WebDashboardState {
  return {
    allowAnonymous: { value: false },
    publicIntegration: { value: false },
    trustedProxies: [],
    corsOrigins: [],
    visitorTokensEnabled: false,
    externalAuthEnabled: false,
    ...patch,
  };
}

function renderBrowser(web: WebDashboardState): string {
  return renderToStaticMarkup(
    <BrowserIntegrationPanel
      agentName="demo"
      guidance={selectBrowserConnection("https://agent.example", web)}
      web={web}
      routes={[]}
      copied={null}
      onCopy={() => undefined}
    />,
  );
}

describe("BrowserIntegrationPanel", () => {
  it("renders a bearer-free external-auth integration with an explicit server handshake", () => {
    const html = renderBrowser(
      posture({
        externalAuthEnabled: true,
        externalAuthHeader: "x-product-identity",
        corsOrigins: ["https://app.example"],
      }),
    );

    expect(html).toContain("Browser application");
    expect(html).toContain("getAuggyAuthAssertion");
    expect(html).toContain("x-product-identity");
    expect(html).toContain("Configured origins: https://app.example");
    expect(html).not.toContain("Authorization:");
    expect(html).not.toContain("Bearer &lt;");
    expect(html).not.toContain("x-visitor-token");
  });

  it("explains visitor bootstrap, rotation, storage, and same-origin limitations", () => {
    const html = renderBrowser(
      posture({ allowAnonymous: { value: true }, visitorTokensEnabled: true }),
    );

    expect(html).toContain("Same-origin only");
    expect(html).toContain("bootstrap");
    expect(html).toContain("x-visitor-token");
    expect(html).toContain("rotated visitor token");
    expect(html).toContain("share an origin");
  });

  it("fails closed without rendering a runnable browser conversation example", () => {
    const html = renderBrowser(
      posture({ allowAnonymous: { value: false }, visitorTokensEnabled: true }),
    );

    expect(html).toContain("Setup required");
    expect(html).toContain("Do not use the creator bearer as");
    expect(html).not.toContain("Copy Browser TypeScript example");
    expect(html).not.toContain("fetch(&quot;https://agent.example/agent/run&quot;");
  });
});
