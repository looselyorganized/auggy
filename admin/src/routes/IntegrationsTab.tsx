import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useActionDispatcher } from "@/components/admin/useActionDispatcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardData } from "@/lib/types";

const PUBLIC_INTEGRATION_SIGNAL_KEY = "auggy-public-integration";

export function IntegrationsTab() {
  const { data, loading, error, updateData } = useDashboardContext();
  const { dispatch, busy } = useActionDispatcher();
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const agentName =
    data?.agentMeta?.displayName ??
    data?.card.provider.displayName ??
    data?.agentMeta?.name ??
    data?.card.provider.name ??
    "agent";
  const webPosture = data?.web;
  const routeSummary = data?.routes.summary;
  const routeEntries = data?.routes.entries ?? [];
  const resolvedPublicIntegration = webPosture?.publicIntegration.value === true;
  const [optimisticPublicIntegration, setOptimisticPublicIntegration] = useState<boolean | null>(
    null,
  );
  const publicIntegration = optimisticPublicIntegration ?? resolvedPublicIntegration;
  const publicFrontendUrl = webPosture?.publicFrontendUrl;
  const allowAnonymous = webPosture?.allowAnonymous.value;
  const visitorTokensEnabled = webPosture?.visitorTokensEnabled === true;
  const externalAuthEnabled = webPosture?.externalAuthEnabled === true;
  const runUrl = origin ? `${origin}/agent/run` : "/agent/run";
  const cardUrl = origin
    ? `${origin}/.well-known/agent-card.json`
    : "/.well-known/agent-card.json";
  const agentUrl = origin ? `${origin}/agent` : "/agent";

  async function copy(label: string, value: string) {
    if (!value || typeof navigator === "undefined") return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1200);
  }

  useEffect(() => {
    setOptimisticPublicIntegration(null);
  }, [resolvedPublicIntegration]);

  async function togglePublicIntegration() {
    const next = !publicIntegration;
    setOptimisticPublicIntegration(next);
    const ok = await dispatch({
      actionId: "posture-public-integration-set",
      values: { value: String(next) },
      confirmRequired: false,
      refresh: "none",
    });
    if (ok) {
      updateData((current) => patchPublicIntegration(current, next));
      signalPublicIntegrationChange(next);
    } else {
      setOptimisticPublicIntegration(null);
    }
  }

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

  const curl = `curl ${runUrl} \\
  -H 'Authorization: Bearer <token>' \\
  -H 'Content-Type: application/json' \\
  -d '{"messages":[{"role":"user","content":"What can you help with?"}]}'`;
  const routeCommands = `auggy routes ${data?.agentMeta?.name ?? "<agent>"} --json
auggy routes ${data?.agentMeta?.name ?? "<agent>"} --openapi
auggy routes ${data?.agentMeta?.name ?? "<agent>"} --client ts --target browser --out src/auggy-client.ts`;
  const publicConfig = `- name: webTransport
  type: webTransport
  options:
    publicIntegration: true`;
  const frontendConfig = `- name: webTransport
  type: webTransport
  options:
    publicFrontendUrl: https://your-app.example.com/chat`;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-3 sm:p-4">
        <section className="grid gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-normal">Integrations</h2>
              <p className="text-sm text-muted-foreground">
                Authenticated setup details for connecting clients to {agentName}.
              </p>
            </div>
            <Badge variant={publicIntegration ? "success" : "outline"}>
              {publicIntegration ? "developer discovery published" : "developer discovery private"}
            </Badge>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Private endpoints</CardTitle>
              <CardDescription>Built-in web surfaces for this running agent.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <Endpoint
                label="Run endpoint"
                method="POST"
                value={runUrl}
                note={
                  allowAnonymous === false
                    ? "Bearer or external auth required"
                    : "Bearer optional when anonymous chat is allowed"
                }
                copied={copied}
                onCopy={copy}
              />
              <Endpoint
                label="Agent card"
                method="GET"
                value={cardUrl}
                openable={publicIntegration}
                note={
                  publicIntegration
                    ? "Public discovery enabled"
                    : "Bearer required; direct browser open returns 404"
                }
                copied={copied}
                onCopy={copy}
              />
              <Endpoint
                label="Public integration page"
                method="GET"
                value={agentUrl}
                openable={publicIntegration}
                note={publicIntegration ? "Public" : "404 until developer discovery is published"}
                copied={copied}
                onCopy={copy}
              />
              <Endpoint
                label="Health"
                method="GET"
                value={origin ? `${origin}/health` : "/health"}
                openable
                note="Basic runtime health"
                copied={copied}
                onCopy={copy}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Public posture</CardTitle>
              <CardDescription>
                Publishing developer discovery is separate from publishing a frontend.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-3">
                <div className="min-w-0">
                  <div className="font-medium">Publish developer discovery</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Controls public /agent and agent-card discovery only.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={publicIntegration}
                    disabled={busy || !data}
                    onCheckedChange={() => void togglePublicIntegration()}
                    aria-label="Publish developer discovery"
                  />
                </div>
              </div>
              <PostureRow label="publicIntegration" value={publicIntegration ? "true" : "false"} />
              <PostureRow
                label="allowAnonymous"
                value={
                  allowAnonymous === null || allowAnonymous === undefined
                    ? "unknown"
                    : String(allowAnonymous)
                }
              />
              <PostureRow label="publicFrontendUrl" value={publicFrontendUrl ?? "(unset)"} />
              <PostureRow
                label="CORS origins"
                value={
                  webPosture?.corsOrigins.length ? webPosture.corsOrigins.join(", ") : "(none)"
                }
              />
              <PostureRow
                label="visitor tokens"
                value={visitorTokensEnabled ? "enabled" : "disabled"}
              />
              <PostureRow
                label="external auth"
                value={
                  externalAuthEnabled
                    ? `enabled (${webPosture?.externalAuthHeader ?? "x-auggy-auth-assertion"})`
                    : "disabled"
                }
              />
              <PostureRow
                label="agent-card visibility"
                value={publicIntegration ? "public" : "bearer only"}
              />
              <PostureRow label="/agent visibility" value={publicIntegration ? "public" : "404"} />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Request example</CardTitle>
            <CardDescription>
              Creator-authorized AG-UI conversation over the built-in run endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock label="curl" value={curl} copied={copied} onCopy={copy} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>App routes</CardTitle>
            <CardDescription>
              Augment HTTP routes served beside <code>/agent/run</code>; generated from the live
              route manifest.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant={routeSummary && routeSummary.publicRoutes > 0 ? "warn" : "success"}>
                {routeSummary?.totalRoutes ?? 0} routes
              </Badge>
              <Badge variant={routeSummary && routeSummary.publicRoutes > 0 ? "warn" : "outline"}>
                {routeSummary?.publicRoutes ?? 0} public
              </Badge>
              <Badge variant="outline">{routeSummary?.privateRoutes ?? 0} private</Badge>
            </div>
            <RouteTable routes={routeEntries} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Route artifacts</CardTitle>
            <CardDescription>
              Use the CLI to export the same route model for docs and app clients.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock label="routes" value={routeCommands} copied={copied} onCopy={copy} />
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Publish developer integration page</CardTitle>
              <CardDescription>
                Enables public <code>/agent</code> and public agent-card JSON. This does not make
                <code> /agent/run</code> or <code>/console</code> public.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock
                label="publicIntegration config"
                value={publicConfig}
                copied={copied}
                onCopy={copy}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Replace default /</CardTitle>
              <CardDescription>
                Normal visitors should go to your app, not backend docs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock
                label="frontend config"
                value={frontendConfig}
                copied={copied}
                onCopy={copy}
              />
            </CardContent>
          </Card>
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

function Endpoint({
  label,
  method = "GET",
  openable = false,
  note,
  value,
  copied,
  onCopy,
}: {
  label: string;
  method?: "GET" | "POST";
  openable?: boolean;
  note?: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void | Promise<void>;
}) {
  return (
    <div className="grid grid-cols-[minmax(5.75rem,8rem)_4rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <Badge variant={method === "GET" ? "outline" : "secondary"}>{method}</Badge>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs" title={value}>
          {value}
        </div>
        {note && <div className="mt-1 truncate text-[11px] text-muted-foreground">{note}</div>}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void onCopy(label, value)}
      >
        {copied === label ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      {openable ? (
        <Button variant="ghost" size="icon" className="size-7" asChild>
          <a href={value} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      ) : (
        <span className="size-7" aria-hidden="true" />
      )}
    </div>
  );
}

function RouteTable({ routes }: { routes: DashboardData["routes"]["entries"] }) {
  if (routes.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
        No augment HTTP routes reported. The built-in <code>/agent/run</code> conversation endpoint
        is listed above.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <div className="min-w-[42rem]">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_8rem_9rem] gap-2 border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>Method</span>
          <span>Path</span>
          <span>Augment</span>
          <span>Auth</span>
        </div>
        <div className="divide-y">
          {routes.map((route) => (
            <div
              key={`${route.method} ${route.path}`}
              className="grid grid-cols-[4.5rem_minmax(0,1fr)_8rem_9rem] gap-2 px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs">{route.method}</span>
              <div className="min-w-0">
                <div className="truncate font-mono text-xs" title={route.path}>
                  {route.path}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant={route.public ? "warn" : "outline"}>
                    {route.public ? "public" : "private"}
                  </Badge>
                  {route.rateLimit && (
                    <Badge variant="outline">{route.rateLimit.maxPerMinute}/min</Badge>
                  )}
                  {route.policy && <Badge variant="info">{route.policy.kind}</Badge>}
                </div>
              </div>
              <span className="truncate text-xs text-muted-foreground" title={route.augmentName}>
                {route.augmentName}
              </span>
              <span className="truncate font-mono text-xs" title={route.auth}>
                {route.auth}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PostureRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium" title={value}>
        {value}
      </span>
    </div>
  );
}

function CodeBlock({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void | Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => void onCopy(label, value)}
        >
          {copied === label ? (
            <Check className="mr-1.5 size-3.5" />
          ) : (
            <Copy className="mr-1.5 size-3.5" />
          )}
          Copy
        </Button>
      </div>
      <pre className="overflow-auto bg-slate-950 p-3 text-xs leading-6 text-slate-50">
        <code>{value}</code>
      </pre>
    </div>
  );
}
