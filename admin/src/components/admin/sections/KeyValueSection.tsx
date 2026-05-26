import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { useActionDispatcher } from "@/components/admin/useActionDispatcher";
import type { KeyValueRow } from "@/lib/types";

export function KeyValueSection({ rows }: { rows: KeyValueRow[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map((row, i) => (
        <KeyValueRowView key={`${row.label}-${i}`} row={row} />
      ))}
    </dl>
  );
}

function KeyValueRowView({ row }: { row: KeyValueRow }) {
  return (
    <>
      <dt className="font-medium text-muted-foreground">{row.label}</dt>
      <dd className="flex items-center gap-2">
        <span className="font-mono text-foreground">{row.value}</span>
        {row.source && (
          <Badge variant="outline" className="font-mono text-[10px] font-normal text-muted-foreground">
            {row.source}
          </Badge>
        )}
        {row.resetAction && <ResetButton id={row.resetAction.id} label={row.resetAction.label} />}
      </dd>
    </>
  );
}

function ResetButton({ id, label }: { id: string; label: string }) {
  const { dispatch, busy } = useActionDispatcher();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() =>
        void dispatch({ actionId: id, confirmRequired: true, confirmMessage: `${label}?` })
      }
      className="h-6 gap-1 px-1.5 text-xs"
    >
      <RotateCcw className="size-3" />
      {label}
    </Button>
  );
}
