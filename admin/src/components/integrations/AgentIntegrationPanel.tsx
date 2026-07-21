import { LockKeyhole, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export function AgentIntegrationPanel({
  legacyDiscoveryPublic,
  disabling = false,
  onMakePrivate,
}: {
  legacyDiscoveryPublic: boolean;
  disabling?: boolean;
  onMakePrivate: () => void | Promise<void>;
}) {
  return (
    <section className="grid gap-4" aria-labelledby="agent-integration-title">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="agent-integration-title" className="text-lg font-semibold leading-none">
              Agent-to-agent
            </h3>
            <Badge variant="secondary">Coming soon</Badge>
          </div>
          <CardDescription className="max-w-3xl leading-6">
            Auggy includes early A2A-shaped primitives and a link preview, but it does not yet
            provide a production, standards-compatible agent-to-agent connection flow.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <h4 className="text-sm font-semibold">Planned connection contract</h4>
          <ul className="grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-foreground">
            <li>Standards-compliant, sanitized Agent Card</li>
            <li>Authenticated peer discovery and task exchange</li>
            <li>Scoped permissions, budgets, and audit trails</li>
          </ul>
          <p className="text-xs leading-5 text-muted-foreground">
            Treat this mode as unavailable until those safety and interoperability guarantees
            ship together.
          </p>
        </CardContent>
      </Card>

      {legacyDiscoveryPublic ? (
        <section
          role="note"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-950 dark:text-amber-100"
          aria-labelledby="legacy-discovery-warning-title"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h4 id="legacy-discovery-warning-title" className="text-sm font-semibold">
                Legacy developer discovery is currently public
              </h4>
              <p className="mt-1 max-w-3xl text-sm leading-6">
                This publishes legacy Auggy developer metadata. It is not a standards-compatible
                A2A connection and may expose more implementation detail than intended.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 h-auto w-full whitespace-normal border-amber-700/50 bg-background text-foreground hover:bg-muted sm:w-auto dark:border-amber-300/50"
                disabled={disabling}
                onClick={() => void onMakePrivate()}
              >
                <LockKeyhole aria-hidden="true" />
                {disabling ? "Making private…" : "Make legacy discovery private"}
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <p
          className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
          aria-label="Legacy developer discovery status: private"
          role="status"
          aria-live="polite"
        >
          Legacy developer discovery is private.
        </p>
      )}
    </section>
  );
}
