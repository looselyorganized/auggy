import { NavLink } from "react-router-dom";
import {
  MessageSquare,
  FileText,
  Puzzle,
  Sparkles,
  KeyRound,
  Brain,
  Wallet,
  Activity,
  FileJson,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMeta } from "@/lib/types";

const NAV = [
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/identity", label: "Identity", icon: FileText },
  { to: "/augments", label: "Augments", icon: Puzzle },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/credentials", label: "Credentials", icon: KeyRound },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/budgets", label: "Budgets", icon: Wallet },
  { to: "/traces", label: "Traces", icon: Activity },
  { to: "/manifest", label: "Manifest", icon: FileJson },
] as const;

export interface SidebarProps {
  /** Identity read from `agent.yaml`. Null when unavailable (boot state, no agentDir, etc). */
  agentMeta: AgentMeta | null;
  /** Runtime-resolved name from the agent card. Used as fallback when agent.yaml didn't surface one. */
  fallbackName?: string;
}

export function Sidebar({ agentMeta, fallbackName }: SidebarProps) {
  const name = agentMeta?.name ?? fallbackName ?? "—";
  const id = agentMeta?.id;
  const operators = agentMeta?.operators ?? [];

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-background">
      <div className="border-b p-4">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agent
        </div>
        <div className="mt-1 truncate font-mono text-sm font-semibold" title={name}>
          {name}
        </div>
        {id && (
          <div
            className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
            title={id}
          >
            {id}
          </div>
        )}
        {operators.length > 0 && (
          <div
            className="mt-1 truncate text-[11px] text-muted-foreground"
            title={`Operators: ${operators.join(", ")}`}
          >
            ops: {operators.join(", ")}
          </div>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
