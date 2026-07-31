import { useCallback, useState } from "react";
import { findCsrfToken, findUniqueActionAugment, postAction } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useConfirm } from "@/lib/confirm";
import { useDashboardContext } from "@/components/admin/DashboardContext";

export interface DispatchOpts {
  /** Exact augment owner for augment actions. Built-in console actions omit it. */
  augmentName?: string;
  actionId: string;
  rowKey?: string;
  values?: Record<string, string>;
  toast: {
    action: string;
    successTitle: string;
    successDescription: string;
    errorTitle: string;
    errorDescription: string;
  };
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
      const tokens = data?.csrfTokens ?? [];
      const augmentName =
        opts.augmentName ?? findUniqueActionAugment(tokens, opts.actionId, opts.rowKey);
      const csrf = findCsrfToken(tokens, opts.actionId, opts.rowKey, augmentName);
      if (!csrf) {
        push(
          "error",
          opts.toast.errorTitle,
          `Reload the console and try again to ${opts.toast.action}.`,
        );
        await refresh();
        return false;
      }
      setBusy(true);
      try {
        const result = await postAction(
          opts.actionId,
          csrf,
          opts.values,
          opts.rowKey,
          augmentName,
        );
        if (result.csrfExpired) {
          push(
            "warn",
            "Session expired",
            `Reloading so you can ${opts.toast.action}.`,
          );
          window.location.reload();
          return false;
        }
        push(
          result.ok ? "success" : "error",
          result.ok ? opts.toast.successTitle : opts.toast.errorTitle,
          result.message ||
            (result.ok
              ? opts.toast.successDescription
              : opts.toast.errorDescription),
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
          opts.toast.errorTitle,
          err instanceof Error && err.message
            ? err.message
            : opts.toast.errorDescription,
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
