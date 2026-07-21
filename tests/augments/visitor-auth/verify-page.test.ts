import { describe, test, expect } from "bun:test";
import {
  buildVerifySuccessPage,
  buildVerifyFailurePage,
} from "../../../src/augments/visitorAuth/verify-page";

describe("buildVerifySuccessPage", () => {
  const successPage = (visitorToken: string, email = "alice@example.com") =>
    buildVerifySuccessPage({ visitorToken, email, threadId: "origin-thread" });

  test("includes no-referrer meta tag", () => {
    const html = successPage("tok.sig");
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  test("contains zero external assets (no <link>, no <script src>, no <img src>)", () => {
    const html = successPage("tok.sig");
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<img[^>]+src=/i);
    expect(html).not.toMatch(/url\((?!data:)/i); // no css url() except data:
  });

  test("calls history.replaceState to drop the token from the URL", () => {
    const html = successPage("tok.sig");
    expect(html).toContain("history.replaceState");
    // Must use a relative path so it resolves correctly under subpath deployments.
    // The current location during verify is <publicUrl>/visitor-auth/verify?token=...
    // so "./verified" resolves to <publicUrl>/visitor-auth/verified regardless of prefix.
    expect(html).toContain("'./verified'");
    // Must NOT use the old root-relative hardcoded path.
    expect(html).not.toContain("'/visitor-auth/verified'");
  });

  test("calls localStorage.setItem with the visitor token", () => {
    const html = successPage("tok.sig");
    expect(html).toContain("localStorage.setItem");
    expect(html).toContain("auggy-visitor-token");
    expect(html).toContain("tok.sig");
  });

  test("stores and broadcasts an exact originating-thread promotion intent", () => {
    const html = successPage("tok.sig");
    expect(html).toContain("auggy-visitor-promotion-intent");
    expect(html).toContain("visitor-auth.verified");
    expect(html).toContain("origin-thread");
    expect(html).toContain("tokenTag: tokenTag");
    expect(html).toContain("new BroadcastChannel('auggy-visitor-auth')");
    expect(html).toContain("channel.postMessage");
    expect(html).toContain("channel.postMessage({ type: promotionIntent.type, version: 1 })");
    expect(html).not.toContain(
      "channel.postMessage({ type: promotionIntent.type, version: 1, threadId",
    );
  });

  test("JSON-encodes the originating thread identifier", () => {
    const html = buildVerifySuccessPage({
      visitorToken: "tok.sig",
      email: "a@x.com",
      threadId: "origin</script><script>alert(1)</script>",
    });
    const insideOurScript = html.match(/<script>([\s\S]*?)<\/script>/i);
    expect(insideOurScript).not.toBeNull();
    expect(insideOurScript?.[1]).not.toMatch(/<\/script>/i);
  });

  test("token value is JSON-encoded (escapes quote, backslash, newline)", () => {
    const tricky = `weird"\\<>&\n`;
    const html = successPage(tricky, "a@x.com");
    // The injected token must NOT close the script tag or the string literal.
    expect(html).not.toMatch(/localStorage\.setItem\([^)]*"\s*"/); // no premature quote close
    expect(html).toContain("\\n"); // newline must be escaped
    // </script> must not appear inside the JSON-embedded token even if the
    // attacker-controlled value contained "</script>".
  });

  test("escapes </script> sequences in the token", () => {
    const evil = "abc</script><script>alert(1)</script>";
    const html = successPage(evil, "a@x.com");
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
      threadId: "origin-thread",
    });
    // The email is shown as innerText only — no raw HTML rendering.
    // We should NOT see the raw `<script>` from the email substring rendered as a tag.
    expect(html).not.toContain("alice<script>");
  });

  test("contains a human-readable success message", () => {
    const html = successPage("t.s", "a@x.com");
    expect(html.toLowerCase()).toMatch(/verified|success/);
    expect(html).toContain("return to the originating console chat");
    expect(html).toContain("picked up automatically when you continue");
    expect(html).toContain("If the chat does not update, refresh it.");
    expect(html).toContain("open the console there to use this identity");
    expect(html).not.toContain("choose Verified visitor");
    expect(html).not.toContain("switch to Verified");
  });

  test("gives an accurate fallback when JavaScript cannot apply the identity", () => {
    const html = successPage("t.s", "a@x.com");
    expect(html).toContain("JavaScript is required to apply the verified identity automatically");
    expect(html).toContain("request a new verification link from the originating chat");
    expect(html).toContain("storage and JavaScript enabled");
    expect(html).not.toContain("Copy this token manually");
    expect(html).not.toContain('id="manual-token"');
    expect(html).not.toContain("re-open your chat tab manually");
  });

  // F8: localStorage failure detection
  test("contains both success-path and storage-fallback branches in JS (F8)", () => {
    const html = successPage("vis_tok.sig", "a@x.com");
    // storageWorks conditional must be present
    expect(html).toContain("storageWorks");
    // Both branches are represented in the rendered HTML
    expect(html.toLowerCase()).toMatch(/storage.*(blocked|denied|fallback)|fallback.*storage/);
    // The fallback offers only supported recovery actions; there is no token-paste UI.
    expect(html).not.toContain("manual-token");
  });

  test("storage-fallback element is present but hidden by default (F8)", () => {
    const html = successPage("t.s", "a@x.com");
    // The fallback paragraph is in the DOM with display:none so JS can reveal it
    expect(html).toMatch(/id="storage-fallback"[^>]*style="display:none"/);
  });

  test("storage fallback does not expose the bearer token for an unsupported manual flow", () => {
    const html = successPage("t.s", "a@x.com");
    expect(html).not.toContain("manualEl");
    expect(html).not.toContain("Copy this token");
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
