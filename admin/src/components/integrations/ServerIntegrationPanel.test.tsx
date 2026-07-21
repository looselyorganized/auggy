import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CodeExample } from "@/components/integrations/IntegrationPrimitives";
import { selectServerConnection } from "@/lib/integration-guidance";
import type { RouteManifestEntry } from "@/lib/types";
import { ServerIntegrationPanel } from "./ServerIntegrationPanel";

const SECRET_SENTINEL = "must-not-render";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

function route(path: string, auth: RouteManifestEntry["auth"]): RouteManifestEntry {
  return {
    method: "POST",
    path,
    augmentName: "orders",
    auth,
    params: [],
    public: auth === "none",
    security: auth === "none" ? "public" : "private",
  };
}

function panel() {
  return (
    <ServerIntegrationPanel
      agentName="demo"
      guidance={selectServerConnection("https://agent.example")}
      routes={[
        route("/orders/status", "none"),
        route("/orders/update", "creator"),
        route("/visitor/profile", "visitor.required"),
        route("/peer/handoff", "agent.required"),
      ]}
      copied={null}
      onCopy={() => undefined}
    />
  );
}

describe("ServerIntegrationPanel", () => {
  it("renders a server-only connection contract without embedding a credential", () => {
    const html = renderToStaticMarkup(panel());

    expect(html).toContain("Server application");
    expect(html).toContain("Trusted runtime");
    expect(html).toContain("grants creator-level authority");
    expect(html).toContain("never ship it to a browser, mobile app, client bundle, or public");
    expect(html).toContain("https://agent.example");
    expect(html).toContain("POST /agent/run");
    expect(html).toContain("GET /health");
    expect(html).toContain("AG-UI over SSE");
    expect(html).toContain("process.env.AUGGY_WEB_TOKEN");
    expect(html).toContain("threadId: string");
    expect(html).not.toContain(SECRET_SENTINEL);
    expect(html).not.toContain("Bearer &lt;token&gt;");
  });

  it("exposes accessible TypeScript and cURL example tabs", () => {
    const html = renderToStaticMarkup(panel());

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Server conversation example"');
    expect(html).toContain('role="tab"');
    expect(html).toContain("TypeScript");
    expect(html).toContain("cURL");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="server-example-typescript"');
  });

  it("switches the runnable conversation example to cURL", async () => {
    await act(async () => {
      renderer = create(panel());
    });

    const curlTab = renderer?.root
      .findAll((node) => node.props.role === "tab")
      .find((node) => node.props.id === "server-example-curl");
    expect(curlTab).toBeDefined();

    await act(async () => curlTab?.props.onClick());
    const example = renderer?.root
      .findAllByType(CodeExample)
      .find((node) => node.props.id === "server-conversation");
    expect(example?.props.label).toBe("Server cURL example");
    expect(example?.props.value).toContain("curl --fail-with-body --silent --show-error -N");
    expect(example?.props.value).toContain("$AUGGY_WEB_TOKEN");
    expect(example?.props.value).not.toContain("process.env.AUGGY_WEB_TOKEN");
  });

  it("shows only server-callable app routes and labels artifacts as route-only", () => {
    const html = renderToStaticMarkup(panel());

    expect(html).toContain("/orders/status");
    expect(html).toContain("/orders/update");
    expect(html).not.toContain("/visitor/profile");
    expect(html).not.toContain("/peer/handoff");
    expect(html).toContain("These artifacts do not");
    expect(html).toContain("include the streaming");
    expect(html).toContain("require their own specialized credentials");
    expect(html).toContain("--target server");
    expect(html).toContain("--openapi");
    expect(html).toContain("--json");
  });
});
