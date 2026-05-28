import { Navigate, Route, Routes } from "react-router-dom";
import { Header } from "@/components/layout/Header";
import { ToastProvider } from "@/lib/toast";
import { ConfirmProvider } from "@/lib/confirm";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { useDashboard } from "@/hooks/useDashboard";
import { ChatTab } from "@/routes/ChatTab";

export function App() {
  const dashboard = useDashboard();
  const provider = dashboard.data?.card.provider;
  const agentName = dashboard.data?.agentMeta?.name ?? provider?.name ?? "auggy";
  const agentDescription = dashboard.data?.agentMeta?.purpose ?? dashboard.data?.card.purpose;
  const online: "online" | "offline" | "unknown" = dashboard.error
    ? "offline"
    : dashboard.data
      ? "online"
      : "unknown";

  return (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardProvider value={dashboard}>
          <div className="flex h-full min-w-0 flex-col bg-background">
            <Header
              agentName={agentName}
              agentDescription={agentDescription}
              online={online}
              dashboard={dashboard.data ?? null}
            />
            <main className="min-h-0 flex-1 overflow-hidden bg-muted/20">
              <Routes>
                <Route path="/" element={<Navigate to="/chat" replace />} />
                <Route path="/chat" element={<ChatTab />} />
                <Route path="*" element={<Navigate to="/chat" replace />} />
              </Routes>
            </main>
          </div>
        </DashboardProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
