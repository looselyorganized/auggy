import {
  CircleAlert,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
} from "lucide-react";

import {
  ChatThreadDeleteMenuItem,
  ChatThreadMutationDialogs,
  ChatThreadRenameMenuItem,
  type ChatThreadMutationControls,
} from "@/components/admin/ChatThreadMutationDialogs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatThread } from "@/lib/chat-workspace";
import { cn } from "@/lib/utils";

export interface ChatThreadNavProps {
  threads: ChatThread[];
  activeId: string;
  loading?: boolean;
  error?: string | null;
  onNew: () => void;
  onSelect: (threadId: string) => void;
  onRename?: (threadId: string, title: string) => void | Promise<void>;
  onDelete?: (threadId: string) => void | Promise<void>;
  deletingThreadIds?: ReadonlySet<string>;
  /** Uses a horizontal, overflow-safe layout suitable for the mobile chat picker. */
  compact?: boolean;
}

/**
 * Conversation navigation shared by the desktop sidebar and compact mobile picker.
 * Ordering is controlled by the caller so it can later follow persisted `updatedAt` values.
 */
export function ChatThreadNav({
  threads,
  activeId,
  loading = false,
  error = null,
  onNew,
  onSelect,
  onRename,
  onDelete,
  deletingThreadIds,
  compact = false,
}: ChatThreadNavProps) {
  return (
    <nav
      aria-label="Chat conversations"
      className={cn(
        "min-w-0",
        compact ? "flex items-center gap-2" : "grid gap-1",
      )}
    >
      <div className={cn("min-w-0", compact ? "sr-only" : "pt-2")}>
        <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Chat
        </h2>
        <button
          type="button"
          onClick={onNew}
          disabled={loading || Boolean(error)}
          className={cn(
            "inline-flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium",
            "text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-wait disabled:opacity-50",
          )}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">New</span>
        </button>
      </div>

      {compact && (
        <button
          type="button"
          onClick={onNew}
          disabled={loading || Boolean(error)}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-md",
            "text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-wait disabled:opacity-50",
          )}
          aria-label="New chat"
          title="New chat"
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      )}

      <div
        className={cn(
          "min-w-0",
          compact
            ? "flex flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "grid gap-0.5",
        )}
      >
        {loading || error ? (
          <div
            className={cn(
              "flex h-9 items-center gap-2 px-2 text-xs text-muted-foreground",
              compact && "shrink-0",
            )}
            role={error ? "alert" : "status"}
            title={error ?? undefined}
          >
            {loading ? (
              <LoaderCircle
                className="size-3 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                className="size-3 text-destructive"
                aria-hidden="true"
              />
            )}
            <span>{loading ? "Loading chats…" : "Chats unavailable"}</span>
          </div>
        ) : (
          threads.map((thread) => (
            <ThreadButton
              key={thread.id}
              thread={thread}
              active={thread.id === activeId}
              compact={compact}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              deleting={deletingThreadIds?.has(thread.id) ?? false}
            />
          ))
        )}
      </div>
    </nav>
  );
}

function ThreadButton({
  thread,
  active,
  compact,
  onSelect,
  onRename,
  onDelete,
  deleting,
}: {
  thread: ChatThread;
  active: boolean;
  compact: boolean;
  onSelect: (threadId: string) => void;
  onRename?: (threadId: string, title: string) => void | Promise<void>;
  onDelete?: (threadId: string) => void | Promise<void>;
  deleting: boolean;
}) {
  const runLabel = getRunLabel(thread.runStatus);
  const itemLabel = [thread.title, thread.unread ? "Unread" : null, runLabel]
    .filter(Boolean)
    .join(", ");
  const streaming = thread.runStatus === "streaming";
  const row = (mutationControls?: ChatThreadMutationControls) => (
    <ThreadRow
      thread={thread}
      itemLabel={itemLabel}
      active={active}
      compact={compact}
      deleting={deleting}
      onSelect={onSelect}
      mutationControls={mutationControls}
    />
  );

  if (compact || !onRename || !onDelete) return row();

  return (
    <ChatThreadMutationDialogs
      title={thread.title}
      renameDisabled={streaming || deleting}
      deleteDisabled={streaming || deleting}
      deletePending={deleting}
      onRename={(title) => onRename(thread.id, title)}
      onDelete={() => onDelete(thread.id)}
    >
      {row}
    </ChatThreadMutationDialogs>
  );
}

interface ThreadRowProps {
  thread: ChatThread;
  itemLabel: string;
  active: boolean;
  compact: boolean;
  deleting: boolean;
  onSelect: (threadId: string) => void;
  mutationControls?: ChatThreadMutationControls;
}

function ThreadRow({
  thread,
  itemLabel,
  active,
  compact,
  deleting,
  onSelect,
  mutationControls,
}: ThreadRowProps) {
  return (
    <div
      className={cn(
        "group flex h-9 min-w-0 items-center rounded-md text-sm transition-colors",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        compact ? "max-w-48 shrink-0" : "w-full",
        deleting && "pointer-events-none opacity-50",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        aria-current={active ? "page" : undefined}
        aria-label={itemLabel}
        title={itemLabel}
        className={cn(
          "inline-flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <ThreadStatusIcon thread={thread} />
        <span className="truncate">{thread.title}</span>
      </button>

      {mutationControls && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "pointer-events-none mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity",
              "hover:bg-background/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100",
            )}
            aria-label={`Actions for ${thread.title}`}
            title="Chat actions"
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <ChatThreadRenameMenuItem
              disabled={thread.runStatus === "streaming" || deleting}
              onClick={mutationControls.openRename}
            />
            <DropdownMenuSeparator />
            <ChatThreadDeleteMenuItem
              disabled={thread.runStatus === "streaming" || deleting}
              onClick={mutationControls.openDelete}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ThreadStatusIcon({ thread }: { thread: ChatThread }) {
  return (
    <MessageSquare
      className={cn(
        "size-3 shrink-0",
        thread.runStatus === "error" || thread.runStatus === "interrupted"
          ? "text-destructive"
          : thread.runStatus === "streaming" || thread.unread
            ? "text-primary"
            : "text-muted-foreground",
      )}
      aria-hidden="true"
    />
  );
}

function getRunLabel(status: ChatThread["runStatus"]): string | null {
  switch (status) {
    case "streaming":
      return "Streaming response";
    case "error":
      return "Response failed";
    case "interrupted":
      return "Response interrupted";
    default:
      return null;
  }
}
