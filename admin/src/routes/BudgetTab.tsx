import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminBlockBody } from "@/components/admin/AdminBlockBody";
import { useDashboardContext } from "@/components/admin/DashboardContext";

/**
 * Budget tab — "What can the agent spend?"
 *
 * Promoted home for the `budgets` augment. Renders its `adminInfo()`
 * block: per-tier caps + current spend + cap-adjust action forms.
 * No inline editing of budget *composition* here — the Augments tab
 * owns mount / unmount of the augment itself.
 */
export function BudgetTab() {
  const { data, error, loading } = useDashboardContext();

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Budget</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Budget load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!data) return null;

  // The budgets augment uses augmentName "budgets" — match by name. The
  // AugmentsTab's visibility filter ensures we only got here if `budgets`
  // is mounted, but a `block === undefined` is still possible (transient
  // collection error inside adminInfo()).
  const block = data.blocks.find((b) => b.augmentName === "budgets");

  if (!block) {
    return (
      <Card className="border-amber-500/40">
        <CardHeader>
          <CardTitle>Budget — no data</CardTitle>
          <CardDescription>
            The <code className="font-mono text-xs">budgets</code> augment is mounted but its
            admin block didn't load. Check the agent logs for an error from{" "}
            <code className="font-mono text-xs">budgets.adminInfo()</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {block.title}
        </h2>
        <p className="text-xs text-muted-foreground">
          Backed by the <code className="font-mono text-[11px]">budgets</code> augment. Spend
          updates as turns run; cap adjustments persist immediately.
        </p>
      </header>
      <Card>
        <CardContent className="p-4">
          <AdminBlockBody block={block} />
        </CardContent>
      </Card>
    </div>
  );
}
