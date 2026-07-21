import { ChevronDown, Copy, Mail } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChatPreviewMode } from "@/lib/chat-workspace";
import { cn } from "@/lib/utils";

const PREVIEW_MODE_LABELS: Record<ChatPreviewMode, string> = {
  creator: "Creator",
  anonymous: "Anonymous",
  visitor: "Verified",
};

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

            <div className="pointer-events-auto ml-auto flex min-w-0 max-w-[70%] shrink items-center gap-2 overflow-x-auto rounded-lg border border-border/60 bg-background/75 p-1 pl-2 shadow-sm backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="shrink-0 text-xs text-muted-foreground">
                Auth
              </span>
              <div
                className="flex min-w-0 flex-nowrap items-center gap-0.5"
                aria-label="Preview chat as"
                role="group"
              >
                {(["creator", "anonymous", "visitor"] as const).map((mode) => {
                  const disabledReason = getPreviewModeDisabledReason(mode, {
                    anonymousAllowed,
                    hasVisitorToken,
                    previewModeDisabledReason,
                  });
                  const button = (
                    <Button
                      type="button"
                      variant={previewMode === mode ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() =>
                        void runAction("preview-mode", () =>
                          onPreviewModeChange(mode),
                        )
                      }
                      disabled={Boolean(disabledReason)}
                      aria-pressed={previewMode === mode}
                      className="h-7 rounded-sm px-2 text-[11px]"
                    >
                      {PREVIEW_MODE_LABELS[mode]}
                    </Button>
                  );

                  if (!disabledReason) return <span key={mode}>{button}</span>;

                  return (
                    <Tooltip key={mode}>
                      <TooltipTrigger
                        render={
                          <span
                            className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            tabIndex={0}
                            aria-label={`${PREVIEW_MODE_LABELS[mode]} unavailable: ${disabledReason}`}
                          />
                        }
                      >
                        {button}
                      </TooltipTrigger>
                      <TooltipContent>{disabledReason}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
              {hasVisitorToken && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(previewModeDisabledReason)}
                  onClick={() =>
                    void runAction("clear-visitor", onClearVisitor)
                  }
                  className="h-7 px-2 text-[11px] text-muted-foreground"
                >
                  Clear visitor
                </Button>
              )}
            </div>
          </div>
        </header>
      )}
    </ChatThreadMutationDialogs>
  );
}

function getPreviewModeDisabledReason(
  mode: ChatPreviewMode,
  options: Pick<
    ChatThreadHeaderProps,
    "anonymousAllowed" | "hasVisitorToken" | "previewModeDisabledReason"
  >,
): string | undefined {
  if (options.previewModeDisabledReason)
    return options.previewModeDisabledReason;
  if (mode === "anonymous" && !options.anonymousAllowed) {
    return "Anonymous chat is disabled for this agent.";
  }
  if (mode === "visitor" && !options.hasVisitorToken) {
    return "Verify a visitor before previewing as one.";
  }
  return undefined;
}
