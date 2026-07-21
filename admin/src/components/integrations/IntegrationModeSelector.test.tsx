import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  DEFAULT_INTEGRATION_MODE,
  IntegrationModeSelector,
  type IntegrationMode,
} from "./IntegrationModeSelector";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("IntegrationModeSelector", () => {
  it("defaults to Browser and exposes all modes in product order", () => {
    expect(DEFAULT_INTEGRATION_MODE).toBe("browser");
    const html = renderToStaticMarkup(
      <IntegrationModeSelector value={DEFAULT_INTEGRATION_MODE} onChange={() => undefined} />,
    );

    expect(html.indexOf("Browser application")).toBeLessThan(html.indexOf("Server application"));
    expect(html.indexOf("Server application")).toBeLessThan(html.indexOf("Agent-to-agent"));
    expect(html).toContain('id="integration-mode-browser"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Coming soon");
  });

  it("emits the selected mode from native tab buttons", async () => {
    const changes: IntegrationMode[] = [];
    await act(async () => {
      renderer = create(
        <IntegrationModeSelector value="browser" onChange={(mode) => changes.push(mode)} />,
      );
    });

    const server = renderer?.root
      .findAll((node) => node.props.role === "tab")
      .find((node) => node.props.id === "integration-mode-server");
    expect(server).toBeDefined();
    await act(async () => server?.props.onClick());
    expect(changes).toEqual(["server"]);
  });
});
