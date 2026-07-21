import { useId, type ComponentProps, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type {
  CapabilityBadge,
  CapabilityBadgeTone,
  CapabilityFinding,
} from "@/lib/capability-model";

const BADGE_VARIANTS: Record<
  CapabilityBadgeTone,
  ComponentProps<typeof Badge>["variant"]
> = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warn",
  danger: "destructive",
};

export function CapabilityBadges({ badges }: { badges: readonly CapabilityBadge[] }) {
  return (
    <div className="flex min-w-0 flex-wrap justify-end gap-1">
      {badges.map((badge) => (
        <Badge
          key={badge.id}
          variant={BADGE_VARIANTS[badge.tone]}
          className="h-auto max-w-48 truncate py-1 text-left sm:max-w-64"
          title={badge.label}
        >
          {badge.label}
        </Badge>
      ))}
    </div>
  );
}

export function CapabilitySurface({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="grid min-w-0 gap-2" aria-labelledby={headingId}>
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
        {title}
      </h3>
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
  detail,
  badges,
}: {
  title: string;
  detail: string;
  badges?: readonly CapabilityBadge[];
}) {
  return (
    <div className="grid gap-2 px-3 py-2" role="listitem">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 break-all font-mono text-xs leading-5" title={title}>
          {title}
        </div>
        {badges && badges.length > 0 && <CapabilityBadges badges={badges} />}
      </div>
      <div className="min-w-0 break-words text-xs leading-5 text-muted-foreground" title={detail}>
        {detail}
      </div>
    </div>
  );
}

export function FindingRows({ findings }: { findings: readonly CapabilityFinding[] }) {
  return findings.map((finding) => (
    <div key={finding.id} className="grid gap-2 px-3 py-2" role="listitem">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 break-all font-mono text-xs" title={finding.surfaceLabel}>
          {finding.surfaceLabel}
        </div>
        <Badge
          variant={
            finding.severity === "error"
              ? "destructive"
              : finding.severity === "warning"
                ? "warn"
                : "info"
          }
        >
          {finding.severity === "error"
            ? "Error"
            : finding.severity === "warning"
              ? "Warning"
              : "Note"}
        </Badge>
      </div>
      <div className="min-w-0 text-xs text-muted-foreground">{finding.message}</div>
    </div>
  ));
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
