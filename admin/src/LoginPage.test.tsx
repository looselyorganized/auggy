import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginPage } from "./LoginPage";

describe("LoginPage", () => {
  it("uses the Auggy registry surface for the Console password flow", () => {
    const html = renderToStaticMarkup(
      <LoginPage action="/console/login?next=%2Fconsole%2Fchat" />,
    );

    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-slot="input"');
    expect(html).toContain('data-slot="button"');
    expect(html).toContain("Creator Console");
    expect(html).toContain("Welcome back.");
    expect(html).toContain("AUGGY_WEB_TOKEN");
    expect(html).toContain("auggy console &lt;agent&gt;");
    expect(html).toContain('action="/console/login?next=%2Fconsole%2Fchat"');
  });

  it("renders authentication failures as an accessible alert", () => {
    const html = renderToStaticMarkup(
      <LoginPage action="/console/login" error="Invalid console password." />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Invalid console password.");
    expect(html).toContain('aria-invalid="true"');
  });
});
