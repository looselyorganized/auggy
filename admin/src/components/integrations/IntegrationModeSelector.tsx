import { Bot, Check, Globe2, Server } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type IntegrationMode = "browser" | "server" | "agent";
export const DEFAULT_INTEGRATION_MODE: IntegrationMode = "browser";

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
    <div className="grid gap-2 sm:grid-cols-3" role="tablist" aria-label="Integration type">
      {MODES.map((mode, index) => {
        const Icon = mode.icon;
        const selected = value === mode.id;
        return (
          <Button
            key={mode.id}
            id={`integration-mode-${mode.id}`}
            type="button"
            variant="outline"
            role="tab"
            aria-selected={selected}
            aria-controls={`integration-panel-${mode.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(mode.id)}
            onKeyDown={(event) => navigateModes(event, index, onChange)}
            className={cn(
              "h-auto min-h-20 w-full min-w-0 items-start justify-start gap-3 whitespace-normal px-3 py-3 text-left",
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
            {selected && <Check className="ml-auto size-4 shrink-0" aria-label="Selected" />}
          </Button>
        );
      })}
    </div>
  );
}

function navigateModes(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  onChange: (mode: IntegrationMode) => void,
) {
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % MODES.length;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + MODES.length) % MODES.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = MODES.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const nextMode = MODES[nextIndex]!;
  onChange(nextMode.id);
  document.getElementById(`integration-mode-${nextMode.id}`)?.focus();
}
