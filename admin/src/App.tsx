import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { NotInstalled } from "@/components/layout/NotInstalled";
import { ToastProvider } from "@/lib/toast";
import { ConfirmProvider } from "@/lib/confirm";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { useDashboard } from "@/hooks/useDashboard";
import { getTabVisibility } from "@/lib/visibility";
import { AugmentsTab } from "@/routes/AugmentsTab";
import { SkillsTab } from "@/routes/SkillsTab";
import { IdentityTab } from "@/routes/IdentityTab";
import { CredentialsTab } from "@/routes/CredentialsTab";
import { ChatTab, BudgetsTab, TracesTab } from "@/routes/placeholders";

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

  const augments = dashboard.data?.augments ?? [];
  const visibility = getTabVisibility(augments);

  return (
    <ToastProvider>
      <ConfirmProvider>
        <DashboardProvider value={dashboard}>
          <div className="flex h-full">
            <Sidebar
              agentMeta={dashboard.data?.agentMeta ?? null}
              fallbackName={agentName}
              visibility={visibility}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <Header
                agentName={dashboard.data?.agentMeta?.name ?? agentName}
                agentDescription={dashboard.data?.agentMeta?.purpose ?? agentDescription}
                online={online}
              />
              <main className="flex-1 overflow-y-auto bg-muted/30 p-6">
                <Routes>
                  <Route path="/" element={<Navigate to="/chat" replace />} />
                  <Route
                    path="/chat"
                    element={
                      visibility.chat ? (
                        <ChatTab />
                      ) : (
                        <NotInstalled tabLabel="Chat" requires={["webTransport"]} />
                      )
                    }
                  />
                  <Route path="/identity" element={<IdentityTab />} />
                  <Route path="/augments" element={<AugmentsTab />} />
                  <Route path="/skills" element={<SkillsTab />} />
                  <Route path="/credentials" element={<CredentialsTab />} />
                  <Route
                    path="/budget"
                    element={
                      visibility.budget ? (
                        <BudgetsTab />
                      ) : (
                        <NotInstalled tabLabel="Budget" requires={["budgets"]} />
                      )
                    }
                  />
                  <Route
                    path="/security"
                    element={
                      visibility.security ? (
                        // Placeholder for now — Security tab build is task #24.
                        <TracesTab />
                      ) : (
                        <NotInstalled tabLabel="Security" requires={["webTransport", "visitorAuth"]} />
                      )
                    }
                  />
                  {/* Legacy /budgets → /budget redirect for old bookmarks */}
                  <Route path="/budgets" element={<Navigate to="/budget" replace />} />
                  {/* Legacy deferred-tab redirects (Memory / Traces / Manifest) */}
                  <Route path="/memory" element={<Navigate to="/augments" replace />} />
                  <Route path="/traces" element={<Navigate to="/augments" replace />} />
                  <Route path="/manifest" element={<Navigate to="/augments" replace />} />
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
