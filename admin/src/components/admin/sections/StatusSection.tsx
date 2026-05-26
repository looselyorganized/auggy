import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatusSection({ level, message }: { level: "ok" | "warn" | "error"; message: string }) {
  const Icon = level === "ok" ? CheckCircle2 : level === "warn" ? AlertTriangle : AlertCircle;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        level === "ok" && "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
        level === "warn" && "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
        level === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
