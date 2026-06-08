import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useActionDispatcher } from "@/components/admin/useActionDispatcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardData } from "@/lib/types";

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
  const webPosture = useMemo(() => readWebPosture(data), [data]);
  const resolvedPublicIntegration = webPosture.publicIntegration === "true";
  const [optimisticPublicIntegration, setOptimisticPublicIntegration] = useState<boolean | null>(
    null,
  );
  const publicIntegration = optimisticPublicIntegration ?? resolvedPublicIntegration;
  const publicFrontendUrl = webPosture.publicFrontendUrl;
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
            <CardDescription>
              These are visible here because you are in the operator console.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <Endpoint label="Run endpoint" value={runUrl} copied={copied} onCopy={copy} />
            <Endpoint label="Agent card" value={cardUrl} copied={copied} onCopy={copy} />
            <Endpoint
              label="Public integration page"
              value={agentUrl}
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
            <PostureRow label="publicFrontendUrl" value={publicFrontendUrl ?? "(unset)"} />
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
          <CardDescription>Use a token or access flow provided by the creator.</CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock label="curl" value={curl} copied={copied} onCopy={copy} />
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
            <CardDescription>Normal visitors should go to your app, not backend docs.</CardDescription>
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

function patchPublicIntegration(data: DashboardData, value: boolean): DashboardData {
  return {
    ...data,
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
    <div className="grid grid-cols-[8rem_1fr_auto_auto] items-center gap-2 rounded-md border px-3 py-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate font-mono text-xs" title={value}>
        {value}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void onCopy(label, value)}
      >
        {copied === label ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" className="size-7" asChild>
        <a href={value} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
          <ExternalLink className="size-3.5" />
        </a>
      </Button>
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

function readWebPosture(data: DashboardData | null): {
  publicFrontendUrl?: string;
  publicIntegration?: string;
} {
  const rows =
    data?.blocks
      .find((block) => block.augmentName === "web" && block.title === "Posture")
      ?.sections.flatMap((section) => (section.kind === "keyValue" ? section.rows : [])) ?? [];
  const row = (label: string) => rows.find((item) => item.label === label);
  const publicIntegration = row("publicIntegration");
  const frontend = row("publicFrontendUrl")?.value;
  return {
    publicFrontendUrl: frontend && frontend !== "(unset)" ? frontend : undefined,
    publicIntegration: publicIntegration?.value,
  };
}
