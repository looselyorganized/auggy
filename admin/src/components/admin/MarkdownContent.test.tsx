import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent";

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(<MarkdownContent content={content} />);
}

describe("MarkdownContent", () => {
  it("renders GFM tables, task lists, strikethrough, and fenced code", () => {
    const html = renderMarkdown(
      [
        "| Capability | State |",
        "| --- | --- |",
        "| memory | ~~disabled~~ enabled |",
        "",
        "- [x] route mounted",
        "- [ ] auth reviewed",
        "",
        "```ts",
        "const ok = true;",
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<table");
    expect(html).toContain("<del>disabled</del>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked=\"\"");
    expect(html).toContain("const ok = true;");
    expect(html).toContain('data-language="ts"');
  });

  it("does not render raw HTML or Markdown images", () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script><img src="https://example.com/x.png" onerror="alert(1)">',
        "![architecture](https://example.com/architecture.png)",
      ].join("\n"),
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).toContain("[image: architecture]");
  });

  it("blocks unsafe link protocols while keeping safe links", () => {
    const html = renderMarkdown(
      "[unsafe](javascript:alert(1)) [safe](https://example.com/docs) [relative](/agent)",
    );

    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('href="/agent"');
  });
});
