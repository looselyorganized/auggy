import { Bot, Globe2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type IntegrationMode = "browser" | "server" | "agent";

const MODES = [
  {
    id: "browser",
    label: "Browser application",
    description: "Visitor-facing apps and chat",
    icon: Globe2,
  },
  {
    id: "server",
    label: "Server application",
    description: "Backends, jobs, and server actions",
    icon: Server,
  },
  {
    id: "agent",
    label: "Agent-to-agent",
    description: "Standards-based interoperability",
    icon: Bot,
    comingSoon: true,
  },
] as const;

export function IntegrationModeSelector({
  value,
  onChange,
}: {
  value: IntegrationMode;
  onChange: (mode: IntegrationMode) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3" aria-label="Integration type">
      {MODES.map((mode) => {
        const Icon = mode.icon;
        const selected = value === mode.id;
        return (
          <Button
            key={mode.id}
            type="button"
            variant="outline"
            aria-pressed={selected}
            onClick={() => onChange(mode.id)}
            className={cn(
              "h-auto min-h-20 items-start justify-start gap-3 whitespace-normal px-3 py-3 text-left",
              selected && "border-foreground bg-muted/60",
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {mode.label}
                {"comingSoon" in mode && mode.comingSoon && (
                  <Badge variant="secondary">Coming soon</Badge>
                )}
              </span>
              <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                {mode.description}
              </span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
