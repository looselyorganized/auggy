import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import type { CapabilityFinding } from "@/lib/capability-model";
import { cn } from "@/lib/utils";

export type CapabilityHealth = "ready" | "attention" | "error" | "neutral";

export interface CapabilityField {
  label: string;
  value: string;
}

const HEALTH_LABELS: Record<CapabilityHealth, string> = {
  ready: "Ready",
  attention: "Needs attention",
  error: "Unavailable",
  neutral: "Available",
};

const HEALTH_STYLES: Record<CapabilityHealth, string> = {
  ready: "text-emerald-700 dark:text-emerald-400",
  attention: "text-amber-700 dark:text-amber-400",
  error: "text-red-700 dark:text-red-400",
  neutral: "text-muted-foreground",
};

const HEALTH_ICONS = {
  ready: CheckCircle2,
  attention: AlertTriangle,
  error: AlertCircle,
  neutral: Circle,
} satisfies Record<CapabilityHealth, typeof Circle>;

export function CapabilityHealthIndicator({
  health,
  label = HEALTH_LABELS[health],
}: {
  health: CapabilityHealth;
  label?: string;
}) {
  const Icon = HEALTH_ICONS[health];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", HEALTH_STYLES[health])}>
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function CapabilitySurface({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="grid min-w-0 gap-2" aria-labelledby={headingId}>
      <h4 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
        {title}
        {count !== undefined && (
          <span className="font-normal tabular-nums text-muted-foreground">{count}</span>
        )}
      </h4>
      <div
        className="min-w-0 divide-y overflow-hidden rounded-md border bg-background"
        role="list"
      >
        {children}
      </div>
    </section>
  );
}

export function CapabilityRow({
  title,
  prefix,
  detail,
  category,
  health,
  healthLabel,
  fields = [],
  expandedFields = [],
}: {
  title: string;
  prefix?: string;
  detail: string;
  category?: string;
  health?: CapabilityHealth;
  healthLabel?: string;
  fields?: readonly CapabilityField[];
  expandedFields?: readonly CapabilityField[];
}) {
  return (
    <div className="grid gap-3 px-4 py-3.5" role="listitem">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {prefix && (
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {prefix}
              </span>
            )}
            <div className="min-w-0 break-all font-mono text-sm font-medium leading-5" title={title}>
              {title}
            </div>
          </div>
          <p className="mt-1 min-w-0 break-words text-xs leading-5 text-muted-foreground">
            {detail}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {category && <span className="text-xs text-muted-foreground">{category}</span>}
          {health && <CapabilityHealthIndicator health={health} label={healthLabel} />}
        </div>
      </div>

      {fields.length > 0 && <CapabilityFields fields={fields} compact />}

      {expandedFields.length > 0 && (
        <details className="group border-t pt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            View details
            <ChevronDown
              className="size-3.5 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <CapabilityFields fields={expandedFields} className="mt-3" />
        </details>
      )}
    </div>
  );
}

function CapabilityFields({
  fields,
  compact = false,
  className,
}: {
  fields: readonly CapabilityField[];
  compact?: boolean;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid min-w-0 gap-x-5 gap-y-1.5 text-xs sm:grid-cols-2",
        compact && "xl:grid-cols-3",
        className,
      )}
    >
      {fields.map((field) => (
        <div key={`${field.label}:${field.value}`} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FindingRows({ findings }: { findings: readonly CapabilityFinding[] }) {
  return findings.map((finding) => {
    const health = finding.severity === "error" ? "error" : finding.severity === "warning" ? "attention" : "neutral";
    return (
      <div key={finding.id} className="grid gap-2 px-4 py-3.5" role="listitem">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 break-all font-mono text-xs" title={finding.surfaceLabel}>
            {finding.surfaceLabel}
          </div>
          <CapabilityHealthIndicator
            health={health}
            label={finding.severity === "error" ? "Error" : finding.severity === "warning" ? "Warning" : "Note"}
          />
        </div>
        <div className="min-w-0 text-xs leading-5 text-muted-foreground">{finding.message}</div>
      </div>
    );
  });
}

export function CapabilityEmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-dashed px-4 py-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
