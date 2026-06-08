import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchDashboard } from "@/lib/api";
import type { DashboardData } from "@/lib/types";

const POLL_INTERVAL_MS = 5000;

export interface DashboardState {
  data: DashboardData | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  updateData: (updater: (current: DashboardData) => DashboardData) => void;
}

/**
 * v1 polls `/console/api/dashboard`. SSE migration is queued in
 * `docs/21-console.md` (Deferred). The hook keeps the latest payload between
 * polls so the UI doesn't flicker; only the first fetch flips `loading: true`.
 */
export function useDashboard(): DashboardState {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const ctrl = new AbortController();
    const run = (async () => {
      try {
        const next = await fetchDashboard(ctrl.signal);
        if (!mountedRef.current) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      } finally {
        if (mountedRef.current) setLoading(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = run;
    return run;
  }, []);

  const updateData = useCallback((updater: (current: DashboardData) => DashboardData) => {
    setData((current) => (current ? updater(current) : current));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return useMemo(
    () => ({ data, error, loading, refresh, updateData }),
    [data, error, loading, refresh, updateData],
  );
}
