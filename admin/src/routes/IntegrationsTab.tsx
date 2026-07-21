import { useState } from "react";
import { BrowserIntegrationPanel } from "@/components/integrations/BrowserIntegrationPanel";
import { ServerIntegrationPanel } from "@/components/integrations/ServerIntegrationPanel";
import {
  IntegrationModeSelector,
  type IntegrationMode,
} from "@/components/integrations/IntegrationModeSelector";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { selectBrowserConnection, selectServerConnection } from "@/lib/integration-guidance";

export function IntegrationsTab() {
  const { data, loading, error } = useDashboardContext();
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

  async function copy(label: string, value: string) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
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
          <ModePlaceholder
            title="Agent-to-agent"
            description="Standards-based agent interoperability is coming soon."
            badge="Coming soon"
          />
        )}

        <div className="sr-only" role="status" aria-live="polite">
          {copied ? `${copied} copied` : ""}
        </div>
      </div>
    </div>
  );
}

function ModePlaceholder({
  title,
  description,
  badge,
}: {
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <section className="rounded-lg border border-dashed p-6" aria-labelledby={`${title}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${title}-title`} className="text-base font-semibold">
          {title}
        </h3>
        {badge && <Badge variant="secondary">{badge}</Badge>}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </section>
  );
}
