import { useEffect, useState } from "react";
import { Check, Copy, Info, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apply, getTheme, setTheme, subscribeSystemTheme, type Theme } from "@/lib/theme";
import { formatModelLabel } from "@/lib/dashboard-format";
import type { DashboardData } from "@/lib/types";

export interface HeaderProps {
  agentName: string;
  agentDescription?: string;
  port?: number;
  online: "online" | "offline" | "unknown";
  dashboard: DashboardData | null;
}

export function Header({ port, online, dashboard }: HeaderProps) {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    apply(theme);
    return subscribeSystemTheme(() => setThemeState(getTheme()));
  }, [theme]);

  const cycle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    setThemeState(next);
  };

  const ThemeIcon = theme === "dark" ? Moon : Sun;
  const nextTheme = theme === "light" ? "dark" : "light";
  return (
    <header className="flex h-16 items-center justify-between gap-3 border-b bg-background/90 px-4">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-foreground bg-foreground text-[13px] font-extrabold text-background">
          A1
        </span>
        <div className="hidden shrink-0 sm:block">
          <p className="text-sm font-semibold leading-4">Auggy</p>
          <p className="text-xs text-muted-foreground">Creator console</p>
        </div>
        {port !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            :{port}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <AgentDetailsButton dashboard={dashboard} online={online} />
        <Button
          variant="ghost"
          size="icon"
          onClick={cycle}
          aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}

function AgentDetailsButton({
  dashboard,
  online,
}: {
  dashboard: DashboardData | null;
  online: HeaderProps["online"];
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const publicUrl = origin || "unknown";
  const agentCardUrl = origin ? `${origin}/.well-known/agent-card.json` : "";
  const healthUrl = origin ? `${origin}/health` : "";
  const agentName =
    dashboard?.agentMeta?.displayName ??
    dashboard?.card.provider.displayName ??
    dashboard?.agentMeta?.name ??
    dashboard?.card.provider.name ??
    "auggy";
  const agentId = dashboard?.agentMeta?.id;
  const purpose = dashboard?.agentMeta?.purpose ?? dashboard?.card.purpose;
  const modelLabel = formatModelLabel(dashboard);
  const auggyVersion = dashboard?.auggyVersion;
  const transports = dashboard?.augments.filter((a) => a.isTransport).map((a) => a.type) ?? [];
  const augmentCount = dashboard?.augments.length ?? 0;

  async function copy(label: string, value: string) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
  }

  const diagnostics = [
    `agent=${agentName}`,
    agentId ? `id=${agentId}` : undefined,
    auggyVersion ? `auggy=${auggyVersion}` : undefined,
    modelLabel ? `engine=${modelLabel}` : undefined,
    `status=${online}`,
    publicUrl ? `url=${publicUrl}` : undefined,
    `augments=${dashboard?.augments.map((a) => a.type).join(",") ?? ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Agent details" title="Agent details">
          <Info className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{agentName}</DialogTitle>
          {purpose && <DialogDescription>{purpose}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <DetailGrid
            rows={[
              ["Status", online],
              ["Auggy version", auggyVersion ? `v${auggyVersion}` : "unknown"],
              ["Engine", modelLabel ?? "unknown"],
              ["Agent UUID", agentId ?? "not set"],
              ["Runtime URL", publicUrl],
              ["Agent card", agentCardUrl],
              ["Health", healthUrl],
              ["Transports", transports.length > 0 ? transports.join(", ") : "none reported"],
              ["Augments", String(augmentCount)],
            ]}
            onCopy={copy}
            copied={copied}
          />

          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copy("diagnostics", diagnostics)}
            >
              {copied === "diagnostics" ? (
                <Check className="mr-2 size-4" />
              ) : (
                <Copy className="mr-2 size-4" />
              )}
              Copy diagnostics
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailGrid({
  rows,
  copied,
  onCopy,
}: {
  rows: Array<[string, string]>;
  copied: string | null;
  onCopy: (label: string, value: string) => void | Promise<void>;
}) {
  return (
    <div className="divide-y rounded-md border">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="min-w-0 truncate font-mono text-xs" title={value}>
            {value}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void onCopy(label, value)}
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
          >
            {copied === label ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>
      ))}
    </div>
  );
}
