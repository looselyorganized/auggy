import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH,
  validateRenamedChatThreadTitle,
} from "@/lib/chat-workspace";
import { cn } from "@/lib/utils";

export interface ChatThreadMutationControls {
  openRename: () => void;
  openDelete: () => void;
}

interface ChatThreadMutationDialogsProps {
  title: string;
  renameDisabled?: boolean;
  deleteDisabled?: boolean;
  deletePending?: boolean;
  onRename: (title: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  children: (controls: ChatThreadMutationControls) => ReactNode;
}

/**
 * Owns the shared rename/delete flow used by both thread chrome surfaces.
 * Persistence and navigation remain with the caller; this component only
 * coordinates validation, progress, and contextual errors.
 */
export function ChatThreadMutationDialogs({
  title,
  renameDisabled = false,
  deleteDisabled = false,
  deletePending = false,
  onRename,
  onDelete,
  children,
}: ChatThreadMutationDialogsProps) {
  const renameHelpId = useId();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteBusy = deleting || deletePending;

  useEffect(() => {
    if (!renameOpen) setRenameValue(title);
  }, [renameOpen, title]);

  const openRename = () => {
    if (renameDisabled) return;
    setRenameValue(title);
    setRenameError(null);
    setRenameOpen(true);
  };

  const openDelete = () => {
    if (deleteDisabled || deleteBusy) return;
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (renameDisabled || renaming) return;
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
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    if (deleteDisabled || deleteBusy) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(actionErrorMessage(error, "Could not delete this chat."));
      setDeleting(false);
    }
  };

  return (
    <>
      {children({ openRename, openDelete })}

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
                aria-describedby={renameHelpId}
                disabled={renaming}
              />
              <div
                id={renameHelpId}
                className={cn(
                  "flex justify-between gap-3 text-xs",
                  renameError ? "text-destructive" : "text-muted-foreground",
                )}
              >
                <span>{renameError ?? "Titles cannot be empty."}</span>
                <span className="shrink-0">
                  {Array.from(renameValue.trim()).length}/
                  {RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH}
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
              <Button type="submit" disabled={renaming || renameDisabled}>
                {renaming ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (deleteBusy) return;
          setDeleteOpen(open);
          if (!open) setDeleteError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              This removes “{title}” and its transcript. This action cannot be
              undone.
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
              disabled={deleteBusy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy || deleteDisabled}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ChatThreadRenameMenuItem({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem disabled={disabled} onClick={onClick}>
      <Pencil aria-hidden="true" />
      Rename
    </DropdownMenuItem>
  );
}

export function ChatThreadDeleteMenuItem({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem
      destructive
      disabled={disabled}
      className="!text-red-600 data-highlighted:!bg-red-500/10 data-highlighted:!text-red-700 dark:!text-red-400 dark:data-highlighted:!text-red-300"
      onClick={onClick}
    >
      <Trash2 aria-hidden="true" />
      Delete
    </DropdownMenuItem>
  );
}

function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
