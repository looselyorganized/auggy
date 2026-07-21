import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Button } from "@/components/ui/button";
import { AgentIntegrationPanel } from "./AgentIntegrationPanel";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("AgentIntegrationPanel", () => {
  it("describes the unavailable standards-compatible flow without active discovery links", () => {
    const html = renderToStaticMarkup(
      <AgentIntegrationPanel legacyDiscoveryPublic={false} onMakePrivate={() => undefined} />,
    );

    expect(html).toContain("Agent-to-agent");
    expect(html).toContain("Coming soon");
    expect(html).toContain("does not yet provide a production");
    expect(html).toContain("Standards-compliant, sanitized Agent Card");
    expect(html).toContain("Authenticated peer discovery and task exchange");
    expect(html).toContain("Scoped permissions, budgets, and audit trails");
    expect(html).toContain("Legacy developer discovery is private");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("/.well-known/");
    expect(html).not.toContain("/agent\"");
  });

  it("offers only a disable action when legacy discovery is public", async () => {
    let calls = 0;
    await act(async () => {
      renderer = create(
        <AgentIntegrationPanel
          legacyDiscoveryPublic
          onMakePrivate={() => {
            calls += 1;
          }}
        />,
      );
    });

    const buttons = renderer?.root.findAllByType(Button) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.children).toContain("Make legacy discovery private");

    await act(async () => buttons[0]?.props.onClick());
    expect(calls).toBe(1);
  });

  it("announces the public legacy state as an alert and prevents repeat actions while busy", () => {
    const html = renderToStaticMarkup(
      <AgentIntegrationPanel
        legacyDiscoveryPublic
        disabling
        onMakePrivate={() => undefined}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Legacy developer discovery is currently public");
    expect(html).toContain("not a standards-compatible A2A connection");
    expect(html).toContain("Making private…");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Publish");
    expect(html).not.toContain("Enable");
  });
});
