import { ChevronDown, Copy, Mail } from "lucide-react";

import { AuthIdentityControl } from "@/components/admin/AuthIdentityControl";
import {
  ChatThreadDeleteMenuItem,
  ChatThreadMutationDialogs,
  ChatThreadRenameMenuItem,
} from "@/components/admin/ChatThreadMutationDialogs";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatPreviewMode } from "@/lib/chat-workspace";
import type { VisitorIdentityState } from "@/lib/visitor-identity-api";
import { cn } from "@/lib/utils";

export type ChatThreadHeaderAction =
  | "preview-mode"
  | "rename"
  | "copy"
  | "mark-unread"
  | "clear-visitor"
  | "delete";

export interface ChatThreadHeaderProps {
  title: string;
  previewMode: ChatPreviewMode;
  hasMessages: boolean;
  unread: boolean;
  streaming: boolean;
  anonymousAllowed: boolean;
  hasVisitorToken: boolean;
  visitorIdentity: VisitorIdentityState;
  /** Disables every identity option, for example while any chat owns the global stream. */
  previewModeDisabledReason?: string;
  onPreviewModeChange: (mode: ChatPreviewMode) => void | Promise<void>;
  onRename: (title: string) => void | Promise<void>;
  onCopyTranscript: () => void | Promise<void>;
  onMarkUnread: () => void | Promise<void>;
  onClearVisitor: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  /** Receives rejected callbacks so the shell can surface a toast or telemetry. */
  onActionError?: (action: ChatThreadHeaderAction, error: unknown) => void;
  className?: string;
}

/**
 * Presentational thread chrome. Conversation state and mutations stay with the
 * workspace so this header can be reused unchanged once chats are persisted.
 */
export function ChatThreadHeader({
  title,
  previewMode,
  hasMessages,
  unread,
  streaming,
  anonymousAllowed,
  hasVisitorToken,
  visitorIdentity,
  previewModeDisabledReason,
  onPreviewModeChange,
  onRename,
  onCopyTranscript,
  onMarkUnread,
  onClearVisitor,
  onDelete,
  onActionError,
  className,
}: ChatThreadHeaderProps) {
  const runAction = async (
    action: Exclude<ChatThreadHeaderAction, "rename" | "delete">,
    callback: () => void | Promise<void>,
  ) => {
    try {
      await callback();
    } catch (error) {
      onActionError?.(action, error);
    }
  };

  return (
    <ChatThreadMutationDialogs
      title={title}
      renameDisabled={streaming}
      deleteDisabled={streaming}
      onRename={onRename}
      onDelete={onDelete}
    >
      {({ openRename, openDelete }) => (
        <header
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-40 px-3 pb-8 pt-3 sm:pl-6 sm:pr-28",
            "bg-gradient-to-b from-background via-background/90 to-transparent",
            className,
          )}
        >
          <div className="flex w-full items-center justify-between gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "pointer-events-auto group flex min-w-0 max-w-[40%] items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left shadow-none",
                  "text-base font-medium text-foreground outline-none transition-colors hover:bg-background/75",
                  "focus-visible:bg-background/75 focus-visible:ring-1 focus-visible:ring-border",
                )}
                aria-label={`${title}. Open chat actions`}
              >
                <span className="truncate">{title}</span>
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-data-popup-open:rotate-180"
                  aria-hidden="true"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <ChatThreadRenameMenuItem
                  disabled={streaming}
                  onClick={openRename}
                />
                <DropdownMenuItem
                  disabled={!hasMessages}
                  onClick={() => void runAction("copy", onCopyTranscript)}
                >
                  <Copy aria-hidden="true" />
                  Copy transcript
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={unread || streaming}
                  onClick={() => void runAction("mark-unread", onMarkUnread)}
                >
                  <Mail aria-hidden="true" />
                  {unread ? "Marked unread" : "Mark unread"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <ChatThreadDeleteMenuItem
                  disabled={streaming}
                  onClick={openDelete}
                />
              </DropdownMenuContent>
            </DropdownMenu>

            <AuthIdentityControl
              previewMode={previewMode}
              anonymousAllowed={anonymousAllowed}
              hasVisitorToken={hasVisitorToken}
              visitorIdentity={visitorIdentity}
              disabledReason={previewModeDisabledReason}
              onPreviewModeChange={onPreviewModeChange}
              onForgetVisitor={onClearVisitor}
              onActionError={onActionError}
            />
          </div>
        </header>
      )}
    </ChatThreadMutationDialogs>
  );
}
