import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { detectCodeLanguage, HighlightedCode } from "./highlighted-code";

describe("HighlightedCode", () => {
  it("renders an escaped fallback before the async highlighter loads", () => {
    const html = renderToStaticMarkup(
      <HighlightedCode code={'<script>alert("x")</script>'} language="html" />,
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('data-language="html"');
  });

  it("detects JSON tool payloads without guessing other formats", () => {
    expect(detectCodeLanguage('{"ok":true}')).toBe("json");
    expect(detectCodeLanguage("plain output")).toBe("text");
    expect(detectCodeLanguage(undefined)).toBe("text");
  });
});
