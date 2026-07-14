import { isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "@/components/ui/highlighted-code";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  content: string;
  isUser?: boolean;
  className?: string;
}

const markdownComponents: Components = {
  a({ children, href }) {
    const safeHref = href && isSafeUrl(href) ? href : undefined;
    if (!safeHref) {
      return <span className="text-muted-foreground">{children}</span>;
    }

    return (
      <a
        href={safeHref}
        target={isExternalUrl(safeHref) ? "_blank" : undefined}
        rel={isExternalUrl(safeHref) ? "noopener noreferrer" : undefined}
        referrerPolicy={isExternalUrl(safeHref) ? "no-referrer" : undefined}
        className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {children}
      </a>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  code({ children, className }) {
    const language = className?.replace(/^language-/, "");
    return (
      <code
        className={cn(
          "rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]",
          language && "before:content-none after:content-none",
        )}
        data-language={language || undefined}
      >
        {children}
      </code>
    );
  },
  h1({ children }) {
    return <h1 className="text-lg font-semibold leading-7">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-base font-semibold leading-7">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-sm font-semibold leading-6">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="text-sm font-semibold leading-6 text-muted-foreground">{children}</h4>;
  },
  hr() {
    return <hr className="border-border" />;
  },
  img({ alt, src }) {
    const label = alt || src || "image";
    return (
      <span className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[0.88em] text-muted-foreground">
        [image: {label}]
      </span>
    );
  },
  input({ checked, type }) {
    if (type !== "checkbox") return null;
    return (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        readOnly
        disabled
        className="mr-1.5 align-[-0.1em]"
        aria-label={checked ? "Completed task" : "Incomplete task"}
      />
    );
  },
  li({ children, className }) {
    return <li className={cn("pl-1", className)}>{children}</li>;
  },
  ol({ children }) {
    return <ol className="space-y-1 pl-5 list-decimal">{children}</ol>;
  },
  p({ children }) {
    return <p className="whitespace-pre-wrap">{children}</p>;
  },
  pre({ children }) {
    const fenced = readFencedCode(children);
    if (fenced) {
      return (
        <HighlightedCode
          code={fenced.code}
          language={fenced.language}
          className="rounded-md"
        />
      );
    }

    return (
      <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs leading-5">
        {children}
      </pre>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto rounded-md border">
        <table className="min-w-full border-collapse text-left text-xs">{children}</table>
      </div>
    );
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  td({ children }) {
    return <td className="border-b px-3 py-2 align-top last:border-r-0">{children}</td>;
  },
  th({ children }) {
    return <th className="border-b px-3 py-2 font-semibold">{children}</th>;
  },
  thead({ children }) {
    return <thead className="bg-muted/60 text-muted-foreground">{children}</thead>;
  },
  tr({ children }) {
    return <tr className="border-b last:border-b-0">{children}</tr>;
  },
  ul({ children, className }) {
    return <ul className={cn("space-y-1 pl-5 list-disc", className)}>{children}</ul>;
  },
};

function readFencedCode(
  children: ReactNode,
): { code: string; language: string | undefined } | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return null;

  const content = child.props.children;
  const code = Array.isArray(content) ? content.join("") : String(content ?? "");
  const language = child.props.className?.replace(/^language-/, "");
  return { code: code.replace(/\n$/, ""), language };
}

export function MarkdownContent({ content, isUser = false, className }: MarkdownContentProps) {
  return (
    <div
      className={cn(
        "space-y-3 break-words leading-6",
        isUser ? "text-foreground" : "text-foreground/95",
        className,
      )}
    >
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function safeUrlTransform(url: string): string {
  return isSafeUrl(url) ? url : "";
}

function isSafeUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  if (/^(?:javascript|data|vbscript|file):/i.test(value)) return false;
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./")) return true;

  try {
    const parsed = new URL(value, "https://console.auggy.local");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isExternalUrl(url: string): boolean {
  try {
    const fallbackOrigin = "https://console.auggy.local";
    const base =
      typeof window === "undefined"
        ? fallbackOrigin
        : window.location.href;
    const currentOrigin =
      typeof window === "undefined"
        ? fallbackOrigin
        : window.location.origin;
    const parsed = new URL(url, base);
    return parsed.origin !== currentOrigin;
  } catch {
    return false;
  }
}
