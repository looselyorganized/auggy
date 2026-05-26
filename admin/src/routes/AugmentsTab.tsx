import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { AugmentRow } from "@/components/admin/AugmentRow";
import type { AdminInfoBlock, AugmentCategory, AugmentSummary } from "@/lib/types";

interface CategoryDef {
  key: AugmentCategory;
  label: string;
  blurb: string;
}

const CATEGORIES: CategoryDef[] = [
  {
    key: "transports",
    label: "Transports",
    blurb: "How the agent talks to the world — inbound + outbound channels.",
  },
  {
    key: "capabilities",
    label: "Capabilities",
    blurb: "What the agent can do — tools, scripts, side effects.",
  },
  {
    key: "memory",
    label: "Memory",
    blurb: "What the agent remembers and knows.",
  },
  {
    key: "guardrails",
    label: "Guardrails",
    blurb: "Limits, identity, safety — what keeps the agent on the road.",
  },
];

interface Row {
  aug: AugmentSummary;
  block?: AdminInfoBlock;
}

export function AugmentsTab() {
  const { data, error, loading } = useDashboardContext();

  const byCategory = useMemo(() => {
    const out: Record<AugmentCategory, Row[]> = {
      transports: [],
      capabilities: [],
      memory: [],
      guardrails: [],
    };
    if (!data) return out;
    const blockByName = new Map(data.blocks.map((b) => [b.augmentName, b]));
    for (const aug of data.augments) {
      out[aug.category].push({ aug, block: blockByName.get(aug.name) });
    }
    // Stable display order within each category.
    for (const k of Object.keys(out) as AugmentCategory[]) {
      out[k].sort((a, b) => a.aug.name.localeCompare(b.aug.name));
    }
    return out;
  }, [data]);

  if (loading && !data) {
    return <Loading />;
  }
  if (error && !data) {
    return <ErrorPanel message={error} />;
  }
  if (!data) {
    return null;
  }
  if (data.augments.length === 0) {
    return <Empty />;
  }

  const totalWithSettings = data.augments.filter((a) => a.hasAdminInfo).length;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {data.augments.length} mounted · {totalWithSettings} with operator settings
        </span>
        <span className="italic">Mount / unmount augments — coming in v1.1</span>
      </div>

      {CATEGORIES.map(({ key, label, blurb }) => {
        const rows = byCategory[key];
        if (rows.length === 0) return null;
        return (
          <section key={key} className="space-y-3">
            <header className="flex items-baseline gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </h2>
              <span className="text-xs text-muted-foreground">
                {rows.length} · {blurb}
              </span>
            </header>
            <div className="space-y-2">
              {rows.map(({ aug, block }) => (
                <AugmentRow key={aug.name} augment={aug} block={block} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Loading() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Augments</CardTitle>
        <CardDescription>Loading…</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Dashboard error</CardTitle>
        <CardDescription className="font-mono text-xs">{message}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Check that the agent is reachable and the bearer token is correct. Polling continues every
        2s.
      </CardContent>
    </Card>
  );
}

function Empty() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No augments mounted</CardTitle>
        <CardDescription>
          This agent has no augments registered. Add one with{" "}
          <code className="font-mono text-xs">auggy add &lt;name&gt;</code>.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
