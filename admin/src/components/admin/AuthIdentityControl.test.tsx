import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AuthIdentityControl,
  VerifiedIdentityDetails,
} from "./AuthIdentityControl";
import type { VisitorIdentityState } from "@/lib/visitor-identity-api";

describe("AuthIdentityControl", () => {
  it("does not present a stored-but-unvalidated token as verified", () => {
    const html = renderControl({ status: "checking" });
    expect(html).toContain("Checking the verified visitor identity");
    expect(html).not.toContain("text-emerald-600");
    expect(html).toContain('aria-label="Forget local verified identity"');
    expect(html).toContain("[@media(hover:none)]:pointer-events-auto");
    expect(html).toContain("[@media(pointer:coarse)]:size-9");
    expect(html).not.toContain(
      'aria-label="Forget local verified identity" aria-hidden="true"',
    );
    expect(html).not.toContain("Clear visitor");
  });

  it.each([
    { status: "invalid", error: "Visitor credential was rejected." },
    { status: "unavailable", error: "Identity lookup is temporarily unavailable." },
  ] satisfies VisitorIdentityState[])(
    "keeps the clear action touch-visible and keyboard reachable while identity is $status",
    (identity) => {
      const html = renderControl(identity);
      expect(html).toContain('aria-label="Forget local verified identity"');
      expect(html).toContain("[@media(hover:none)]:opacity-100");
      expect(html).toContain("[@media(pointer:coarse)]:pointer-events-auto");
      expect(html).not.toContain('tabindex="-1"');
      expect(html).not.toContain(
        'aria-label="Forget local verified identity" aria-hidden="true"',
      );
    },
  );

  it("uses a non-color confirmation cue and a separate identity disclosure", () => {
    const html = renderControl({
      status: "verified",
      email: "visitor@example.com",
      expiresAt: 1_800_000_000_000,
    });
    expect(html).toContain("text-emerald-600");
    expect(html).toContain('aria-label="Show verified identity options"');
    expect(html).toContain("[@media(pointer:coarse)]:size-9");
    expect(html).toContain("[@media(pointer:coarse)]:hidden");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Forget local verified identity");
  });

  it("does not render a clear action without a stored visitor token", () => {
    const html = renderControl({ status: "absent" }, false);
    expect(html).not.toContain("Forget local verified identity");
    expect(html).not.toContain("Show verified identity options");
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
  identity: VisitorIdentityState,
  hasVisitorToken = true,
): string {
  return renderToStaticMarkup(
    <AuthIdentityControl
      previewMode="creator"
      anonymousAllowed
      hasVisitorToken={hasVisitorToken}
      visitorIdentity={identity}
      onPreviewModeChange={() => {}}
      onForgetVisitor={() => {}}
    />,
  );
}
