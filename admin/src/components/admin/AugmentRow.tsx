import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminBlockBody } from "./AdminBlockBody";
import type { AdminInfoBlock, AugmentSummary } from "@/lib/types";

export interface AugmentRowProps {
  augment: AugmentSummary;
  block?: AdminInfoBlock;
  initialOpen?: boolean;
}

export function AugmentRow({ augment, block, initialOpen = false }: AugmentRowProps) {
  const expandable = !!block;
  const [open, setOpen] = useState(initialOpen && expandable);

  return (
    <Card>
      <CardHeader className="p-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => expandable && setOpen((o) => !o)}
            className="flex flex-1 items-center gap-3 text-left disabled:cursor-default"
            aria-expanded={expandable ? open : undefined}
            disabled={!expandable}
          >
            {expandable ? (
              open ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="inline-block size-4 shrink-0" />
            )}
            <CardTitle className="font-mono text-sm">{augment.type}</CardTitle>
          </button>
          <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            {augment.version && <span className="font-mono">v{augment.version}</span>}
            {!expandable && <span className="italic">no settings</span>}
          </div>
        </div>
      </CardHeader>
      {open && block && (
        <CardContent className="p-3 pt-0">
          <AdminBlockBody block={block} />
        </CardContent>
      )}
    </Card>
  );
}
