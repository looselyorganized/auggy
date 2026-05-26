import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastLevel = "info" | "success" | "warn" | "error";

interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
}

interface ToastContextValue {
  push: (level: ToastLevel, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (level: ToastLevel, message: string) => {
      idRef.current += 1;
      const id = idRef.current;
      setToasts((prev) => [...prev, { id, level, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start justify-between gap-3 rounded-md border bg-background p-3 shadow-lg",
              t.level === "success" && "border-emerald-500/50",
              t.level === "warn" && "border-amber-500/50",
              t.level === "error" && "border-destructive/50",
            )}
            role="status"
            aria-live="polite"
          >
            <div className="text-sm">{t.message}</div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

// Stable noop fallback so call sites outside a provider don't crash (used by
// tests). Kept separate from the throwing `useToast` for explicitness.
export const NoopToast: ToastContextValue = {
  push: () => {},
};

// Auto-dismiss is exposed for tests that need to wait it out.
export const TOAST_AUTO_DISMISS_MS = AUTO_DISMISS_MS;

// Convenience re-exports so consumers only import from one place.
export { type Toast };
useEffect; // tree-shake hint — keep import
