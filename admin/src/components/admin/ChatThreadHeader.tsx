import { useEffect, useState } from "react";
import { ChevronDown, Copy, Mail, Pencil, Trash2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH,
  validateRenamedChatThreadTitle,
  type ChatPreviewMode,
} from "@/lib/chat-workspace";
import { cn } from "@/lib/utils";

const PREVIEW_MODE_LABELS: Record<ChatPreviewMode, string> = {
  creator: "Verified creator",
  anonymous: "Anonymous",
  visitor: "Verified visitor",
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!renameOpen) setRenameValue(title);
  }, [renameOpen, title]);

  const openRenameDialog = () => {
    setRenameValue(title);
    setRenameError(null);
    setRenameOpen(true);
  };

  const submitRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateRenamedChatThreadTitle(renameValue);
    if (!validation.valid) {
      setRenameError(validation.message);
      return;
    }

    setRenaming(true);
    setRenameError(null);
    try {
      await onRename(validation.title);
      setRenameOpen(false);
    } catch (error) {
      setRenameError(actionErrorMessage(error, "Could not rename this chat."));
      onActionError?.("rename", error);
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    if (streaming) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
      setDeleteOpen(false);
    } catch (error) {
      setDeleteError(actionErrorMessage(error, "Could not delete this chat."));
      onActionError?.("delete", error);
    } finally {
      setDeleting(false);
    }
  };

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
    <>
      <header
        className={cn(
          "sticky top-0 z-20 border-b bg-background/90 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6",
          className,
        )}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "group flex min-w-0 max-w-full items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-left",
                "text-base font-medium text-foreground outline-none transition-colors hover:bg-muted",
                "focus-visible:ring-2 focus-visible:ring-ring",
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
              <DropdownMenuItem onClick={openRenameDialog}>
                <Pencil aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasMessages}
                onClick={() => void runAction("copy", onCopyTranscript)}
              >
                <Copy aria-hidden="true" />
                Copy transcript
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={unread}
                onClick={() => void runAction("mark-unread", onMarkUnread)}
              >
                <Mail aria-hidden="true" />
                {unread ? "Marked unread" : "Mark unread"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                disabled={streaming}
                onClick={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex min-w-0 flex-wrap items-center gap-2 px-1.5">
            <span className="text-xs text-muted-foreground">Preview as</span>
            <div
              className="flex min-w-0 flex-wrap items-center gap-0.5 rounded-md border bg-background/80 p-0.5"
              aria-label="Chat identity"
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
                      void runAction("preview-mode", () => onPreviewModeChange(mode))
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
                onClick={() => void runAction("clear-visitor", onClearVisitor)}
                className="h-7 px-2 text-[11px] text-muted-foreground"
              >
                Clear visitor
              </Button>
            )}
          </div>
        </div>
      </header>

      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (renaming) return;
          setRenameOpen(open);
          if (!open) setRenameError(null);
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void submitRename(event)}>
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>
                Give this conversation a title that will be easy to find later.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 grid gap-1.5">
              <Input
                autoFocus
                value={renameValue}
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  if (renameError) setRenameError(null);
                }}
                aria-label="Chat title"
                aria-invalid={Boolean(renameError)}
                aria-describedby="chat-title-help"
                disabled={renaming}
              />
              <div
                id="chat-title-help"
                className={cn(
                  "flex justify-between gap-3 text-xs",
                  renameError ? "text-destructive" : "text-muted-foreground",
                )}
              >
                <span>{renameError ?? "Titles cannot be empty."}</span>
                <span className="shrink-0">
                  {Array.from(renameValue.trim()).length}/{RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH}
                </span>
              </div>
            </div>
            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameOpen(false)}
                disabled={renaming}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming}>
                {renaming ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (deleting) return;
          setDeleteOpen(open);
          if (!open) setDeleteError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              This removes “{title}” and its transcript. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting || streaming}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function getPreviewModeDisabledReason(
  mode: ChatPreviewMode,
  options: Pick<
    ChatThreadHeaderProps,
    "anonymousAllowed" | "hasVisitorToken" | "previewModeDisabledReason"
  >,
): string | undefined {
  if (options.previewModeDisabledReason) return options.previewModeDisabledReason;
  if (mode === "anonymous" && !options.anonymousAllowed) {
    return "Anonymous chat is disabled for this agent.";
  }
  if (mode === "visitor" && !options.hasVisitorToken) {
    return "Verify a visitor before previewing as one.";
  }
  return undefined;
}

function actionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
