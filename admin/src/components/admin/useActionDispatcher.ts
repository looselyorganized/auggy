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
  /** Surface a destructive style on the confirm dialog. Defaults to false. */
  destructive?: boolean;
}

export interface UseActionDispatcher {
  dispatch: (opts: DispatchOpts) => Promise<void>;
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
      if (busy) return;
      if (opts.confirmRequired) {
        const ok = await confirm({
          message: opts.confirmMessage ?? "Confirm this action?",
          destructive: opts.destructive,
        });
        if (!ok) return;
      }
      const csrf = findCsrfToken(data?.csrfTokens ?? [], opts.actionId, opts.rowKey);
      if (!csrf) {
        push("error", `No CSRF token available for ${opts.actionId}. Reloading…`);
        await refresh();
        return;
      }
      setBusy(true);
      try {
        const result = await postAction(opts.actionId, csrf, opts.values, opts.rowKey);
        if (result.csrfExpired) {
          push("warn", "Session expired — refreshing.");
          window.location.reload();
          return;
        }
        push(result.ok ? "success" : "error", result.message || (result.ok ? "Done." : "Failed."));
        await refresh();
      } catch (err) {
        push("error", `Action failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, confirm, data, push, refresh],
  );

  return { dispatch, busy };
}
