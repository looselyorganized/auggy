import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useActionDispatcher } from "@/components/admin/useActionDispatcher";
import type { AdminRowAction } from "@/lib/types";

export interface TableSectionProps {
  columns: string[];
  rows: string[][];
  rowActions?: AdminRowAction[];
  caption?: string;
}

export function TableSection({ columns, rows, rowActions, caption }: TableSectionProps) {
  const hasActions = (rowActions?.length ?? 0) > 0;
  return (
    <Table>
      {caption && <TableCaption>{caption}</TableCaption>}
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead key={col}>{col}</TableHead>
          ))}
          {hasActions && <TableHead className="w-px text-right pr-3">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columns.length + (hasActions ? 1 : 0)} className="text-center text-muted-foreground">
              No rows.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j} className="font-mono text-xs">
                  {cell}
                </TableCell>
              ))}
              {hasActions && (
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {rowActions!.map((ra) => (
                      <RowActionButton key={ra.id} action={ra} rowKey={row[ra.rowKeyColumn] ?? ""} />
                    ))}
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function RowActionButton({ action, rowKey }: { action: AdminRowAction; rowKey: string }) {
  const { dispatch, busy } = useActionDispatcher();
  if (!rowKey) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() =>
        void dispatch({
          actionId: action.id,
          rowKey,
          confirmRequired: action.confirmRequired,
          confirmMessage: `${action.label} for "${rowKey}"?`,
        })
      }
      className="h-7 text-xs"
    >
      {action.label}
    </Button>
  );
}
