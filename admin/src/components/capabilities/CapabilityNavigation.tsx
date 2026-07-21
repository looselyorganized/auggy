import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronsUpDown,
  Info,
  Package,
  Route,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

export const CAPABILITY_DETAIL_ID = "capability-detail";

export function CapabilitySummaryBar({ model }: { model: CapabilityModel }) {
  const selected = model.scope.selectedAugmentName !== null;
  const summary = selected ? model.scope.summary : model.summary;
  const metrics = [
    ...(!selected
      ? [{ label: "Augments", value: model.summary.augmentCount, icon: Package }]
      : []),
    { label: "Routes", value: summary.routeCount, icon: Route },
    { label: "Tools", value: summary.toolCount, icon: Wrench },
    { label: "Skills", value: summary.skillCount, icon: BookOpen },
    { label: "Memory", value: summary.memoryAugmentCount, icon: Brain },
    { label: "Issues", value: summary.issueCount, icon: AlertTriangle },
    { label: "Notes", value: summary.noteCount, icon: Info },
  ];
  return (
    <dl
      className="flex min-w-0 flex-wrap gap-1 rounded-md border bg-background p-1"
      aria-label={selected ? "Selected augment summary" : "Runtime capability summary"}
    >
      {metrics.map(({ label, value, icon: Icon }) => (
        <div
          key={label}
          className="flex min-w-0 basis-24 grow items-center gap-2 rounded-sm px-2 py-1.5"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dt className="min-w-0 text-xs text-muted-foreground">{label}</dt>
          <dd className="order-first text-lg font-semibold leading-none">{value}</dd>
        </div>
      ))}
    </dl>
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
        const headingId = `capability-category-${category}`;
        return (
          <section key={category} className="grid gap-2" aria-labelledby={headingId}>
            <h4 id={headingId} className="px-1 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              {CATEGORY_LABELS[category]}
            </h4>
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

export function CapabilityMobileSelector({
  model,
  onSelect,
}: {
  model: CapabilityModel;
  onSelect: (augmentName: string | null) => void;
}) {
  const selectedNode = model.scope.selectedAugmentName
    ? model.augmentNodes.find((node) => node.augment.name === model.scope.selectedAugmentName)
    : undefined;
  const selectionLabel = selectedNode
    ? `${selectedNode.augment.type} · ${selectedNode.augment.name}`
    : "All capabilities";

  return (
    <div className="grid gap-1.5 lg:hidden">
      <div className="text-xs font-medium text-muted-foreground">Capability owner</div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-9 w-full min-w-0 justify-between gap-3 whitespace-normal px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Capability owner: ${selectionLabel}`}
            />
          }
        >
          <span className="min-w-0 break-words">{selectionLabel}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(70dvh,32rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
        >
          <OwnerMenuItem
            title="All capabilities"
            subtitle="Complete runtime map"
            selected={model.scope.selectedAugmentName === null}
            onSelect={() => onSelect(null)}
          />
          {CATEGORY_ORDER.map((category) => {
            const nodes = model.augmentNodes.filter(
              (node) => node.augment.category === category,
            );
            if (nodes.length === 0) return null;
            return (
              <div
                key={category}
                role="group"
                aria-labelledby={`capability-owner-group-${category}`}
              >
                <DropdownMenuSeparator />
                <div
                  id={`capability-owner-group-${category}`}
                  className="px-2 py-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground"
                >
                  {CATEGORY_LABELS[category]}
                </div>
                {nodes.map((node) => (
                  <OwnerMenuItem
                    key={node.augment.name}
                    title={node.augment.type}
                    subtitle={node.augment.name}
                    selected={model.scope.selectedAugmentName === node.augment.name}
                    onSelect={() => onSelect(node.augment.name)}
                  />
                ))}
              </div>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OwnerMenuItem({
  title,
  subtitle,
  selected,
  onSelect,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className="items-start py-2"
    >
      <Check
        className={cn("mt-0.5 size-4 shrink-0", !selected && "invisible")}
        aria-hidden="true"
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="break-words font-medium">{title}</span>
        <span className="break-all font-mono text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
    </DropdownMenuItem>
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
      aria-controls={CAPABILITY_DETAIL_ID}
      className={cn(
        "grid gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors",
        "hover:border-foreground/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        selected && "border-foreground bg-muted/60",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold" title={title}>
            {title}
          </div>
          <div className="break-all font-mono text-[11px] text-muted-foreground" title={subtitle}>
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
        {summary.skillCount > 0 && (
          <Badge variant="outline">{countLabel(summary.skillCount, "skill")}</Badge>
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
