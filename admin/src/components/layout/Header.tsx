import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apply, getTheme, setTheme, subscribeSystemTheme, type Theme } from "@/lib/theme";

export interface HeaderProps {
  agentName: string;
  agentDescription?: string;
  port?: number;
  online: "online" | "offline" | "unknown";
}

export function Header({ agentName, agentDescription, port, online }: HeaderProps) {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    apply(theme);
    return subscribeSystemTheme(() => apply(theme));
  }, [theme]);

  const cycle = () => {
    const next: Theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    setTheme(next);
    setThemeState(next);
  };

  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const dot =
    online === "online"
      ? "bg-emerald-500"
      : online === "offline"
        ? "bg-slate-400"
        : "bg-amber-500";

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-3 overflow-hidden">
        <span className={`inline-block size-2 shrink-0 rounded-full ${dot}`} />
        <div className="flex items-baseline gap-2 overflow-hidden">
          <h1 className="truncate text-sm font-semibold">{agentName}</h1>
          {agentDescription && (
            <span className="truncate text-xs text-muted-foreground">
              {agentDescription}
            </span>
          )}
        </div>
        {port !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            :{port}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={cycle}
          aria-label={`Theme: ${theme}. Click to switch.`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}
