import { lazy, Suspense, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { MessageSquare, Network, Plug } from "lucide-react";
import { ChatThreadNav } from "@/components/admin/ChatThreadNav";
import {
  ChatWorkspaceProvider,
  useChatWorkspace,
} from "@/components/admin/ChatWorkspaceProvider";
import { Header } from "@/components/layout/Header";
import { ToastProvider } from "@/lib/toast";
import { ConfirmProvider } from "@/lib/confirm";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { useDashboard } from "@/hooks/useDashboard";
import { cn } from "@/lib/utils";

const ChatTab = lazy(() => import("@/routes/ChatTab").then((m) => ({ default: m.ChatTab })));
const IntegrationsTab = lazy(() =>
  import("@/routes/IntegrationsTab").then((m) => ({ default: m.IntegrationsTab })),
);
const CapabilitiesTab = lazy(() =>
  import("@/routes/CapabilitiesTab").then((m) => ({ default: m.CapabilitiesTab })),
);

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
          <ChatWorkspaceProvider>
            <ConsoleShell
              agentName={agentName}
              agentDescription={agentDescription}
              online={online}
              dashboard={dashboard.data ?? null}
            />
          </ChatWorkspaceProvider>
        </DashboardProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function ConsoleShell({
  agentName,
  agentDescription,
  online,
  dashboard,
}: {
  agentName: string;
  agentDescription?: string;
  online: "online" | "offline" | "unknown";
  dashboard: ReturnType<typeof useDashboard>["data"];
}) {
  const { state, create, select } = useChatWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const threads = [...state.threads].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt),
  );
  const openNewChat = () => {
    create();
    navigate("/chat");
  };
  const openChat = (threadId: string) => {
    select(threadId);
    navigate("/chat");
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div className="auggy-brand-stripe" />
      <Header
        agentName={agentName}
        agentDescription={agentDescription}
        online={online}
        dashboard={dashboard}
      />
      {location.pathname.startsWith("/chat") && (
        <div className="border-b bg-background px-2 py-1.5 sm:hidden">
          <ChatThreadNav
            compact
            threads={threads}
            activeId={state.activeThreadId}
            onNew={openNewChat}
            onSelect={openChat}
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-52 shrink-0 border-r bg-background/80 p-3 sm:flex sm:flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChatThreadNav
              threads={threads}
              activeId={state.activeThreadId}
              onNew={openNewChat}
              onSelect={openChat}
            />
            <nav className="mt-3 grid gap-1 border-t pt-3" aria-label="Console sections">
              <ConsoleNavLink to="/integrations" icon={<Plug className="size-4" />}>
                Integrations
              </ConsoleNavLink>
              <ConsoleNavLink to="/capabilities" icon={<Network className="size-4" />}>
                Capabilities
              </ConsoleNavLink>
            </nav>
          </div>
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
          <ConsoleNavLink to="/capabilities" icon={<Network className="size-4" />}>
            Capabilities
          </ConsoleNavLink>
        </nav>
        <main className="min-h-0 flex-1 overflow-hidden bg-muted/30 pb-12 sm:pb-0">
          <Suspense fallback={<ConsoleRouteFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatTab />} />
              <Route path="/integrations" element={<IntegrationsTab />} />
              <Route path="/capabilities" element={<CapabilitiesTab />} />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function ConsoleRouteFallback() {
  return (
    <div className="grid h-full place-items-center p-4 text-sm text-muted-foreground">
      Loading...
    </div>
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
