import { AlertTriangle, Brain, Info, Package, Route, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type {
  AugmentCapabilityModel,
  CapabilityModel,
  CapabilitySurfaceSummary,
} from "@/lib/capability-model";
import type { AugmentSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const CATEGORY_LABELS: Record<AugmentSummary["category"], string> = {
  transports: "Transports",
  capabilities: "Capabilities",
  memory: "Memory",
  guardrails: "Guardrails",
};

const CATEGORY_ORDER: AugmentSummary["category"][] = [
  "transports",
  "capabilities",
  "memory",
  "guardrails",
];

export function CapabilitySummaryBar({ model }: { model: CapabilityModel }) {
  const selected = model.scope.selectedAugmentName !== null;
  const summary = selected ? model.scope.summary : model.summary;
  const metrics = [
    ...(!selected
      ? [{ label: "Augments", value: model.summary.augmentCount, icon: Package }]
      : []),
    { label: "Routes", value: summary.routeCount, icon: Route },
    { label: "Tools", value: summary.toolCount, icon: Wrench },
    { label: "Memory", value: summary.memoryAugmentCount, icon: Brain },
    { label: "Issues", value: summary.issueCount, icon: AlertTriangle },
    { label: "Notes", value: summary.noteCount, icon: Info },
  ];
  return (
    <div className="flex flex-wrap divide-x rounded-md border bg-background px-1 py-2">
      {metrics.map(({ label, value, icon: Icon }) => (
        <div key={label} className="flex min-w-24 items-center gap-2 px-3 py-1">
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="text-lg font-semibold leading-none">{value}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  );
}

export function CapabilityNavigation({
  model,
  onSelect,
}: {
  model: CapabilityModel;
  onSelect: (augmentName: string | null) => void;
}) {
  return (
    <nav className="grid gap-4" aria-label="Capability owners">
      <NavigationButton
        title="All capabilities"
        subtitle="Complete runtime map"
        summary={model.summary}
        selected={model.scope.selectedAugmentName === null}
        onSelect={() => onSelect(null)}
      />
      {CATEGORY_ORDER.map((category) => {
        const nodes = model.augmentNodes.filter((node) => node.augment.category === category);
        if (nodes.length === 0) return null;
        return (
          <section key={category} className="grid gap-2">
            <div className="px-1 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              {CATEGORY_LABELS[category]}
            </div>
            <div className="grid gap-1.5">
              {nodes.map((node) => (
                <AugmentNavigationButton
                  key={node.augment.name}
                  node={node}
                  selected={model.scope.selectedAugmentName === node.augment.name}
                  onSelect={() => onSelect(node.augment.name)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </nav>
  );
}

function AugmentNavigationButton({
  node,
  selected,
  onSelect,
}: {
  node: AugmentCapabilityModel;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <NavigationButton
      title={node.augment.type}
      subtitle={node.augment.name}
      summary={node.summary}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

function NavigationButton({
  title,
  subtitle,
  summary,
  selected,
  onSelect,
}: {
  title: string;
  subtitle: string;
  summary: CapabilitySurfaceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "grid gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors",
        "hover:border-foreground/40 hover:bg-muted/40",
        selected && "border-foreground bg-muted/60",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={title}>
            {title}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {summary.issueCount > 0 && (
          <Badge variant={summary.errorCount > 0 ? "destructive" : "warn"}>
            {countLabel(summary.issueCount, "issue")}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {summary.routeCount > 0 && (
          <Badge variant="info">{countLabel(summary.routeCount, "route")}</Badge>
        )}
        {summary.toolCount > 0 && (
          <Badge variant="secondary">{countLabel(summary.toolCount, "tool")}</Badge>
        )}
        {summary.memoryAugmentCount > 0 && <Badge variant="success">memory</Badge>}
        {summary.noteCount > 0 && (
          <Badge variant="outline">{countLabel(summary.noteCount, "note")}</Badge>
        )}
      </div>
    </button>
  );
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
