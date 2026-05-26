import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { ToastProvider } from "@/lib/toast";
import { ConfirmProvider } from "@/lib/confirm";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { useDashboard } from "@/hooks/useDashboard";
import { AugmentsTab } from "@/routes/AugmentsTab";
import { SkillsTab } from "@/routes/SkillsTab";
import { IdentityTab } from "@/routes/IdentityTab";
import { CredentialsTab } from "@/routes/CredentialsTab";
import {
  ChatTab,
  BudgetsTab,
  TracesTab,
  ManifestTab,
} from "@/routes/placeholders";

export function App() {
  const dashboard = useDashboard();
  const provider = dashboard.data?.card.provider;
  const agentName = provider?.name ?? "—";
  const agentDescription = provider?.description;
  const online: "online" | "offline" | "unknown" = dashboard.error
    ? "offline"
    : dashboard.data
      ? "online"
      : "unknown";

  return (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardProvider value={dashboard}>
        <div className="flex h-full">
          <Sidebar agentMeta={dashboard.data?.agentMeta ?? null} fallbackName={agentName} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Header
              agentName={dashboard.data?.agentMeta?.name ?? agentName}
              agentDescription={dashboard.data?.agentMeta?.purpose ?? agentDescription}
              online={online}
            />
            <main className="flex-1 overflow-y-auto bg-muted/30 p-6">
              <Routes>
                <Route path="/" element={<Navigate to="/chat" replace />} />
                <Route path="/chat" element={<ChatTab />} />
                <Route path="/identity" element={<IdentityTab />} />
                <Route path="/augments" element={<AugmentsTab />} />
                <Route path="/skills" element={<SkillsTab />} />
                <Route path="/credentials" element={<CredentialsTab />} />
                <Route path="/budgets" element={<BudgetsTab />} />
                <Route path="/traces" element={<TracesTab />} />
                <Route path="/manifest" element={<ManifestTab />} />
                <Route path="*" element={<Navigate to="/chat" replace />} />
              </Routes>
            </main>
          </div>
        </div>
        </DashboardProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
