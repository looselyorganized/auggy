import { CircleAlert, LoaderCircle, Plus } from "lucide-react";

import type { ChatThread } from "@/lib/chat-workspace";
import { cn } from "@/lib/utils";

export interface ChatThreadNavProps {
  threads: ChatThread[];
  activeId: string;
  onNew: () => void;
  onSelect: (threadId: string) => void;
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
  onNew,
  onSelect,
  compact = false,
}: ChatThreadNavProps) {
  return (
    <nav
      aria-label="Chat conversations"
      className={cn("min-w-0", compact ? "flex items-center gap-2" : "grid gap-1")}
    >
      <div className={cn("min-w-0", compact && "sr-only")}>
        <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Chat
        </h2>
        <button
          type="button"
          onClick={onNew}
          className={cn(
            "inline-flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium",
            "text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">New chat</span>
        </button>
      </div>

      {compact && (
        <button
          type="button"
          onClick={onNew}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-md",
            "text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        {threads.map((thread) => (
          <ThreadButton
            key={thread.id}
            thread={thread}
            active={thread.id === activeId}
            compact={compact}
            onSelect={onSelect}
          />
        ))}
      </div>
    </nav>
  );
}

function ThreadButton({
  thread,
  active,
  compact,
  onSelect,
}: {
  thread: ChatThread;
  active: boolean;
  compact: boolean;
  onSelect: (threadId: string) => void;
}) {
  const runLabel = getRunLabel(thread.runStatus);
  const itemLabel = [thread.title, thread.unread ? "Unread" : null, runLabel]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      aria-current={active ? "page" : undefined}
      aria-label={itemLabel}
      title={itemLabel}
      className={cn(
        "group inline-flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        compact ? "max-w-48 shrink-0" : "w-full",
      )}
    >
      <span className="relative flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        {thread.runStatus === "streaming" ? (
          <LoaderCircle className="size-3 animate-spin text-primary" />
        ) : thread.runStatus === "error" || thread.runStatus === "interrupted" ? (
          <CircleAlert className="size-3 text-destructive" />
        ) : thread.unread ? (
          <span className="size-2 rounded-full bg-primary" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </span>
      <span className="truncate">{thread.title}</span>
      {(thread.runStatus === "error" || thread.runStatus === "interrupted") && (
        <span className="sr-only">{runLabel}</span>
      )}
      {thread.runStatus === "streaming" && <span className="sr-only">Streaming response</span>}
      {thread.unread && <span className="sr-only">Unread</span>}
    </button>
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
