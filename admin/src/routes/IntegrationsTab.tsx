import { useEffect, useRef, useState, type ReactNode } from "react";
import { useActionDispatcher } from "@/components/admin/useActionDispatcher";
import { AgentIntegrationPanel } from "@/components/integrations/AgentIntegrationPanel";
import { BrowserIntegrationPanel } from "@/components/integrations/BrowserIntegrationPanel";
import { ServerIntegrationPanel } from "@/components/integrations/ServerIntegrationPanel";
import {
  IntegrationModeSelector,
  DEFAULT_INTEGRATION_MODE,
  type IntegrationMode,
} from "@/components/integrations/IntegrationModeSelector";
import { Card, CardDescription, CardHeader } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { selectBrowserConnection, selectServerConnection } from "@/lib/integration-guidance";
import { useToast } from "@/lib/toast";
import type { DashboardData } from "@/lib/types";

const PUBLIC_INTEGRATION_SIGNAL_KEY = "auggy-public-integration";

export function IntegrationsTab() {
  const { data, loading, error, updateData } = useDashboardContext();
  const { dispatch, busy } = useActionDispatcher();
  const { push } = useToast();
  const [mode, setMode] = useState<IntegrationMode>(DEFAULT_INTEGRATION_MODE);
  const [copied, setCopied] = useState<string | null>(null);
  const loadErrorRef = useRef<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  useEffect(() => {
    if (!error) {
      loadErrorRef.current = null;
      return;
    }
    if (loadErrorRef.current === error) return;
    push("error", "Integrations load failed", error);
    loadErrorRef.current = error;
  }, [error, push]);

  if (loading && !data) {
    return (
      <Card role="status">
        <CardHeader>
          <h2 className="font-semibold leading-none">Integrations</h2>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="border-destructive/40" role="alert">
        <CardHeader>
          <h2 className="font-semibold leading-none text-destructive">Integrations load failed</h2>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!data) return null;

  const agentName =
    data.agentMeta?.displayName ??
    data.card.provider.displayName ??
    data.agentMeta?.name ??
    data.card.provider.name ??
    "agent";
  const browser = selectBrowserConnection(origin, data.web);
  const server = selectServerConnection(origin);
  const legacyDiscoveryPublic = data.web.publicIntegration.value === true;
  const agentCliName = data.agentMeta?.name ?? data.card.provider.name ?? "agent";

  async function copy(label: string, value: string) {
    if (!value || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      push("error", "Copy failed", `Could not copy ${label}.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      push("success", "Copied", `Copied ${label}.`);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
    } catch {
      setCopied(null);
      push("error", "Copy failed", `Could not copy ${label}.`);
    }
  }

  async function makeLegacyDiscoveryPrivate() {
    if (!legacyDiscoveryPublic) return;
    const ok = await dispatch({
      actionId: "posture-public-integration-set",
      values: { value: "false" },
      confirmRequired: false,
      refresh: "none",
    });
    if (!ok) return;
    updateData((current) => patchPublicIntegration(current, false));
    signalPublicIntegrationChange(false);
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-3 sm:p-4">
        <section className="grid gap-1" aria-labelledby="integrations-title">
          <h2 id="integrations-title" className="text-xl font-semibold tracking-normal">
            Integrations
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect a browser or trusted server to {agentName}.
          </p>
        </section>

        {shouldShowLegacyDiscoveryAlert(legacyDiscoveryPublic, mode) && (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div className="font-semibold">Legacy developer discovery is public</div>
              <p className="mt-1 text-muted-foreground">
                This is Auggy-only runtime metadata, not a standards-compatible A2A connection.
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 self-start underline underline-offset-4 sm:self-auto"
              onClick={() => setMode("agent")}
            >
              Review and make private
            </button>
          </div>
        )}

        <IntegrationModeSelector value={mode} onChange={setMode} />

        {mode === "browser" && (
          <IntegrationPanel mode="browser">
            <BrowserIntegrationPanel
              agentName={agentCliName}
              guidance={browser}
              web={data.web}
              routes={data.routes.entries}
              copied={copied}
              onCopy={copy}
            />
          </IntegrationPanel>
        )}

        {mode === "server" && (
          <IntegrationPanel mode="server">
            <ServerIntegrationPanel
              agentName={agentCliName}
              guidance={server}
              routes={data.routes.entries}
              copied={copied}
              onCopy={copy}
            />
          </IntegrationPanel>
        )}

        {mode === "agent" && (
          <IntegrationPanel mode="agent">
            <AgentIntegrationPanel
              legacyDiscoveryPublic={legacyDiscoveryPublic}
              disabling={busy}
              onMakePrivate={makeLegacyDiscoveryPrivate}
            />
          </IntegrationPanel>
        )}

      </div>
    </div>
  );
}

function IntegrationPanel({ mode, children }: { mode: IntegrationMode; children: ReactNode }) {
  return (
    <div
      id={`integration-panel-${mode}`}
      role="tabpanel"
      aria-labelledby={`integration-mode-${mode}`}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

function signalPublicIntegrationChange(value: boolean): void {
  try {
    localStorage.setItem(PUBLIC_INTEGRATION_SIGNAL_KEY, `${value}:${Date.now()}`);
  } catch {
    /* localStorage unavailable */
  }
}

export function patchPublicIntegration(data: DashboardData, value: boolean): DashboardData {
  return {
    ...data,
    web: {
      ...data.web,
      publicIntegration: {
        ...data.web.publicIntegration,
        value,
        source: "/console override",
      },
    },
    blocks: data.blocks.map((block) => {
      if (block.augmentName !== "web" || block.title !== "Posture") return block;
      return {
        ...block,
        sections: block.sections.map((section) => {
          if (section.kind !== "keyValue") return section;
          return {
            ...section,
            rows: section.rows.map((row) =>
              row.label === "publicIntegration"
                ? { ...row, value: String(value), source: "/console override" }
                : row,
            ),
          };
        }),
      };
    }),
  };
}

export function shouldShowLegacyDiscoveryAlert(
  legacyDiscoveryPublic: boolean,
  mode: IntegrationMode,
): boolean {
  return legacyDiscoveryPublic && mode !== "agent";
}
