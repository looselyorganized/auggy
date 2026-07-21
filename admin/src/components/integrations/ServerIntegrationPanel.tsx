import { useState, type KeyboardEvent } from "react";
import { Server, ShieldAlert } from "lucide-react";
import {
  CodeExample,
  ConnectionDetails,
  type CopyHandler,
} from "@/components/integrations/IntegrationPrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  isServerCallableAppRoute,
  type ServerConnectionGuidance,
} from "@/lib/integration-guidance";
import type { RouteManifestEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

type ConversationExample = "typescript" | "curl";

export function ServerIntegrationPanel({
  agentName,
  guidance,
  routes,
  copied,
  onCopy,
}: {
  agentName: string;
  guidance: ServerConnectionGuidance;
  routes: RouteManifestEntry[];
  copied: string | null;
  onCopy: CopyHandler;
}) {
  const [example, setExample] = useState<ConversationExample>("typescript");
  const serverRoutes = routes.filter(isServerCallableAppRoute);
  const baseUrl = guidance.endpoint.replace(/\/agent\/run$/, "") || "Current origin";
  const routeCommands = `# Typed server client for app routes
auggy routes ${agentName} --client ts --target server --out src/auggy-client.server.ts

# OpenAPI 3.1 document for app routes
auggy routes ${agentName} --openapi

# JSON manifest for app routes
auggy routes ${agentName} --json`;
  const selectedExample = example === "typescript" ? guidance.typescript : guidance.curl;
  const selectedLabel = example === "typescript" ? "Server TypeScript example" : "Server cURL example";

  return (
    <section
      className="grid gap-4"
      aria-labelledby="server-application-title"
      data-integration-mode="server"
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="server-application-title" className="text-lg font-semibold">
            Server application
          </h3>
          <Badge variant="info">Trusted runtime</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a backend, job, or server action to the agent with the creator credential.
        </p>
      </div>

      <div
        className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm"
        role="note"
        aria-label="Server credential warning"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
        <p>
          <code>AUGGY_WEB_TOKEN</code> grants creator-level authority. Keep it in a trusted server
          environment; never ship it to a browser, mobile app, client bundle, or public repository.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>Runtime endpoints used by a trusted application server.</CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectionDetails
              rows={[
                { label: "Base URL", value: baseUrl },
                {
                  label: "Conversation",
                  value: "POST /agent/run",
                  note: "Streams one agent run for the caller-provided thread ID.",
                },
                { label: "Health", value: "GET /health", note: "Liveness only; no agent run." },
                { label: "Protocol", value: guidance.protocol },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Server className="size-4 text-sky-500" aria-hidden="true" />
              <CardTitle>{guidance.title}</CardTitle>
            </div>
            <CardDescription>{guidance.summary}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>
              Load <code>{guidance.environmentVariable}</code> from your server's secret manager or
              process environment at runtime.
            </p>
            <p className="text-muted-foreground">
              Reuse your application's durable thread ID to continue the same conversation across
              requests and process restarts. Use one turn ID per logical turn, and reuse it only
              when retrying that same turn.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversation API</CardTitle>
          <CardDescription>
            POST to <code>/agent/run</code> and consume the AG-UI event stream through completion.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div
            className="flex w-fit rounded-md border bg-muted/30 p-1"
            role="tablist"
            aria-label="Server conversation example"
          >
            <ExampleTab
              id="server-example-typescript"
              selected={example === "typescript"}
              onSelect={() => setExample("typescript")}
              onNavigate={(event) =>
                navigateExample(event, "server-example-curl", () => setExample("curl"))
              }
            >
              TypeScript
            </ExampleTab>
            <ExampleTab
              id="server-example-curl"
              selected={example === "curl"}
              onSelect={() => setExample("curl")}
              onNavigate={(event) =>
                navigateExample(event, "server-example-typescript", () =>
                  setExample("typescript"),
                )
              }
            >
              cURL
            </ExampleTab>
          </div>
          <div
            id="server-conversation-example"
            role="tabpanel"
            aria-labelledby={`server-example-${example}`}
          >
            <CodeExample
              id="server-conversation"
              label={selectedLabel}
              value={selectedExample}
              language={example === "typescript" ? "typescript" : "bash"}
              copied={copied}
              onCopy={onCopy}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>App routes</CardTitle>
          <CardDescription>
            Generate clients and schemas for augment-defined app routes. These artifacts do not
            include the streaming <code>/agent/run</code> conversation endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-xs leading-5 text-muted-foreground">
            The routes below accept this creator credential. A generated server client can also
            include agent or webhook routes that require their own specialized credentials.
          </p>
          <ServerRouteList routes={serverRoutes} />
          <CodeExample
            id="server-routes"
            label="Generate server app-route artifacts"
            value={routeCommands}
            language="bash"
            copied={copied}
            onCopy={onCopy}
          />
        </CardContent>
      </Card>
    </section>
  );
}

function ExampleTab({
  id,
  selected,
  onSelect,
  onNavigate,
  children,
}: {
  id: string;
  selected: boolean;
  onSelect: () => void;
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>) => void;
  children: string;
}) {
  return (
    <Button
      id={id}
      type="button"
      role="tab"
      variant="ghost"
      size="sm"
      aria-selected={selected}
      aria-controls="server-conversation-example"
      tabIndex={selected ? 0 : -1}
      className={cn("h-7 px-3", selected && "bg-background shadow-sm")}
      onClick={onSelect}
      onKeyDown={onNavigate}
    >
      {children}
    </Button>
  );
}

function navigateExample(
  event: KeyboardEvent<HTMLButtonElement>,
  targetId: string,
  selectTarget: () => void,
) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  selectTarget();
  document.getElementById(targetId)?.focus();
}

function ServerRouteList({ routes }: { routes: RouteManifestEntry[] }) {
  if (routes.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
        No app routes callable with the creator credential are currently reported.
      </div>
    );
  }

  return (
    <div className="divide-y rounded-md border">
      {routes.map((route) => (
        <div
          key={`${route.method} ${route.path}`}
          className="grid gap-1 px-3 py-2.5 sm:grid-cols-[4rem_minmax(0,1fr)_9rem]"
        >
          <span className="font-mono text-xs">{route.method}</span>
          <span className="break-all font-mono text-xs">{route.path}</span>
          <span className="text-xs text-muted-foreground sm:text-right">{route.auth}</span>
        </div>
      ))}
    </div>
  );
}
