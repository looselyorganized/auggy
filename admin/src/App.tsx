import type { ReactNode } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { MessageSquare, Plug } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { ToastProvider } from "@/lib/toast";
import { ConfirmProvider } from "@/lib/confirm";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { useDashboard } from "@/hooks/useDashboard";
import { ChatTab } from "@/routes/ChatTab";
import { IntegrationsTab } from "@/routes/IntegrationsTab";
import { cn } from "@/lib/utils";

export function App() {
  const dashboard = useDashboard();
  const provider = dashboard.data?.card.provider;
  const agentName =
    dashboard.data?.agentMeta?.displayName ??
    provider?.displayName ??
    dashboard.data?.agentMeta?.name ??
    provider?.name ??
    "auggy";
  const agentDescription = dashboard.data?.agentMeta?.purpose ?? dashboard.data?.card.purpose;
  const online: "online" | "offline" | "unknown" = dashboard.error
    ? "offline"
    : dashboard.data
      ? "online"
      : "unknown";

  return (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardProvider value={dashboard}>
          <div className="flex h-full min-w-0 flex-col bg-background">
            <div className="h-1.5 shrink-0 bg-[hsl(var(--brand-signal))]" />
            <Header
              agentName={agentName}
              agentDescription={agentDescription}
              online={online}
              dashboard={dashboard.data ?? null}
            />
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <aside className="hidden w-52 shrink-0 border-r bg-background/80 p-3 sm:flex sm:flex-col">
                <nav className="grid gap-1" aria-label="Console sections">
                  <ConsoleNavLink to="/chat" icon={<MessageSquare className="size-4" />}>
                    Chat
                  </ConsoleNavLink>
                  <ConsoleNavLink to="/integrations" icon={<Plug className="size-4" />}>
                    Integrations
                  </ConsoleNavLink>
                </nav>
                <ConsoleAgentSummary
                  agentName={agentName}
                  agentDescription={agentDescription}
                  online={online}
                />
              </aside>
              <nav
                className="fixed inset-x-0 bottom-0 z-10 flex h-12 items-center justify-around border-t bg-background sm:hidden"
                aria-label="Console sections"
              >
                <ConsoleNavLink to="/chat" icon={<MessageSquare className="size-4" />}>
                  Chat
                </ConsoleNavLink>
                <ConsoleNavLink to="/integrations" icon={<Plug className="size-4" />}>
                  Integrations
                </ConsoleNavLink>
              </nav>
              <main className="min-h-0 flex-1 overflow-hidden bg-muted/30 pb-12 sm:pb-0">
                <Routes>
                  <Route path="/" element={<Navigate to="/chat" replace />} />
                  <Route path="/chat" element={<ChatTab />} />
                  <Route path="/integrations" element={<IntegrationsTab />} />
                  <Route path="*" element={<Navigate to="/chat" replace />} />
                </Routes>
              </main>
            </div>
          </div>
        </DashboardProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function ConsoleAgentSummary({
  agentName,
  agentDescription,
  online,
}: {
  agentName: string;
  agentDescription?: string;
  online: "online" | "offline" | "unknown";
}) {
  const dot =
    online === "online"
      ? "bg-emerald-500"
      : online === "offline"
        ? "bg-slate-400"
        : "bg-amber-500";

  return (
    <div className="mt-auto border-t pt-3">
      <div className="flex min-w-0 items-start gap-2 rounded-md px-2 py-2">
        <span className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-5">{agentName}</div>
          {agentDescription && (
            <div className="line-clamp-2 text-xs leading-4 text-muted-foreground">
              {agentDescription}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConsoleNavLink({
  to,
  icon,
  children,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground",
          "hover:bg-muted hover:text-foreground",
          isActive && "bg-muted text-foreground",
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}
