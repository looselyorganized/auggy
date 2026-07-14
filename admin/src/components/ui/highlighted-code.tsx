import { useEffect, useState } from "react";
import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { cn } from "@/lib/utils";

const LANGUAGES = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  http: () => import("@shikijs/langs/http"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};

const THEMES = {
  "github-dark-dimmed": () => import("@shikijs/themes/github-dark-dimmed"),
};

const { codeToHtml } = createSingletonShorthands(
  createBundledHighlighter({
    langs: LANGUAGES,
    themes: THEMES,
    engine: () => createJavaScriptRegexEngine(),
  }),
);

const supportedLanguages = new Set<string>(Object.keys(LANGUAGES));

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  curl: "bash",
  env: "dotenv",
  js: "javascript",
  json5: "json",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};

function normalizeLanguage(language: string | undefined) {
  const normalized = language?.trim().toLowerCase() || "text";
  const aliased = LANGUAGE_ALIASES[normalized] ?? normalized;
  return supportedLanguages.has(aliased) ? (aliased as keyof typeof LANGUAGES) : "text";
}

export function detectCodeLanguage(value: string | undefined) {
  if (!value?.trim()) return "text";

  try {
    JSON.parse(value);
    return "json";
  } catch {
    return "text";
  }
}

export function HighlightedCode({
  code,
  language,
  wrap = false,
  compact = false,
  className,
}: {
  code: string;
  language?: string;
  wrap?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setHtml(null);

    void codeToHtml(code, {
      lang: normalizeLanguage(language),
      theme: "github-dark-dimmed",
    })
      .then((highlighted) => {
        if (current) setHtml(highlighted);
      })
      .catch(() => {
        // Unknown language identifiers retain the escaped plain-text fallback.
      });

    return () => {
      current = false;
    };
  }, [code, language]);

  return (
    <div
      data-language={language || undefined}
      className={cn(
        "console-code overflow-auto bg-[#0d1117] text-xs leading-6 text-slate-50",
        wrap && "console-code-wrap",
        compact && "console-code-compact",
        className,
      )}
    >
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
