import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  AlertTriangle,
  Brain,
  Network,
  Package,
  Route,
  Shield,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { cn } from "@/lib/utils";
import type { AugmentSummary, DashboardData, RouteManifestEntry, ToolSummary } from "@/lib/types";

type RuntimeWarning = {
  id: string;
  severity: "warn" | "error" | "info";
  augmentName?: string;
  surface: string;
  message: string;
};

const CATEGORY_LABELS: Record<AugmentSummary["category"], string> = {
  transports: "Transports",
  capabilities: "Capabilities",
  memory: "Memory",
  guardrails: "Guardrails",
};

const CATEGORY_ORDER: AugmentSummary["category"][] = [
  "transports",
  "capabilities",
  "memory",
  "guardrails",
];

export function CapabilitiesTab() {
  const { data, loading, error } = useDashboardContext();
  const [selectedAugmentName, setSelectedAugmentName] = useState<string | null>(null);

  useEffect(() => {
    if (!data || !selectedAugmentName) return;
    if (!data.augments.some((augment) => augment.name === selectedAugmentName)) {
      setSelectedAugmentName(null);
    }
  }, [data, selectedAugmentName]);

  const warnings = useMemo(() => (data ? buildRuntimeWarnings(data) : []), [data]);
  const selectedAugment =
    selectedAugmentName && data
      ? data.augments.find((augment) => augment.name === selectedAugmentName)
      : undefined;
  const visibleRoutes = selectedAugment
    ? data?.routes.entries.filter((route) => route.augmentName === selectedAugment.name) ?? []
    : data?.routes.entries ?? [];
  const visibleTools = selectedAugment
    ? data?.tools.entries.filter((tool) => tool.augmentName === selectedAugment.name) ?? []
    : data?.tools.entries ?? [];
  const visibleMemoryAugments =
    data?.augments.filter(
      (augment) =>
        augment.isMemoryProvider && (!selectedAugment || augment.name === selectedAugment.name),
    ) ?? [];
  const visibleWarnings = selectedAugment
    ? warnings.filter((warning) => warning.augmentName === selectedAugment.name)
    : warnings;
  const showConversation = shouldShowConversation(data, selectedAugment);
  const showAuthPosture = !selectedAugment || selectedAugment.category === "guardrails";

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Capabilities</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Capabilities load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl gap-4 p-3 sm:p-4">
        <section className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-normal">Capabilities</h2>
              <p className="text-sm text-muted-foreground">
                Runtime map of mounted augments and the surfaces they expose.
              </p>
            </div>
            {selectedAugment && (
              <Button variant="outline" size="sm" onClick={() => setSelectedAugmentName(null)}>
                Show all
              </Button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryTile label="Augments" value={data.augments.length} icon={<Package />} />
            <SummaryTile label="Routes" value={data.routes.summary.totalRoutes} icon={<Route />} />
            <SummaryTile label="Tools" value={data.tools.totalTools} icon={<Wrench />} />
            <SummaryTile
              label="Memory"
              value={data.augments.filter((augment) => augment.isMemoryProvider).length}
              icon={<Brain />}
            />
            <SummaryTile label="Warnings" value={warnings.length} icon={<AlertTriangle />} />
          </div>
        </section>

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(20rem,0.95fr)_minmax(0,1.45fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Mounted augments</CardTitle>
              <CardDescription>Owners of routes, tools, memory, and policy.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {CATEGORY_ORDER.map((category) => {
                const augments = data.augments.filter((augment) => augment.category === category);
                if (augments.length === 0) return null;
                return (
                  <section key={category} className="grid gap-2">
                    <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                      {CATEGORY_LABELS[category]}
                    </div>
                    <div className="grid gap-2">
                      {augments.map((augment) => (
                        <AugmentNode
                          key={augment.name}
                          augment={augment}
                          routeCount={
                            data.routes.entries.filter(
                              (route) => route.augmentName === augment.name,
                            ).length
                          }
                          toolCount={
                            data.tools.entries.filter((tool) => tool.augmentName === augment.name)
                              .length
                          }
                          warningCount={
                            warnings.filter((warning) => warning.augmentName === augment.name)
                              .length
                          }
                          selected={selectedAugment?.name === augment.name}
                          onSelect={() => setSelectedAugmentName(augment.name)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{selectedAugment ? selectedAugment.type : "Runtime surfaces"}</CardTitle>
              <CardDescription>
                {selectedAugment
                  ? `Surfaces exposed by ${selectedAugment.name}.`
                  : "Conversation, app routes, tools, memory, and access posture."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {showConversation && <ConversationSurface data={data} />}
              <RouteSurface routes={visibleRoutes} selectedAugment={selectedAugment} />
              <ToolSurface tools={visibleTools} selectedAugment={selectedAugment} />
              <MemorySurface augments={visibleMemoryAugments} selectedAugment={selectedAugment} />
              {showAuthPosture && <AuthSurface data={data} />}
              <WarningSurface warnings={visibleWarnings} selectedAugment={selectedAugment} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className="flex min-h-16 items-center justify-between rounded-md border bg-background px-3 py-2">
      <div>
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold leading-none">{value}</div>
      </div>
      <div className="grid size-8 place-items-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
    </div>
  );
}

function AugmentNode({
  augment,
  routeCount,
  toolCount,
  warningCount,
  selected,
  onSelect,
}: {
  augment: AugmentSummary;
  routeCount: number;
  toolCount: number;
  warningCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "grid gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors",
        "hover:border-foreground/40 hover:bg-muted/40",
        selected && "border-foreground bg-muted/60",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={augment.type}>
            {augment.type}
          </div>
          <div
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={augment.name}
          >
            {augment.name}
          </div>
        </div>
        {warningCount > 0 && <Badge variant="warn">{warningCount} warning</Badge>}
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge variant={routeCount > 0 ? "info" : "outline"}>{routeCount} routes</Badge>
        <Badge variant={toolCount > 0 ? "secondary" : "outline"}>{toolCount} tools</Badge>
        {augment.isMemoryProvider && <Badge variant="success">memory</Badge>}
        {augment.hasAdminInfo && <Badge variant="outline">posture</Badge>}
      </div>
    </button>
  );
}

function ConversationSurface({ data }: { data: DashboardData }) {
  return (
    <SurfaceGroup title="Conversation" icon={<Network className="size-4" />}>
      {buildConversationSurfaceRows(data).map((row) => (
        <SurfaceRow key={row.title} {...row} />
      ))}
    </SurfaceGroup>
  );
}

export function buildConversationSurfaceRows(
  data: { web: Pick<DashboardData["web"], "allowAnonymous"> },
): Array<{ title: string; detail: string; badges: string[] }> {
  const allowAnonymous = data.web.allowAnonymous.value === true;
  return [
    {
      title: "POST /agent/run",
      detail: allowAnonymous ? "AG-UI chat, anonymous allowed" : "AG-UI chat, creator auth",
      badges: [allowAnonymous ? "anonymous" : "creator"],
    },
  ];
}

function RouteSurface({
  routes,
  selectedAugment,
}: {
  routes: RouteManifestEntry[];
  selectedAugment?: AugmentSummary;
}) {
  if (routes.length === 0) {
    return (
      <SurfaceGroup title="App routes" icon={<Route className="size-4" />}>
        <EmptySurface>
          {selectedAugment
            ? "This augment exposes no app routes."
            : "No augment HTTP routes reported."}
        </EmptySurface>
      </SurfaceGroup>
    );
  }

  return (
    <SurfaceGroup title="App routes" icon={<Route className="size-4" />}>
      {routes.map((route) => (
        <SurfaceRow
          key={`${route.method} ${route.path}`}
          title={`${route.method} ${route.path}`}
          detail={route.augmentName}
          badges={[
            route.public ? "public" : "private",
            route.auth,
            route.requestJsonSchema ? "request schema" : "request schema missing",
            route.responseJsonSchema ? "response schema" : "response schema missing",
            route.rateLimit ? `${route.rateLimit.maxPerMinute}/min` : undefined,
            route.policy?.kind,
          ]}
        />
      ))}
    </SurfaceGroup>
  );
}

function ToolSurface({
  tools,
  selectedAugment,
}: {
  tools: ToolSummary[];
  selectedAugment?: AugmentSummary;
}) {
  if (tools.length === 0) {
    return (
      <SurfaceGroup title="Tools" icon={<Wrench className="size-4" />}>
        <EmptySurface>
          {selectedAugment ? "This augment exposes no tools." : "No tools reported."}
        </EmptySurface>
      </SurfaceGroup>
    );
  }

  return (
    <SurfaceGroup title="Tools" icon={<Wrench className="size-4" />}>
      {tools.map((tool) => (
        <SurfaceRow
          key={`${tool.augmentName}:${tool.name}`}
          title={tool.name}
          detail={`${tool.augmentName} · ${tool.description}`}
          badges={[
            tool.category,
            tool.hasInputSchema ? "input schema" : "input schema missing",
            tool.requires ? "delegated auth" : undefined,
            tool.constraints.requiresHumanApproval ? "approval" : undefined,
            tool.constraints.neverExpose ? "hidden" : undefined,
          ]}
        />
      ))}
    </SurfaceGroup>
  );
}

function MemorySurface({
  augments,
  selectedAugment,
}: {
  augments: AugmentSummary[];
  selectedAugment?: AugmentSummary;
}) {
  if (augments.length === 0) {
    return (
      <SurfaceGroup title="Memory" icon={<Brain className="size-4" />}>
        <EmptySurface>
          {selectedAugment
            ? "This augment is not a memory provider."
            : "No memory provider reported."}
        </EmptySurface>
      </SurfaceGroup>
    );
  }

  return (
    <SurfaceGroup title="Memory" icon={<Brain className="size-4" />}>
      {augments.map((augment) => (
        <SurfaceRow
          key={augment.name}
          title={augment.type}
          detail={augment.name}
          badges={["provider", formatMemorySurfaceCapabilities(augment)]}
        />
      ))}
    </SurfaceGroup>
  );
}

export function formatMemorySurfaceCapabilities(
  augment: Pick<AugmentSummary, "hasContext" | "usesSharedMemoryTools">,
): string | undefined {
  const capabilities = [
    augment.hasContext ? "context" : undefined,
    augment.usesSharedMemoryTools ? "tools" : undefined,
  ].filter((capability): capability is string => capability !== undefined);
  return capabilities.length > 0 ? capabilities.join(", ") : undefined;
}

function AuthSurface({ data }: { data: DashboardData }) {
  return (
    <SurfaceGroup title="Guardrails / Auth" icon={<Shield className="size-4" />}>
      <SurfaceRow
        title="Legacy runtime metadata"
        detail={
          data.web.publicIntegration.value === true
            ? "Published through Auggy-only endpoints; not an A2A integration"
            : "Private Auggy-only metadata; not an A2A integration"
        }
        badges={[
          "legacy",
          data.web.publicIntegration.value === true ? "public" : "private",
        ]}
      />
      <SurfaceRow
        title="Anonymous chat"
        detail={data.web.allowAnonymous.value === true ? "Allowed" : "Disabled"}
        badges={[data.web.allowAnonymous.value === true ? "anonymous" : "creator"]}
      />
      <SurfaceRow
        title="Visitor tokens"
        detail={data.web.visitorTokensEnabled === true ? "Enabled" : "Disabled"}
        badges={[data.web.visitorTokensEnabled === true ? "enabled" : "disabled"]}
      />
      <SurfaceRow
        title="External auth"
        detail={
          data.web.externalAuthEnabled === true
            ? data.web.externalAuthHeader ?? "x-auggy-auth-assertion"
            : "Disabled"
        }
        badges={[data.web.externalAuthEnabled === true ? "enabled" : "disabled"]}
      />
      <SurfaceRow
        title="Agent access"
        detail={`${data.web.agentAccessEntries ?? "0"} configured entries`}
        badges={["agent.required"]}
      />
    </SurfaceGroup>
  );
}

function WarningSurface({
  warnings,
  selectedAugment,
}: {
  warnings: RuntimeWarning[];
  selectedAugment?: AugmentSummary;
}) {
  if (warnings.length === 0) {
    return (
      <SurfaceGroup title="Warnings" icon={<AlertTriangle className="size-4" />}>
        <EmptySurface>
          {selectedAugment ? "No warnings for this augment." : "No runtime map warnings."}
        </EmptySurface>
      </SurfaceGroup>
    );
  }

  return (
    <SurfaceGroup title="Warnings" icon={<AlertTriangle className="size-4" />}>
      {warnings.map((warning) => (
        <SurfaceRow
          key={warning.id}
          title={warning.surface}
          detail={warning.message}
          badges={[warning.severity, warning.augmentName]}
        />
      ))}
    </SurfaceGroup>
  );
}

function SurfaceGroup({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </div>
      <div className="divide-y rounded-md border bg-background">{children}</div>
    </section>
  );
}

function SurfaceRow({
  title,
  detail,
  badges,
}: {
  title: string;
  detail: string;
  badges: Array<string | undefined>;
}) {
  const filteredBadges = badges.filter((badge): badge is string => Boolean(badge));
  return (
    <div className="grid gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 truncate font-mono text-xs" title={title}>
          {title}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {filteredBadges.slice(0, 5).map((badge) => (
            <Badge key={badge} variant={badgeVariant(badge)}>
              {badge}
            </Badge>
          ))}
        </div>
      </div>
      <div className="min-w-0 truncate text-xs text-muted-foreground" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function EmptySurface({ children }: { children: ReactNode }) {
  return <div className="px-3 py-3 text-sm text-muted-foreground">{children}</div>;
}

function shouldShowConversation(
  data: DashboardData | null,
  selectedAugment?: AugmentSummary,
): boolean {
  if (!data) return false;
  if (!selectedAugment) return true;
  return (
    selectedAugment.isTransport ||
    selectedAugment.type === "webTransport" ||
    selectedAugment.name === "web"
  );
}

function buildRuntimeWarnings(data: DashboardData): RuntimeWarning[] {
  const warnings: RuntimeWarning[] = [];

  for (const route of data.routes.entries) {
    if (route.auth === "none") {
      warnings.push({
        id: `route-none:${route.method}:${route.path}`,
        severity: "warn",
        augmentName: route.augmentName,
        surface: `${route.method} ${route.path}`,
        message: "Route is public without auth.",
      });
    }
    if (route.public && !route.responseJsonSchema) {
      warnings.push({
        id: `route-schema:${route.method}:${route.path}`,
        severity: "info",
        augmentName: route.augmentName,
        surface: `${route.method} ${route.path}`,
        message: "Public route has no response schema for generated clients.",
      });
    }
    if (route.auth.startsWith("visitor.") && data.web.visitorTokensEnabled !== true) {
      warnings.push({
        id: `route-visitor:${route.method}:${route.path}`,
        severity: "error",
        augmentName: route.augmentName,
        surface: `${route.method} ${route.path}`,
        message: "Visitor-auth route exists, but visitor tokens are disabled.",
      });
    }
    if (route.auth === "agent.required" && Number(data.web.agentAccessEntries ?? "0") === 0) {
      warnings.push({
        id: `route-agent:${route.method}:${route.path}`,
        severity: "warn",
        augmentName: route.augmentName,
        surface: `${route.method} ${route.path}`,
        message: "Agent-required route exists with no configured agent access entries.",
      });
    }
  }

  for (const tool of data.tools.entries) {
    if (!tool.hasInputSchema) {
      warnings.push({
        id: `tool-schema:${tool.augmentName}:${tool.name}`,
        severity: "info",
        augmentName: tool.augmentName,
        surface: tool.name,
        message: "Tool has no JSON input schema for operator inspection.",
      });
    }
    if (tool.constraints.neverExpose) {
      warnings.push({
        id: `tool-hidden:${tool.augmentName}:${tool.name}`,
        severity: "warn",
        augmentName: tool.augmentName,
        surface: tool.name,
        message: "Tool is mounted but globally hidden by augment constraints.",
      });
    }
    if (tool.constraints.requiresHumanApproval) {
      warnings.push({
        id: `tool-approval:${tool.augmentName}:${tool.name}`,
        severity: "info",
        augmentName: tool.augmentName,
        surface: tool.name,
        message: "Tool requires human approval before execution.",
      });
    }
  }

  return warnings;
}

function badgeVariant(badge: string): ComponentProps<typeof Badge>["variant"] {
  if (badge === "error" || badge === "disabled" || badge.includes("missing")) return "destructive";
  if (badge === "warn" || badge === "public" || badge === "none") return "warn";
  if (badge === "info" || badge.includes("schema") || badge.includes("/min")) return "info";
  if (badge === "enabled" || badge === "provider" || badge === "private") return "success";
  return "outline";
}
