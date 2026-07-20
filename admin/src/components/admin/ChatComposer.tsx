import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const COMPOSER_MAX_HEIGHT_PX = 144;

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  /** True only when this conversation owns the active stream. */
  streaming: boolean;
  onStop: () => void;
  agentName: string;
  /** Short, user-facing model name, for example `Claude Sonnet 4`. */
  modelDisplayName?: string | null;
  /** Exact provider and model identifier shown on hover/focus. */
  modelRawName?: string | null;
  className?: string;
}

/**
 * The intentionally small chat input surface. Thread identity and actions live
 * outside this component; the only action shown here is stopping its own run.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  disabledReason,
  streaming,
  onStop,
  agentName,
  modelDisplayName,
  modelRawName,
  className,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusId = useId();
  const inputDisabled = disabled || streaming;
  const inputStatus = streaming ? `${agentName} is responding.` : disabledReason;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset before measuring so the composer shrinks again after send/delete.
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;

    event.preventDefault();
    if (inputDisabled || !value.trim()) return;
    void onSend();
  }

  const model = modelDisplayName ? (
    modelRawName ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="max-w-48 truncate rounded-sm font-mono text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${modelDisplayName}: ${modelRawName}`}
            />
          }
        >
          {modelDisplayName}
        </TooltipTrigger>
        <TooltipContent>{modelRawName}</TooltipContent>
      </Tooltip>
    ) : (
      <span className="max-w-48 truncate font-mono text-[11px] text-muted-foreground">
        {modelDisplayName}
      </span>
    )
  ) : null;

  return (
    <div
      className={cn(
        "rounded-2xl border bg-card/95 px-3 pb-2.5 pt-3 shadow-lg backdrop-blur",
        className,
      )}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Message ${agentName}…`}
        rows={1}
        disabled={inputDisabled}
        aria-label={`Message ${agentName}`}
        aria-describedby={inputStatus ? statusId : undefined}
        title={inputStatus}
        className="max-h-36 min-h-12 resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none focus-visible:ring-0"
      />

      <div className="mt-1 flex min-h-8 items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          {streaming ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onStop}
              aria-label="Stop response"
              className="-ml-2 h-7 px-2 text-xs"
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
              Stop
            </Button>
          ) : disabledReason ? (
            <span className="block truncate text-[11px] text-muted-foreground">
              {disabledReason}
            </span>
          ) : null}
        </div>
        {model}
      </div>
      {inputStatus ? (
        <span id={statusId} role="status" className="sr-only">
          {inputStatus}
        </span>
      ) : null}
    </div>
  );
}
