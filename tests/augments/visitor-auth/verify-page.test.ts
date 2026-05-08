import { describe, test, expect } from "bun:test";
import {
  buildVerifySuccessPage,
  buildVerifyFailurePage,
} from "../../../src/augments/visitor-auth/verify-page";

describe("buildVerifySuccessPage", () => {
  test("includes no-referrer meta tag", () => {
    const html = buildVerifySuccessPage({ visitorToken: "tok.sig", email: "alice@example.com" });
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  test("contains zero external assets (no <link>, no <script src>, no <img src>)", () => {
    const html = buildVerifySuccessPage({ visitorToken: "tok.sig", email: "alice@example.com" });
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<img[^>]+src=/i);
    expect(html).not.toMatch(/url\((?!data:)/i); // no css url() except data:
  });

  test("calls history.replaceState to drop the token from the URL", () => {
    const html = buildVerifySuccessPage({ visitorToken: "tok.sig", email: "alice@example.com" });
    expect(html).toContain("history.replaceState");
    // Must use a relative path so it resolves correctly under subpath deployments.
    // The current location during verify is <publicUrl>/visitor-auth/verify?token=...
    // so "./verified" resolves to <publicUrl>/visitor-auth/verified regardless of prefix.
    expect(html).toContain("'./verified'");
    // Must NOT use the old root-relative hardcoded path.
    expect(html).not.toContain("'/visitor-auth/verified'");
  });

  test("calls localStorage.setItem with the visitor token", () => {
    const html = buildVerifySuccessPage({ visitorToken: "tok.sig", email: "alice@example.com" });
    expect(html).toContain("localStorage.setItem");
    expect(html).toContain("auggy-visitor-token");
    expect(html).toContain("tok.sig");
  });

  test("token value is JSON-encoded (escapes quote, backslash, newline)", () => {
    const tricky = `weird"\\<>&\n`;
    const html = buildVerifySuccessPage({ visitorToken: tricky, email: "a@x.com" });
    // The injected token must NOT close the script tag or the string literal.
    expect(html).not.toMatch(/localStorage\.setItem\([^)]*"\s*"/); // no premature quote close
    expect(html).toContain("\\n"); // newline must be escaped
    // </script> must not appear inside the JSON-embedded token even if the
    // attacker-controlled value contained "</script>".
  });

  test("escapes </script> sequences in the token", () => {
    const evil = "abc</script><script>alert(1)</script>";
    const html = buildVerifySuccessPage({ visitorToken: evil, email: "a@x.com" });
    // The evil </script> must NOT terminate our script block. We escape via
    // Unicode `<\/script>` substitution or JSON-encode the slash.
    // Case-insensitive: HTML tag matching MUST be case-insensitive (an
    // attacker injecting `<SCRIPT>` would terminate the block too) — both
    // for what we expect inside our script block and for the negative
    // assertion about `</script>` sequences leaking through.
    const insideOurScript = html.match(/<script>([\s\S]*?)<\/script>/i);
    expect(insideOurScript).not.toBeNull();
    expect(insideOurScript?.[1]).not.toMatch(/<\/script>/i);
  });

  test("HTML-escapes the email when displayed", () => {
    const html = buildVerifySuccessPage({
      visitorToken: "t.s",
      email: "alice<script>x</script>@x.com",
    });
    // The email is shown as innerText only — no raw HTML rendering.
    // We should NOT see the raw `<script>` from the email substring rendered as a tag.
    expect(html).not.toContain("alice<script>");
  });

  test("contains a human-readable success message", () => {
    const html = buildVerifySuccessPage({ visitorToken: "t.s", email: "a@x.com" });
    expect(html.toLowerCase()).toMatch(/verified|success/);
  });
});

describe("buildVerifyFailurePage", () => {
  test("renders the failure reason", () => {
    const html = buildVerifyFailurePage({ reason: "expired" });
    expect(html.toLowerCase()).toContain("expired");
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  test("does not include localStorage logic on failure", () => {
    const html = buildVerifyFailurePage({ reason: "expired" });
    expect(html).not.toContain("localStorage.setItem");
  });

  test("HTML-escapes the failure reason", () => {
    const html = buildVerifyFailurePage({ reason: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
