import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HighlightedCode } from "@/components/ui/highlighted-code";

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
  id,
  label,
  value,
  language,
  copied,
  onCopy,
}: {
  id: string;
  label: string;
  value: string;
  language: string;
  copied: string | null;
  onCopy: CopyHandler;
}) {
  const copyLabel = `${id}:${label}`;
  return (
    <div className="min-w-0 overflow-hidden rounded-md border" aria-label={label}>
      <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          aria-label={`Copy ${label}`}
          onClick={() => void onCopy(copyLabel, value)}
        >
          {copied === copyLabel ? (
            <Check className="mr-1.5 size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="mr-1.5 size-3.5" aria-hidden="true" />
          )}
          {copied === copyLabel ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <HighlightedCode code={value} language={language} />
      </div>
    </div>
  );
}
