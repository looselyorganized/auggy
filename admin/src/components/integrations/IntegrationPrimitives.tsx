import { Check, Copy } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { HighlightedCode } from "@/components/ui/highlighted-code";
import type { RouteManifestEntry } from "@/lib/types";

export type CopyHandler = (label: string, value: string) => void | Promise<void>;

export function ConnectionDetails({
  rows,
}: {
  rows: Array<{ label: string; value: string; note?: string }>;
}) {
  return (
    <dl className="divide-y rounded-md border">
      {rows.map((row) => (
        <div key={row.label} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 text-sm">
            <span className="break-all font-mono text-xs">{row.value}</span>
            {row.note && (
              <span className="mt-1 block font-sans text-xs leading-5 text-muted-foreground">
                {row.note}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CodeExample({
  label,
  value,
  language,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  language: string;
  copied: string | null;
  onCopy: CopyHandler;
}) {
  const labelId = useId();
  return (
    <figure className="min-w-0 overflow-hidden rounded-md border" aria-labelledby={labelId}>
      <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-3 py-2">
        <figcaption
          id={labelId}
          className="min-w-0 break-words font-mono text-xs text-muted-foreground"
        >
          {label}
        </figcaption>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0"
          aria-label={`Copy ${label}`}
          onClick={() => void onCopy(label, value)}
        >
          {copied === label ? (
            <Check className="mr-1.5 size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="mr-1.5 size-3.5" aria-hidden="true" />
          )}
          {copied === label ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <HighlightedCode code={value} language={language} />
      </div>
    </figure>
  );
}

export function IntegrationRouteList({
  routes,
  emptyMessage,
}: {
  routes: RouteManifestEntry[];
  emptyMessage: string;
}) {
  if (routes.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {routes.map((route) => (
        <li
          key={`${route.method} ${route.path}`}
          className="grid gap-1 px-3 py-2.5 sm:grid-cols-[4rem_minmax(0,1fr)_9rem]"
        >
          <span className="font-mono text-xs"><span className="sr-only">Method: </span>{route.method}</span>
          <span className="break-all font-mono text-xs"><span className="sr-only">Path: </span>{route.path}</span>
          <span className="text-xs text-muted-foreground sm:text-right"><span className="sr-only">Auth: </span>{route.auth}</span>
        </li>
      ))}
    </ul>
  );
}
