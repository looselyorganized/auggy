import { lazy, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useChatWorkspace } from "@/components/admin/ChatWorkspaceProvider";
import { Button } from "@/components/ui/button";
import {
  CHAT_DRAFT_PATH,
  CHAT_WELCOME_PATH,
  chatThreadPath,
  parseChatRouteTarget,
} from "@/lib/chat-route";
import {
  advanceChatDraftRouteOwnership,
  createChatDraftRouteOwnership,
  type ChatDraftRouteObservation,
  type ChatDraftRouteOwnership,
} from "@/lib/chat-route-ownership";
import {
  getChatWorkspaceTargetById,
  getSelectedChatWorkspaceId,
} from "@/lib/chat-workspace-state";
import { useToast } from "@/lib/toast";

const ChatTab = lazy(() =>
  import("@/routes/ChatTab").then((module) => ({ default: module.ChatTab })),
);

type ChatRouteLookup =
  | { threadId: string; status: "loading" }
  | { threadId: string; status: "ready" }
  | { threadId: string; status: "not-found" }
  | { threadId: string; status: "error"; detail: string };

/**
 * Keeps the URL as the durable conversation selector. Thread details are lazy-loaded
 * so a copied deep link works without fetching every transcript into the sidebar.
 */
export function ChatRoute() {
  const location = useLocation();
  const route = parseChatRouteTarget(location.pathname);
  const {
    state,
    activeThread,
    confirmedDeletedThreadIds,
    hydrationStatus,
    hydrationError,
    loadThread,
    create,
    select,
    selectWelcome,
  } = useChatWorkspace();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState<ChatRouteLookup | null>(null);
  const draftRouteOwnershipRef = useRef<ChatDraftRouteOwnership>(
    createChatDraftRouteOwnership(),
  );
  const { push } = useToast();
  const lookupErrorToastRef = useRef<
    | { kind: "thread"; threadId: string; message: string }
    | null
  >(null);
  const threadId = route.kind === "thread" ? route.threadId : undefined;
  const routeTargetLifecycle = threadId
    ? getChatWorkspaceTargetById(state, threadId)?.lifecycle
    : undefined;
  const threadDeletionConfirmed = threadId
    ? confirmedDeletedThreadIds.has(threadId)
    : false;

  useEffect(() => {
    lookupErrorToastRef.current = null;
  }, [threadId]);

  useEffect(() => {
    if (route.kind === "welcome") selectWelcome();
  }, [route.kind, selectWelcome]);

  useEffect(() => {
    const exactDraftRoute =
      hydrationStatus === "ready" &&
      route.kind === "draft" &&
      location.pathname === CHAT_DRAFT_PATH;
    const observation: ChatDraftRouteObservation = exactDraftRoute
      ? {
          route: "draft",
          locationKey: location.key,
          localDraftId: state.draft?.id ?? null,
          durableThreadIds: state.durableThreads.map(({ id }) => id),
          selection: state.selection,
        }
      : { route: "outside" };
    const transition = advanceChatDraftRouteOwnership(
      draftRouteOwnershipRef.current,
      observation,
    );
    draftRouteOwnershipRef.current = transition.ownership;

    switch (transition.command?.type) {
      case "create-draft":
        create();
        break;
      case "select-draft":
        select(transition.command.draftId);
        break;
      case "navigate-welcome":
        navigate(CHAT_WELCOME_PATH, { replace: true });
        break;
      case "navigate-durable":
        navigate(chatThreadPath(transition.command.threadId), { replace: true });
        break;
    }
  }, [
    create,
    hydrationStatus,
    location.key,
    location.pathname,
    navigate,
    route.kind,
    select,
    state.durableThreads,
    state.draft?.id,
    state.selection,
  ]);

  useEffect(() => {
    if (hydrationStatus !== "ready" || !threadId) return;
    if (threadDeletionConfirmed) {
      setLookup({ threadId, status: "not-found" });
      return;
    }
    if (state.draft?.id === threadId) {
      setLookup({ threadId, status: "not-found" });
      return;
    }
    let current = true;
    setLookup({ threadId, status: "loading" });
    void loadThread(threadId).then(
      (found) => {
        if (current) {
          if (
            found &&
            lookupErrorToastRef.current?.kind === "thread" &&
            lookupErrorToastRef.current.threadId === threadId
          ) {
            lookupErrorToastRef.current = null;
          }
          setLookup({ threadId, status: found ? "ready" : "not-found" });
        }
      },
      (error: unknown) => {
        if (current) {
          const detail =
            error instanceof Error ? error.message : "The conversation is unavailable.";
          const previousToast =
            lookupErrorToastRef.current?.kind === "thread" &&
            lookupErrorToastRef.current.threadId === threadId
              ? lookupErrorToastRef.current
              : null;
          if (!previousToast || previousToast.message !== detail) {
            push("error", "Could not load this chat", detail);
            lookupErrorToastRef.current = {
              kind: "thread",
              threadId,
              message: detail,
            };
          }
          setLookup({
            threadId,
            status: "error",
            detail,
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [
    hydrationStatus,
    loadThread,
    routeTargetLifecycle,
    state.draft?.id,
    threadDeletionConfirmed,
    threadId,
    push,
  ]);

  const recoverFromMissingThread =
    threadDeletionConfirmed ||
    (lookup?.threadId === threadId && lookup?.status === "not-found");

  useEffect(() => {
    if (hydrationStatus !== "ready" || !threadId || !recoverFromMissingThread)
      return;
    navigate(CHAT_WELCOME_PATH, { replace: true });
  }, [hydrationStatus, navigate, recoverFromMissingThread, threadId]);

  if (route.kind === "outside") {
    return <Navigate to={CHAT_WELCOME_PATH} replace />;
  }

  if (route.kind === "draft" && location.pathname !== CHAT_DRAFT_PATH) {
    return <Navigate to={CHAT_DRAFT_PATH} replace />;
  }

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

  if (route.kind === "welcome") {
    return (
      <ChatWelcome
        onStart={() => {
          create();
          navigate(CHAT_DRAFT_PATH);
        }}
      />
    );
  }

  if (route.kind === "draft") {
    const selectedDraftId =
      state.selection.kind === "draft" ? state.selection.draftId : null;
    if (
      !state.draft ||
      selectedDraftId !== state.draft.id ||
      activeThread?.lifecycle !== "draft" ||
      activeThread.id !== state.draft.id
    ) {
      return <ChatRouteStatus title="Loading chat…" />;
    }
    return <ChatTab />;
  }

  if (lookup?.threadId !== threadId) {
    return <ChatRouteStatus title="Loading chat…" />;
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
        onAction={() => navigate(CHAT_WELCOME_PATH, { replace: true })}
      />
    );
  }

  // loadThread selects atomically. Do not render the previous conversation under
  // the requested URL while its detail is still resolving.
  if (
    lookup?.status !== "ready" ||
    getSelectedChatWorkspaceId(state) !== threadId ||
    activeThread?.id !== threadId ||
    activeThread.lifecycle !== "detail"
  ) {
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
