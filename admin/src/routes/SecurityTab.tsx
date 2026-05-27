import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminBlockBody } from "@/components/admin/AdminBlockBody";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import type { AdminInfoBlock } from "@/lib/types";

/**
 * Security tab — "Who can interact with the agent?"
 *
 * Composes two augments' adminInfo() blocks:
 *
 *   1. webTransport — exposes the auth posture (allowAnonymous, port,
 *      publicFrontendUrl, trusted proxies) + the posture-flip action.
 *   2. visitorAuth — exposes the verified-visitor list + revoke row
 *      actions, plus rate-limit settings.
 *
 * Either is sufficient to keep the tab visible. When only one is
 * mounted, the other's section is omitted gracefully.
 */
export function SecurityTab() {
  const { data, error, loading } = useDashboardContext();

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Security load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!data) return null;

  // webTransport's adminInfo emits an augmentName of "web" (the augment's
  // runtime name). visitorAuth emits "visitor-auth". We look up by both.
  const postureBlock = data.blocks.find((b) => b.augmentName === "web");
  const visitorBlock = data.blocks.find((b) => b.augmentName === "visitor-auth");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Access posture
        </h2>
        <p className="text-xs text-muted-foreground">
          Configured by the <code className="font-mono text-[11px]">webTransport</code> augment
          (auth posture) and the <code className="font-mono text-[11px]">visitorAuth</code>{" "}
          augment (visitor verification). Changes persist immediately; some require an agent
          restart to fully apply.
        </p>
      </header>

      <SecuritySection
        block={postureBlock}
        sectionLabel="Auth posture"
        missingHint="webTransport augment isn't mounted — /admin wouldn't be served without it, so this should never trigger."
      />

      <SecuritySection
        block={visitorBlock}
        sectionLabel="Visitors"
        missingHint="Visitor verification isn't enabled. Mount visitorAuth from the Augments tab to allow anonymous visitors to verify by email."
      />
    </div>
  );
}

function SecuritySection({
  block,
  sectionLabel,
  missingHint,
}: {
  block: AdminInfoBlock | undefined;
  sectionLabel: string;
  missingHint: string;
}) {
  if (!block) {
    return (
      <Card className="border-muted bg-muted/20">
        <CardHeader className="p-4">
          <CardTitle className="text-sm">{sectionLabel}</CardTitle>
          <CardDescription className="text-xs">{missingHint}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">{block.title}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <AdminBlockBody block={block} />
      </CardContent>
    </Card>
  );
}
