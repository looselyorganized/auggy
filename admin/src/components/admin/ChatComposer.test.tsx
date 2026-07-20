import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatComposer } from "./ChatComposer";

const baseProps = {
  value: "",
  onChange: () => {},
  onSend: () => {},
  streaming: false,
  onStop: () => {},
  agentName: "Auggie",
  modelDisplayName: "mock",
  modelRawName: "demo / mock",
};

describe("ChatComposer", () => {
  it("keeps the idle composer minimal while exposing model details", () => {
    const html = renderToStaticMarkup(<ChatComposer {...baseProps} />);

    expect(html).toContain("Message Auggie");
    expect(html).toContain("mock");
    expect(html).not.toContain("Enter to send");
    expect(html).not.toContain("Shift+Enter");
    expect(html).not.toContain("Send");
    expect(html).not.toContain("Stop response");
  });

  it("shows Stop only for the thread that owns a stream", () => {
    const html = renderToStaticMarkup(<ChatComposer {...baseProps} streaming />);

    expect(html).toContain('aria-label="Stop response"');
    expect(html).toContain("Auggie is responding.");
    expect(html).toContain("disabled");
  });

  it("announces why an inactive composer is disabled", () => {
    const html = renderToStaticMarkup(
      <ChatComposer {...baseProps} disabled disabledReason="A response is running elsewhere." />,
    );

    expect(html).toContain("A response is running elsewhere.");
    expect(html).toContain("aria-describedby");
  });
});
