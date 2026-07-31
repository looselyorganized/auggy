import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { LoaderCircle, Mail, MessageSquare, Network, Plug } from "lucide-react";
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
import {
  CHAT_DRAFT_PATH,
  CHAT_WELCOME_PATH,
  chatThreadPath,
  getChatNavigationState,
  getVisibleChatWorkspaceTarget,
  parseChatRouteTarget,
} from "@/lib/chat-route";
import { getMobileChatNavigationState } from "@/lib/chat-run-state";
import { ChatRoute } from "@/routes/ChatRoute";
import { cn } from "@/lib/utils";
import { hasMailDashboard } from "@/lib/mail-dashboard";

const IntegrationsTab = lazy(() =>
  import("@/routes/IntegrationsTab").then((m) => ({
    default: m.IntegrationsTab,
  })),
);
const CapabilitiesTab = lazy(() =>
  import("@/routes/CapabilitiesTab").then((m) => ({
    default: m.CapabilitiesTab,
  })),
);
const MailRoute = lazy(() =>
  import("@/routes/MailRoute").then((module) => ({
    default: module.MailRoute,
  })),
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
  const agentDescription =
    dashboard.data?.agentMeta?.purpose ?? dashboard.data?.card.purpose;
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
  const {
    state,
    create,
    select,
    rename,
    deleteThread,
    deletingThreadIds,
    hydrationStatus,
    hydrationError,
    setChatVisible,
  } = useChatWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const documentVisible = useDocumentVisible();
  const chatRoute = parseChatRouteTarget(location.pathname);
  const chatRouteActive = chatRoute.kind !== "outside";
  const visibleChatTarget = getVisibleChatWorkspaceTarget({
    route: chatRoute,
    documentVisible,
    localDraftId: state.draft?.id ?? null,
    selection: state.selection,
  });
  const { activeId: activeNavId, threads } = getChatNavigationState({
    threads: state.durableThreads,
    route: chatRoute,
    selection: state.selection,
  });
  const mobileChatNavigation = getMobileChatNavigationState(
    state.durableThreads,
    chatRouteActive,
  );
  const mailAvailable = hasMailDashboard(dashboard);
  useEffect(
    () => setChatVisible(visibleChatTarget),
    [setChatVisible, visibleChatTarget],
  );
  const openNewChat = () => {
    create();
    navigate(CHAT_DRAFT_PATH);
  };
  const openChat = (threadId: string) => {
    if (!select(threadId)) return;
    navigate(chatThreadPath(threadId));
  };
  const renameChat = async (threadId: string, title: string) => {
    const result = await rename(threadId, title);
    if (!result.valid) throw new Error(result.message);
  };
  const deleteChat = async (threadId: string) => {
    const result = await deleteThread(threadId);
    if (!result.ok) throw new Error(result.error);
  };
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <div className="auggy-brand-stripe" />
      <Header
        agentName={agentName}
        agentDescription={agentDescription}
        online={online}
        dashboard={dashboard}
        floating={chatRouteActive}
      />
      {chatRouteActive && (
        <div className="border-b bg-background px-2 pb-1.5 pt-16 sm:hidden">
          <ChatThreadNav
            compact
            threads={threads}
            activeId={activeNavId}
            loading={hydrationStatus === "loading"}
            error={hydrationStatus === "error" ? hydrationError : null}
            onNew={openNewChat}
            onSelect={openChat}
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            "hidden w-52 shrink-0 border-r bg-background/80 p-3 sm:flex sm:flex-col",
            chatRouteActive && "pt-16",
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChatThreadNav
              threads={threads}
              activeId={activeNavId}
              loading={hydrationStatus === "loading"}
              error={hydrationStatus === "error" ? hydrationError : null}
              onNew={openNewChat}
              onSelect={openChat}
              onRename={renameChat}
              onDelete={deleteChat}
              deletingThreadIds={deletingThreadIds}
            />
            <nav
              className="mt-3 grid gap-1 border-t pt-3"
              aria-label="Console sections"
            >
              {mailAvailable && (
                <ConsoleNavLink to="/mail" icon={<Mail className="size-4" />}>
                  Mail
                </ConsoleNavLink>
              )}
              <ConsoleNavLink
                to="/integrations"
                icon={<Plug className="size-4" />}
              >
                Integrations
              </ConsoleNavLink>
              <ConsoleNavLink
                to="/capabilities"
                icon={<Network className="size-4" />}
              >
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
          <ConsoleNavLink
            to={CHAT_WELCOME_PATH}
            ariaLabel={mobileChatNavigation.accessibleLabel}
            icon={
              <span className="relative" aria-hidden="true">
                <MessageSquare className="size-4" />
                {mobileChatNavigation.showIndicator &&
                  (mobileChatNavigation.streamingCount > 0 ? (
                    <LoaderCircle className="absolute -right-1.5 -top-1.5 size-2.5 animate-spin text-primary" />
                  ) : (
                    <span className="absolute -right-1 -top-1 size-2 rounded-full bg-primary ring-2 ring-background" />
                  ))}
              </span>
            }
          >
            Chat
          </ConsoleNavLink>
          {mobileChatNavigation.statusMessage && (
            <span className="sr-only" role="status" aria-live="polite">
              Chat: {mobileChatNavigation.statusMessage}
            </span>
          )}
          {mailAvailable && (
            <ConsoleNavLink to="/mail" icon={<Mail className="size-4" />}>
              Mail
            </ConsoleNavLink>
          )}
          <ConsoleNavLink to="/integrations" icon={<Plug className="size-4" />}>
            Integrations
          </ConsoleNavLink>
          <ConsoleNavLink
            to="/capabilities"
            icon={<Network className="size-4" />}
          >
            Capabilities
          </ConsoleNavLink>
        </nav>
        <main className="min-h-0 flex-1 overflow-hidden bg-muted/30 pb-12 sm:pb-0">
          <Suspense fallback={<ConsoleRouteFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to={CHAT_WELCOME_PATH} replace />} />
              <Route path={CHAT_WELCOME_PATH} element={<ChatRoute />} />
              <Route path="/chat/new" element={<ChatRoute />} />
              <Route path="/chat/:threadId" element={<ChatRoute />} />
              <Route
                path="/mail"
                element={
                  !dashboard ? (
                    <ConsoleRouteFallback />
                  ) : mailAvailable ? (
                    <MailRoute />
                  ) : (
                    <Navigate to={CHAT_WELCOME_PATH} replace />
                  )
                }
              />
              <Route path="/integrations" element={<IntegrationsTab />} />
              <Route path="/capabilities" element={<CapabilitiesTab />} />
              <Route path="*" element={<Navigate to={CHAT_WELCOME_PATH} replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
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
        <span
          className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${dot}`}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-5">
            {agentName}
          </div>
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
  ariaLabel,
  children,
}: {
  to: string;
  icon: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      aria-label={ariaLabel}
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
