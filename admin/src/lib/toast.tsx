import { createContext, useCallback, useContext, type ReactNode } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export type ToastLevel = "info" | "success" | "warn" | "error";

interface ToastContextValue {
  push: (level: ToastLevel, title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function sentenceCase(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return message;
  return `${trimmed[0]!.toLocaleUpperCase()}${trimmed.slice(1)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const push = useCallback((level: ToastLevel, title: string, description?: string) => {
    const toastTitle = sentenceCase(title);
    const toastDescription =
      description === undefined ? undefined : sentenceCase(description);
    const toastOptions = toastDescription === undefined ? undefined : { description: toastDescription };

    if (level === "success") toast.success(toastTitle, toastOptions);
    else if (level === "warn") toast.warning(toastTitle, toastOptions);
    else if (level === "error") toast.error(toastTitle, toastOptions);
    else toast(toastTitle, toastOptions);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <Toaster />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export const NoopToast: ToastContextValue = {
  push: () => {},
};
