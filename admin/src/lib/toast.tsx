import { createContext, useCallback, useContext, type ReactNode } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export type ToastLevel = "info" | "success" | "warn" | "error";

interface ToastContextValue {
  push: (level: ToastLevel, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function sentenceCase(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return message;
  return `${trimmed[0]!.toLocaleUpperCase()}${trimmed.slice(1)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const push = useCallback((level: ToastLevel, message: string) => {
    const text = sentenceCase(message);
    if (level === "success") toast.success(text);
    else if (level === "warn") toast.warning(text);
    else if (level === "error") toast.error(text);
    else toast(text);
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
