import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AuthIdentityControl,
  VerifiedIdentityDetails,
} from "./AuthIdentityControl";

describe("AuthIdentityControl", () => {
  it("does not present a stored-but-unvalidated token as verified", () => {
    const html = renderControl({ status: "checking" });
    expect(html).toContain("Checking the verified visitor identity");
    expect(html).not.toContain("text-emerald-600");
    expect(html).toContain('aria-label="Forget local verified identity"');
    expect(html).not.toContain("Clear visitor");
  });

  it("uses a non-color confirmation cue and a separate identity disclosure", () => {
    const html = renderControl({
      status: "verified",
      email: "visitor@example.com",
      expiresAt: 1_800_000_000_000,
    });
    expect(html).toContain("text-emerald-600");
    expect(html).toContain('aria-label="Show available verified identity"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Forget local verified identity");
  });

  it("shows the registered email only in the identity detail content", () => {
    const html = renderToStaticMarkup(
      <VerifiedIdentityDetails
        identity={{
          status: "verified",
          email: "visitor@example.com",
          expiresAt: 1_800_000_000_000,
        }}
      />,
    );
    expect(html).toContain("Available verified identity");
    expect(html).toContain("visitor@example.com");
  });
});

function renderControl(
  identity:
    | { status: "checking" }
    | { status: "verified"; email: string; expiresAt: number },
): string {
  return renderToStaticMarkup(
    <AuthIdentityControl
      previewMode="creator"
      anonymousAllowed
      hasVisitorToken
      visitorIdentity={identity}
      onPreviewModeChange={() => {}}
      onForgetVisitor={() => {}}
    />,
  );
}
