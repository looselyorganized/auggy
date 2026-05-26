import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboard } from "@/lib/api";
import type { DashboardData } from "@/lib/types";

const POLL_INTERVAL_MS = 2000;

export interface DashboardState {
  data: DashboardData | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * v1 polls `/console/api/dashboard` every 2s. SSE migration is queued in
 * `docs/21-console.md` (Deferred). The hook keeps the latest payload between
 * polls so the UI doesn't flicker; only the first fetch flips `loading: true`.
 */
export function useDashboard(): DashboardState {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const ctrl = new AbortController();
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
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return { data, error, loading, refresh };
}
