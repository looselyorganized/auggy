import { useState } from "react";
import { useActionDispatcher } from "@/components/admin/useActionDispatcher";
import { AgentIntegrationPanel } from "@/components/integrations/AgentIntegrationPanel";
import { BrowserIntegrationPanel } from "@/components/integrations/BrowserIntegrationPanel";
import { ServerIntegrationPanel } from "@/components/integrations/ServerIntegrationPanel";
import {
  IntegrationModeSelector,
  type IntegrationMode,
} from "@/components/integrations/IntegrationModeSelector";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { selectBrowserConnection, selectServerConnection } from "@/lib/integration-guidance";
import type { DashboardData } from "@/lib/types";

const PUBLIC_INTEGRATION_SIGNAL_KEY = "auggy-public-integration";

export function IntegrationsTab() {
  const { data, loading, error, updateData } = useDashboardContext();
  const { dispatch, busy } = useActionDispatcher();
  const [mode, setMode] = useState<IntegrationMode>("browser");
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Integrations load failed</CardTitle>
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

  async function copy(label: string, value: string) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
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

        <IntegrationModeSelector value={mode} onChange={setMode} />

        {mode === "browser" && (
          <BrowserIntegrationPanel
            agentName={data.agentMeta?.name ?? "<agent>"}
            guidance={browser}
            web={data.web}
            routes={data.routes.entries}
            copied={copied}
            onCopy={copy}
          />
        )}

        {mode === "server" && (
          <ServerIntegrationPanel
            agentName={data.agentMeta?.name ?? "<agent>"}
            guidance={server}
            routes={data.routes.entries}
            copied={copied}
            onCopy={copy}
          />
        )}

        {mode === "agent" && (
          <AgentIntegrationPanel
            legacyDiscoveryPublic={legacyDiscoveryPublic}
            disabling={busy}
            onMakePrivate={makeLegacyDiscoveryPrivate}
          />
        )}

        <div className="sr-only" role="status" aria-live="polite">
          {copied ? `${copied} copied` : ""}
        </div>
      </div>
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

function patchPublicIntegration(data: DashboardData, value: boolean): DashboardData {
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
