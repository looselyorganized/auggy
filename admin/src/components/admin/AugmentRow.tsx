import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AdminBlockBody } from "./AdminBlockBody";
import { getAugmentPromotion } from "@/lib/visibility";
import type { AdminInfoBlock, AugmentSummary } from "@/lib/types";

export interface AugmentRowProps {
  augment: AugmentSummary;
  block?: AdminInfoBlock;
  initialOpen?: boolean;
}

export function AugmentRow({ augment, block, initialOpen = false }: AugmentRowProps) {
  const promotion = getAugmentPromotion(augment);

  if (promotion.kind === "promoted") {
    return <PromotedRow augment={augment} tab={promotion.tab} tabLabel={promotion.tabLabel} />;
  }
  return <UnpromotedRow augment={augment} block={block} initialOpen={initialOpen} />;
}

// ---------------------------------------------------------------------------
// Promoted — "Configured in [Tab] ↗"
// ---------------------------------------------------------------------------

function PromotedRow({
  augment,
  tab,
  tabLabel,
}: {
  augment: AugmentSummary;
  tab: string;
  tabLabel: string;
}) {
  return (
    <Card>
      <CardHeader className="p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="inline-block size-4 shrink-0" />
            <CardTitle className="font-mono text-sm">{augment.type}</CardTitle>
            {augment.name !== augment.type && (
              <span className="font-mono text-xs text-muted-foreground">{augment.name}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {augment.version && (
              <span className="font-mono text-xs text-muted-foreground">v{augment.version}</span>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to={`/${tab}`}>
                Configured in {tabLabel}
                <ExternalLink className="size-3" />
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Unpromoted — inline expansion to adminInfo() block
// ---------------------------------------------------------------------------

function UnpromotedRow({
  augment,
  block,
  initialOpen,
}: {
  augment: AugmentSummary;
  block?: AdminInfoBlock;
  initialOpen?: boolean;
}) {
  const expandable = !!block;
  const [open, setOpen] = useState((initialOpen ?? false) && expandable);

  return (
    <Card>
      <CardHeader className="p-3">
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => expandable && setOpen((o) => !o)}
            className="h-auto flex-1 justify-start gap-3 px-0 py-0 text-left hover:bg-transparent disabled:cursor-default disabled:opacity-100"
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
            {augment.name !== augment.type && (
              <span className="font-mono text-xs text-muted-foreground">{augment.name}</span>
            )}
          </Button>
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
