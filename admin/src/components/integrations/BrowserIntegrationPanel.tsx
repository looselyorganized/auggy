import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  CodeExample,
  ConnectionDetails,
  IntegrationRouteList,
  type CopyHandler,
} from "@/components/integrations/IntegrationPrimitives";
import {
  isBrowserCallableAppRoute,
  type BrowserConnectionGuidance,
} from "@/lib/integration-guidance";
import type { RouteManifestEntry, WebDashboardState } from "@/lib/types";

export function BrowserIntegrationPanel({
  agentName,
  guidance,
  web,
  routes,
  copied,
  onCopy,
}: {
  agentName: string;
  guidance: BrowserConnectionGuidance;
  web: WebDashboardState;
  routes: RouteManifestEntry[];
  copied: string | null;
  onCopy: CopyHandler;
}) {
  const browserRoutes = routes.filter((route) => isBrowserCallableAppRoute(route, web));
  const cors =
    web.corsOrigins.length === 1
      ? `Configured origin: ${web.corsOrigins[0]}`
      : web.corsOrigins.length > 1
        ? "Invalid: multiple origins configured"
        : "Same-origin only";
  const routeCommand = `auggy routes ${agentName} --client ts --target browser --out src/auggy-client.ts`;
  const frontendConfig = `type: webTransport
config:
  publicFrontendUrl: https://your-app.example.com/chat`;

  return (
    <section className="grid gap-4" aria-labelledby="browser-application-title" data-integration-mode="browser">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="browser-application-title" className="text-lg font-semibold">
            Browser application
          </h3>
          <Badge variant={guidance.ready ? "success" : "warn"}>
            {guidance.ready ? "Auth ready" : "Setup required"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a web app directly to <code>/agent/run</code> without exposing the creator credential.
        </p>
      </div>

      <div
        className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm"
        role="note"
        aria-label="Browser credential warning"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
        <p>
          Never expose <code>AUGGY_WEB_TOKEN</code> in browser code. It grants creator-level access.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h4 className="font-semibold leading-none">Connection</h4>
            <CardDescription>The live conversation surface for this runtime.</CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectionDetails
              rows={[
                { label: "Endpoint", value: guidance.endpoint },
                { label: "Method", value: "POST" },
                { label: "Protocol", value: guidance.protocol },
                {
                  label: "CORS",
                  value: cors,
                  note:
                    web.corsOrigins.length === 1
                      ? "This is the one browser origin admitted by the running agent."
                      : web.corsOrigins.length > 1
                        ? "Use one origin. Static Access-Control-Allow-Origin responses cannot contain an origin list."
                        : "Configure webTransport.config.cors.origins with one origin before calling from another origin.",
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card className={guidance.ready ? undefined : "border-amber-500/40"}>
          <CardHeader>
            <div className="flex items-center gap-2">
              {guidance.ready ? (
                <CheckCircle2 className="size-4 text-emerald-500" aria-hidden="true" />
              ) : (
                <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
              )}
              <h4 className="font-semibold leading-none">{guidance.title}</h4>
            </div>
            <CardDescription>{guidance.summary}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <AuthenticationNote mode={guidance.mode} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <h4 className="font-semibold leading-none">Conversation API</h4>
          <CardDescription>
            Stream AG-UI events while keeping one thread ID across the conversation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {guidance.typescript ? (
            <CodeExample
              label="Browser TypeScript example"
              value={guidance.typescript}
              language="typescript"
              copied={copied}
              onCopy={onCopy}
            />
          ) : (
            <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              Configure delegated external authentication, or explicitly enable anonymous access
              with visitor tokens, before wiring a browser client. Do not use the creator bearer as
              a workaround.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h4 className="font-semibold leading-none">App routes</h4>
          <CardDescription>
            Generate a typed client for augment routes. This client does not include the streaming
            <code> /agent/run</code> conversation API.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {guidance.mode === "external-auth" && (
            <p className="text-xs leading-5 text-muted-foreground">
              Set the generated client's <code>authAssertionHeader</code> to your configured
              external-auth header when it differs from <code>x-auggy-auth-assertion</code>.
            </p>
          )}
          <IntegrationRouteList
            routes={browserRoutes}
            emptyMessage="No browser-callable augment routes are currently reported."
          />
          <CodeExample
            label="Generate browser app-route client"
            value={routeCommand}
            language="bash"
            copied={copied}
            onCopy={onCopy}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h4 className="font-semibold leading-none">Send visitors to your frontend</h4>
          <CardDescription>
            Replace the runtime landing page with your product's browser application.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeExample
            label="augments/webTransport/augment.yaml"
            value={frontendConfig}
            language="yaml"
            copied={copied}
            onCopy={onCopy}
          />
        </CardContent>
      </Card>
    </section>
  );
}

function AuthenticationNote({ mode }: { mode: BrowserConnectionGuidance["mode"] }) {
  if (mode === "external-auth") {
    return (
      <>
        <p>
          Implement <code>getAuggyAuthAssertion()</code> by calling your own trusted server. Mint a
          fresh, short-lived assertion for each request.
        </p>
        <p className="text-muted-foreground">Never mint or sign assertions in the browser.</p>
      </>
    );
  }
  if (mode === "visitor-token") {
    return (
      <>
        <p>Start anonymously, then save the rotated visitor token for future requests.</p>
        <p className="text-muted-foreground">
          The example uses local storage for continuity. Choose storage appropriate to your app's
          security model. Automatic verification handoff requires the app and verification page to
          share an origin.
        </p>
      </>
    );
  }
  if (mode === "anonymous") {
    return <p>Conversations work, but this browser will not retain a verified identity.</p>;
  }
  return (
    <p>
      Visitor tokens cannot open a private conversation endpoint on their own. Configure external
      auth for browser access, or deliberately enable anonymous access before visitor bootstrap.
    </p>
  );
}
