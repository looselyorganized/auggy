import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { LoaderCircle, MessageSquare, Network, Plug, Plus } from "lucide-react";
import { ChatThreadNav } from "@/components/admin/ChatThreadNav";
import {
  ChatWorkspaceProvider,
  useChatWorkspace,
} from "@/components/admin/ChatWorkspaceProvider";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/button";
import { ToastProvider } from "@/lib/toast";
import { ConfirmProvider } from "@/lib/confirm";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { useDashboard } from "@/hooks/useDashboard";
import {
  chatThreadPath,
  decodeChatThreadRouteParam,
  getChatNavigationState,
  isChatThreadActuallyVisible,
} from "@/lib/chat-route";
import { getMobileChatNavigationState } from "@/lib/chat-run-state";
import { cn } from "@/lib/utils";

const ChatTab = lazy(() =>
  import("@/routes/ChatTab").then((m) => ({ default: m.ChatTab })),
);
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
    ephemeralDraftId,
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
  const chatRouteActive = location.pathname.startsWith("/chat");
  const routedThreadId = decodeChatThreadRouteParam(
    matchPath("/chat/:threadId", location.pathname)?.params.threadId,
  );
  const chatVisible = isChatThreadActuallyVisible({
    chatRouteActive,
    documentVisible,
    routedThreadId,
    activeThreadId: state.activeThreadId,
  });
  const { activeId: activeNavId, threads } = getChatNavigationState({
    threads: state.threads,
    chatRouteActive,
    routedThreadId,
    activeThreadId: state.activeThreadId,
    ephemeralDraftId,
  });
  const mobileChatNavigation = getMobileChatNavigationState(
    state.threads,
    chatRouteActive,
  );

  useEffect(() => setChatVisible(chatVisible), [chatVisible, setChatVisible]);
  const openNewChat = () => {
    const threadId = create();
    navigate(chatThreadPath(threadId));
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
    if (!(await deleteThread(threadId))) {
      throw new Error(
        "This chat cannot be deleted while its response is running.",
      );
    }
    if (!routedThreadId || routedThreadId === threadId) {
      navigate("/chat", { replace: true });
    }
  };
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
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
            to="/chat"
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
              <Route path="/" element={<Navigate to="/chat" replace />} />
              <Route path="/chat" element={<ChatRoute />} />
              <Route path="/chat/:threadId" element={<ChatRoute />} />
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

type ChatRouteLookup =
  | { threadId: string; status: "loading" }
  | { threadId: string; status: "ready" }
  | { threadId: string; status: "not-found" }
  | { threadId: string; status: "error"; detail: string };

/**
 * Keeps the URL as the durable conversation selector. Thread details are lazy-loaded
 * so a copied deep link works without fetching every transcript into the sidebar.
 */
function ChatRoute() {
  const { threadId } = useParams<{ threadId?: string }>();
  const {
    state,
    activeThread,
    hydrationStatus,
    hydrationError,
    loadThread,
    create,
  } = useChatWorkspace();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState<ChatRouteLookup | null>(null);

  useEffect(() => {
    if (hydrationStatus !== "ready" || !threadId) return;
    let current = true;
    setLookup({ threadId, status: "loading" });
    void loadThread(threadId).then(
      (found) => {
        if (current)
          setLookup({ threadId, status: found ? "ready" : "not-found" });
      },
      (error: unknown) => {
        if (current) {
          setLookup({
            threadId,
            status: "error",
            detail:
              error instanceof Error
                ? error.message
                : "The conversation is unavailable.",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [hydrationStatus, loadThread, threadId]);

  const requestedThreadWasRemoved =
    Boolean(threadId) &&
    lookup?.threadId === threadId &&
    lookup?.status === "ready" &&
    !state.threads.some((candidate) => candidate.id === threadId);
  const recoverFromMissingThread =
    lookup?.threadId === threadId &&
    (lookup?.status === "not-found" || requestedThreadWasRemoved);

  useEffect(() => {
    if (hydrationStatus !== "ready" || !threadId || !recoverFromMissingThread)
      return;
    navigate("/chat", { replace: true });
  }, [hydrationStatus, navigate, recoverFromMissingThread, threadId]);

  if (hydrationStatus === "loading") {
    return <ChatRouteStatus title="Loading chat…" />;
  }

  if (hydrationStatus === "error") {
    return (
      <ChatRouteStatus
        title="Could not load chats"
        detail={hydrationError ?? "The conversation list is unavailable."}
        actionLabel="Try again"
        onAction={() => window.location.reload()}
      />
    );
  }

  if (threadId && lookup?.threadId !== threadId) {
    return <ChatRouteStatus title="Loading chat…" />;
  }

  if (!threadId) {
    return (
      <ChatWelcome
        onStart={() => {
          const createdThreadId = create();
          navigate(chatThreadPath(createdThreadId));
        }}
      />
    );
  }

  if (lookup?.status === "loading") {
    return <ChatRouteStatus title="Loading chat…" />;
  }

  if (recoverFromMissingThread) {
    return <ChatRouteStatus title="Loading chat…" />;
  }

  if (lookup?.status === "error") {
    return (
      <ChatRouteStatus
        title="Could not load this chat"
        detail={lookup.detail}
        actionLabel="Back to chats"
        onAction={() => navigate("/chat", { replace: true })}
      />
    );
  }

  // loadThread selects atomically. Do not render the previous conversation under
  // the requested URL while its detail is still resolving.
  if (lookup?.status !== "ready" || activeThread.id !== threadId) {
    return <ChatRouteStatus title="Loading chat…" />;
  }

  return <ChatTab />;
}

function ChatWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="auggy-grid-surface grid h-full place-items-center overflow-hidden bg-background px-6 py-12">
      <div className="max-w-md text-center">
        <img
          src="/console/brand/auggy-wave.png"
          alt=""
          className="mx-auto h-44 w-44 object-contain drop-shadow-lg sm:h-52 sm:w-52"
        />
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          Say hi to Auggy
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          Start a chat to test your agent, or pick up an existing conversation
          from the sidebar.
        </p>
        <Button type="button" onClick={onStart} className="mt-6">
          <Plus className="size-4" aria-hidden="true" />
          Start a chat
        </Button>
      </div>
    </div>
  );
}

function ChatRouteStatus({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-sm text-center">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {detail && (
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        )}
        {actionLabel && onAction && (
          <button
            type="button"
            className="mt-4 rounded-md border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        )}
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
