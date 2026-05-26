import { createContext, useContext, type ReactNode } from "react";
import type { DashboardState } from "@/hooks/useDashboard";

const DashboardContext = createContext<DashboardState | null>(null);

export function DashboardProvider({
  value,
  children,
}: {
  value: DashboardState;
  children: ReactNode;
}) {
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboardContext(): DashboardState {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboardContext must be used inside <DashboardProvider>");
  return ctx;
}
