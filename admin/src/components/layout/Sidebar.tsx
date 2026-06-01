import { NavLink } from "react-router-dom";
import {
  MessageSquare,
  FileText,
  Puzzle,
  Sparkles,
  KeyRound,
  Wallet,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMeta } from "@/lib/types";
import type { TabKey, TabVisibility } from "@/lib/visibility";

interface NavEntry {
  key: TabKey;
  to: string;
  label: string;
  icon: typeof MessageSquare;
}

const NAV: NavEntry[] = [
  { key: "chat",        to: "/chat",        label: "Chat",        icon: MessageSquare },
  { key: "identity",    to: "/identity",    label: "Identity",    icon: FileText },
  { key: "skills",      to: "/skills",      label: "Skills",      icon: Sparkles },
  { key: "credentials", to: "/credentials", label: "Credentials", icon: KeyRound },
  { key: "budget",      to: "/budget",      label: "Budget",      icon: Wallet },
  { key: "security",    to: "/security",    label: "Security",    icon: ShieldCheck },
  { key: "augments",    to: "/augments",    label: "Augments",    icon: Puzzle },
];

export interface SidebarProps {
  /** Identity read from `agent.yaml`. Null when unavailable (boot state, no agentDir, etc). */
  agentMeta: AgentMeta | null;
  /** Runtime-resolved name from the agent card. Used as fallback when agent.yaml didn't surface one. */
  fallbackName?: string;
  /** Per-tab visibility derived from installed augments. */
  visibility: TabVisibility;
}

export function Sidebar({ agentMeta, fallbackName, visibility }: SidebarProps) {
  const name = agentMeta?.displayName ?? agentMeta?.name ?? fallbackName ?? "—";
  const id = agentMeta?.id;
  const operators = agentMeta?.operators ?? [];

  const visibleNav = NAV.filter((n) => visibility[n.key]);

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
        {visibleNav.map(({ to, label, icon: Icon }) => (
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
