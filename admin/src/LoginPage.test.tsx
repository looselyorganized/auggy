import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LOGIN_ERROR_MESSAGES, LOGIN_VARIANTS, LoginPage, type LoginVariant } from "./LoginPage";

function renderLoginPage(variant: LoginVariant = "default") {
  return renderToStaticMarkup(<LoginPage variant={variant} />);
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

describe("LoginPage", () => {
  it("composes the Auggy registry Card, Input, and Button primitives", () => {
    const html = renderLoginPage();

    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-slot="input"');
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("border-muted-foreground!");
    expect(html).toContain("aria-invalid:border-brand-signal!");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("forced-colors:focus-visible:outline-[Highlight]");
    expect(html).toContain("Creator Console");
    expect(html).toContain("Welcome back.");
    expect(html).toContain("AUGGY_WEB_TOKEN");
    expect(html).toContain("auggy console &lt;agent&gt;");
  });

  it("exposes one level-one heading without naming a generic brand container", () => {
    const html = renderLoginPage();
    const nativeHeadings = html.match(/<h[1-6]\b[^>]*>/g) ?? [];
    const roleHeadings = html.match(/<[^>]+role="heading"[^>]*>/g) ?? [];

    expect([...nativeHeadings, ...roleHeadings]).toHaveLength(1);
    expect(roleHeadings).toHaveLength(1);
    expect(roleHeadings[0]).toContain('aria-level="1"');
    expect(html).not.toContain('aria-label="Auggy"');
  });

  it("uses a complete native password form without a runtime-computed action", () => {
    const html = renderLoginPage();
    const form = html.match(/<form\b[^>]*>/)?.[0];

    expect(form).toBeDefined();
    expect(form).toContain('method="post"');
    expect(form).not.toMatch(/\saction=/);
    expect(countMatches(html, /<form\b/g)).toBe(1);
    expect(html).toContain('<label for="password"');
    expect(html).toContain('id="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('autofocus=""');
    expect(html).toContain('required=""');
    expect(html).not.toMatch(/\svalue=/);
  });

  it("renders the default variant without an error alert", () => {
    const html = renderLoginPage("default");

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid="true"');
    for (const message of Object.values(LOGIN_ERROR_MESSAGES)) {
      expect(html).not.toContain(message);
    }
  });

  it.each([
    ["invalid-password", LOGIN_ERROR_MESSAGES["invalid-password"]!],
    ["invalid-ticket", LOGIN_ERROR_MESSAGES["invalid-ticket"]!],
  ] as const)("renders the %s variant as one fixed accessible alert", (variant, message) => {
    const html = renderLoginPage(variant);

    expect(countMatches(html, /role="alert"/g)).toBe(1);
    expect(html).toContain(message);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="login-error"');
    expect(html).toContain('id="login-error"');
    expect(html).not.toMatch(/\svalue=/);
    for (const otherMessage of Object.values(LOGIN_ERROR_MESSAGES)) {
      expect(html.includes(otherMessage)).toBe(otherMessage === message);
    }
  });

  it("keeps the generated variant inventory explicit and exhaustive", () => {
    expect(LOGIN_VARIANTS).toEqual(["default", "invalid-password", "invalid-ticket"]);
  });
});
