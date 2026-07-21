import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatPreviewMode } from "@/lib/chat-workspace";
import type { VisitorIdentityState } from "@/lib/visitor-identity-api";
import { cn } from "@/lib/utils";

const PREVIEW_MODE_LABELS: Record<ChatPreviewMode, string> = {
  creator: "Creator",
  anonymous: "Anonymous",
  visitor: "Verified",
};

interface AuthIdentityControlProps {
  previewMode: ChatPreviewMode;
  anonymousAllowed: boolean;
  hasVisitorToken: boolean;
  visitorIdentity: VisitorIdentityState;
  disabledReason?: string;
  onPreviewModeChange: (mode: ChatPreviewMode) => void | Promise<void>;
  onForgetVisitor: () => void | Promise<void>;
  onActionError?: (action: "preview-mode" | "clear-visitor", error: unknown) => void;
}

export function AuthIdentityControl({
  previewMode,
  anonymousAllowed,
  hasVisitorToken,
  visitorIdentity,
  disabledReason,
  onPreviewModeChange,
  onForgetVisitor,
  onActionError,
}: AuthIdentityControlProps) {
  const runAction = async (
    action: "preview-mode" | "clear-visitor",
    callback: () => void | Promise<void>,
  ) => {
    try {
      await callback();
    } catch (error) {
      onActionError?.(action, error);
    }
  };
  const verified = visitorIdentity.status === "verified";
  const verifiedDisabledReason = getPreviewModeDisabledReason("visitor", {
    anonymousAllowed,
    hasVisitorToken,
    visitorIdentity,
    disabledReason,
  });

  return (
    <div className="pointer-events-auto ml-auto flex min-w-0 max-w-[70%] shrink items-center gap-1 overflow-x-auto rounded-lg border border-border/60 bg-background/75 p-1 pl-2 shadow-sm backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <span className="shrink-0 text-xs text-muted-foreground">Auth</span>
      <div className="flex min-w-0 flex-nowrap items-center gap-0.5" aria-label="Preview chat as" role="group">
        {(["creator", "anonymous"] as const).map((mode) => {
          const modeDisabledReason = getPreviewModeDisabledReason(mode, {
            anonymousAllowed,
            hasVisitorToken,
            visitorIdentity,
            disabledReason,
          });
          return (
            <ModeButton
              key={mode}
              mode={mode}
              selected={previewMode === mode}
              disabledReason={modeDisabledReason}
              onSelect={() => void runAction("preview-mode", () => onPreviewModeChange(mode))}
            />
          );
        })}

        <div className="group/identity flex items-center gap-0.5">
          <ModeButton
            mode="visitor"
            selected={previewMode === "visitor"}
            disabledReason={verifiedDisabledReason}
            status={visitorIdentity.status}
            verified={verified}
            onSelect={() =>
              void runAction("preview-mode", () => onPreviewModeChange("visitor"))
            }
          />

          {verified && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={Boolean(disabledReason)}
                    aria-label="Show available verified identity"
                    className="text-emerald-600 dark:text-emerald-400"
                  />
                }
              >
                <ChevronDown className="size-3" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <VerifiedIdentityDetails identity={visitorIdentity} />
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  disabled={Boolean(disabledReason)}
                  onClick={() => void runAction("clear-visitor", onForgetVisitor)}
                >
                  <X aria-hidden="true" />
                  Forget local identity
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {hasVisitorToken && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={Boolean(disabledReason)}
                    onClick={() => void runAction("clear-visitor", onForgetVisitor)}
                    aria-label="Forget local verified identity"
                    className={cn(
                      "pointer-events-none opacity-0 transition-opacity",
                      "group-hover/identity:pointer-events-auto group-hover/identity:opacity-100",
                      "focus:pointer-events-auto focus:opacity-100 group-focus-within/identity:pointer-events-auto group-focus-within/identity:opacity-100",
                    )}
                  />
                }
              >
                <X aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Forget local verified identity</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  mode,
  selected,
  disabledReason,
  status,
  verified = false,
  onSelect,
}: {
  mode: ChatPreviewMode;
  selected: boolean;
  disabledReason?: string;
  status?: VisitorIdentityState["status"];
  verified?: boolean;
  onSelect: () => void;
}) {
  const button = (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      onClick={onSelect}
      disabled={Boolean(disabledReason)}
      aria-pressed={selected}
      className={cn(
        "h-7 rounded-sm px-2 text-[11px]",
        verified && "text-emerald-600 dark:text-emerald-400",
        verified && selected &&
          "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300",
      )}
    >
      {status === "checking" && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
      {verified && <Check className="size-3" aria-hidden="true" />}
      {PREVIEW_MODE_LABELS[mode]}
    </Button>
  );
  if (!disabledReason) return button;
  return (
    <Tooltip>
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
}

export function VerifiedIdentityDetails({
  identity,
}: {
  identity: Extract<VisitorIdentityState, { status: "verified" }>;
}) {
  return (
    <div className="px-2 py-2" aria-label="Available verified identity">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" aria-hidden="true" />
        </span>
        Available verified identity
      </div>
      <p className="mt-1 truncate pl-7 text-xs text-muted-foreground" title={identity.email}>
        {identity.email}
      </p>
    </div>
  );
}

function getPreviewModeDisabledReason(
  mode: ChatPreviewMode,
  options: {
    anonymousAllowed: boolean;
    hasVisitorToken: boolean;
    visitorIdentity: VisitorIdentityState;
    disabledReason?: string;
  },
): string | undefined {
  if (options.disabledReason) return options.disabledReason;
  if (mode === "anonymous" && !options.anonymousAllowed) {
    return "Anonymous chat is disabled for this agent.";
  }
  if (mode !== "visitor") return undefined;
  if (!options.hasVisitorToken || options.visitorIdentity.status === "absent") {
    return "Verify a visitor before previewing as one.";
  }
  if (options.visitorIdentity.status === "checking") {
    return "Checking the verified visitor identity.";
  }
  if (options.visitorIdentity.status === "invalid") {
    return options.visitorIdentity.error;
  }
  if (options.visitorIdentity.status === "unavailable") {
    return options.visitorIdentity.error;
  }
  return undefined;
}
