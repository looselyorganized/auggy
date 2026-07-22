import { useCallback, useState } from "react";
import { findCsrfToken, postAction } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useConfirm } from "@/lib/confirm";
import { useDashboardContext } from "@/components/admin/DashboardContext";

export interface DispatchOpts {
  actionId: string;
  rowKey?: string;
  values?: Record<string, string>;
  confirmRequired: boolean;
  confirmMessage?: string;
  /** Dashboard refresh timing after the action posts. Defaults to immediate. */
  refresh?: "immediate" | "deferred" | "none";
  /** Surface a destructive style on the confirm dialog. Defaults to false. */
  destructive?: boolean;
}

export interface UseActionDispatcher {
  dispatch: (opts: DispatchOpts) => Promise<boolean>;
  busy: boolean;
}

/**
 * Hook used by every button/form that POSTs an admin action. Looks up the
 * CSRF token from the dashboard's `csrfTokens` array (keyed by actionId +
 * rowKey), runs an optional confirm dialog (native confirm() in v1 — replaced
 * with shadcn Dialog in v1.1), posts, surfaces a toast, and refreshes the
 * dashboard so the change is visible without a page reload.
 */
export function useActionDispatcher(): UseActionDispatcher {
  const { data, refresh } = useDashboardContext();
  const { push } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const dispatch = useCallback(
    async (opts: DispatchOpts) => {
      if (busy) return false;
      if (opts.confirmRequired) {
        const ok = await confirm({
          message: opts.confirmMessage ?? "Confirm this action?",
          destructive: opts.destructive,
        });
        if (!ok) return false;
      }
      const csrf = findCsrfToken(data?.csrfTokens ?? [], opts.actionId, opts.rowKey);
      if (!csrf) {
        push(
          "error",
          "Action blocked",
          `No CSRF token available for ${actionLabel(opts.actionId)}. Reloading…`,
        );
        await refresh();
        return false;
      }
      setBusy(true);
      try {
        const result = await postAction(opts.actionId, csrf, opts.values, opts.rowKey);
        if (result.csrfExpired) {
          push("warn", "Session expired", `Refresh to continue ${actionLabel(opts.actionId)}.`);
          window.location.reload();
          return false;
        }
        const actionLabelText = `${actionLabel(opts.actionId)} ${result.ok ? "completed" : "failed"}`;
        push(
          result.ok ? "success" : "error",
          actionLabelText,
          result.message || (result.ok ? "Done." : "The action failed."),
        );
        const refreshMode = opts.refresh ?? "immediate";
        if (refreshMode === "immediate") {
          await refresh();
        } else if (refreshMode === "deferred") {
          globalThis.setTimeout(() => void refresh(), 350);
        }
        return result.ok;
      } catch (err) {
        push(
          "error",
          `${actionLabel(opts.actionId)} failed`,
          (err as Error).message || "Could not perform this action.",
        );
        if (opts.refresh === "deferred") {
          globalThis.setTimeout(() => void refresh(), 350);
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, confirm, data, push, refresh],
  );

  return { dispatch, busy };
}

function actionLabel(actionId: string): string {
  const label = actionId
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLocaleLowerCase();

  if (!label) return "Action";
  return label.replace(/\b\w/g, (char) => char.toLocaleUpperCase());
}
