import { AlertTriangle, Brain, Info, Network, Route, Shield, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type {
  AugmentCapabilityModel,
  CapabilityBadge,
  CapabilityModel,
} from "@/lib/capability-model";
import type { AugmentSummary, DashboardData } from "@/lib/types";
import {
  CapabilityEmptyState,
  CapabilityRow,
  CapabilitySurface,
  FindingRows,
} from "./CapabilityPrimitives";

export function CapabilityDetail({
  data,
  model,
}: {
  data: DashboardData;
  model: CapabilityModel;
}) {
  const selectedNode = model.scope.selectedAugmentName
    ? model.augmentNodes.find((node) => node.augment.name === model.scope.selectedAugmentName)
    : undefined;
  const showConversation = shouldShowConversation(selectedNode?.augment);
  const showAuth = !selectedNode || isWebTransport(selectedNode.augment);
  const safeguards = model.scope.tools.filter(hasSafeguards);
  const hasScopedSurface =
    showConversation ||
    showAuth ||
    model.scope.routes.length > 0 ||
    model.scope.tools.length > 0 ||
    model.scope.memoryAugments.length > 0 ||
    model.scope.findings.length > 0;

  return (
    <div className="grid gap-4">
      {selectedNode && <AugmentIdentity node={selectedNode} />}
      {!hasScopedSurface ? (
        <CapabilityEmptyState
          title="No runtime surfaces"
          detail="This augment is mounted but does not expose routes, tools, memory, or operator findings."
        />
      ) : (
        <>
          {model.scope.issues.length > 0 && (
            <CapabilitySurface title="Issues" icon={<AlertTriangle className="size-4" />}>
              <FindingRows findings={model.scope.issues} />
            </CapabilitySurface>
          )}
          {showConversation && <ConversationSurface data={data} />}
          {model.scope.routes.length > 0 && <RouteSurface model={model} />}
          {model.scope.tools.length > 0 && <ToolSurface model={model} />}
          {model.scope.memoryAugments.length > 0 && <MemorySurface model={model} />}
          {showAuth && <AuthSurface data={data} />}
          {safeguards.length > 0 && (
            <CapabilitySurface title="Safeguards" icon={<Shield className="size-4" />}>
              {safeguards.map((tool) => (
                <CapabilityRow
                  key={tool.id}
                  title={tool.title}
                  detail={safeguardDetail(tool)}
                  badges={tool.badges.filter(
                    (badge) =>
                      badge.kind === "visibility-safeguard" ||
                      badge.kind === "approval-safeguard",
                  )}
                />
              ))}
            </CapabilitySurface>
          )}
          {model.scope.notes.length > 0 && (
            <CapabilitySurface title="Notes" icon={<Info className="size-4" />}>
              <FindingRows findings={model.scope.notes} />
            </CapabilitySurface>
          )}
        </>
      )}
    </div>
  );
}

function AugmentIdentity({ node }: { node: AugmentCapabilityModel }) {
  const { augment } = node;
  return (
    <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold" title={augment.type}>
            {augment.type}
          </div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">{augment.name}</div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">{augment.category}</Badge>
          {augment.version && <Badge variant="outline">v{augment.version}</Badge>}
          {augment.required && <Badge variant="info">required</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {augment.lifecycleHooks.length > 0 ? (
          augment.lifecycleHooks.map((hook) => (
            <Badge key={hook} variant="secondary">
              {hook}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">No lifecycle hooks reported.</span>
        )}
      </div>
    </div>
  );
}

function ConversationSurface({ data }: { data: DashboardData }) {
  return (
    <CapabilitySurface title="Conversation" icon={<Network className="size-4" />}>
      {buildConversationSurfaceRows(data).map((row) => (
        <CapabilityRow key={row.title} {...row} />
      ))}
    </CapabilitySurface>
  );
}

export function buildConversationSurfaceRows(
  data: { web: Pick<DashboardData["web"], "allowAnonymous"> },
): Array<{ title: string; detail: string; badges: CapabilityBadge[] }> {
  const allowAnonymous = data.web.allowAnonymous.value === true;
  return [
    {
      title: "POST /agent/run",
      detail: allowAnonymous ? "AG-UI chat, anonymous allowed" : "AG-UI chat, creator auth",
      badges: [
        semanticBadge(
          "auth",
          allowAnonymous ? "anonymous" : "creator",
          allowAnonymous ? "neutral" : "success",
        ),
      ],
    },
  ];
}

function RouteSurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface title="App routes" icon={<Route className="size-4" />}>
      {model.scope.routes.map((route) => (
        <CapabilityRow
          key={route.id}
          title={route.title}
          detail={route.detail}
          badges={route.badges}
        />
      ))}
    </CapabilitySurface>
  );
}

function ToolSurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface title="Tools" icon={<Wrench className="size-4" />}>
      {model.scope.tools.map((tool) => (
        <CapabilityRow
          key={tool.id}
          title={tool.title}
          detail={tool.detail}
          badges={tool.badges.filter(
            (badge) =>
              badge.kind !== "visibility-safeguard" && badge.kind !== "approval-safeguard",
          )}
        />
      ))}
    </CapabilitySurface>
  );
}

function MemorySurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface title="Memory" icon={<Brain className="size-4" />}>
      {model.scope.memoryAugments.map((augment) => (
        <CapabilityRow
          key={augment.name}
          title={augment.type}
          detail={augment.name}
          badges={memoryBadges(augment)}
        />
      ))}
    </CapabilitySurface>
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
  const rows: Array<{ title: string; detail: string; badges: CapabilityBadge[] }> = [
    {
      title: "Anonymous chat",
      detail: data.web.allowAnonymous.value === true ? "Allowed" : "Disabled",
      badges: [
        semanticBadge(
          "auth",
          data.web.allowAnonymous.value === true ? "anonymous" : "creator",
          data.web.allowAnonymous.value === true ? "neutral" : "success",
        ),
      ],
    },
    {
      title: "Visitor tokens",
      detail: data.web.visitorTokensEnabled === true ? "Enabled" : "Disabled",
      badges: [
        semanticBadge(
          "auth",
          data.web.visitorTokensEnabled === true ? "enabled" : "disabled",
          data.web.visitorTokensEnabled === true ? "success" : "neutral",
        ),
      ],
    },
    {
      title: "External auth",
      detail:
        data.web.externalAuthEnabled === true
          ? data.web.externalAuthHeader ?? "x-auggy-auth-assertion"
          : "Disabled",
      badges: [
        semanticBadge(
          "auth",
          data.web.externalAuthEnabled === true ? "enabled" : "disabled",
          data.web.externalAuthEnabled === true ? "success" : "neutral",
        ),
      ],
    },
    {
      title: "Agent access",
      detail: `${data.web.agentAccessEntries ?? "0"} configured entries`,
      badges: [semanticBadge("auth", "agent.required", "neutral")],
    },
  ];
  return (
    <CapabilitySurface title="Guardrails / Auth" icon={<Shield className="size-4" />}>
      {rows.map((row) => (
        <CapabilityRow key={row.title} {...row} />
      ))}
    </CapabilitySurface>
  );
}

function shouldShowConversation(augment?: AugmentSummary): boolean {
  if (!augment) return true;
  return isWebTransport(augment);
}

function isWebTransport(augment: AugmentSummary): boolean {
  return augment.type === "webTransport" || augment.name === "web";
}

function memoryBadges(augment: AugmentSummary): CapabilityBadge[] {
  const badges: CapabilityBadge[] = [];
  if (augment.isMemoryProvider) badges.push(semanticBadge("tool-category", "provider", "success"));
  if (augment.hasContext) badges.push(semanticBadge("tool-category", "context", "info"));
  if (augment.usesSharedMemoryTools) {
    badges.push(semanticBadge("tool-category", "shared tools", "info"));
  }
  return badges;
}

function semanticBadge(
  kind: CapabilityBadge["kind"],
  label: string,
  tone: CapabilityBadge["tone"],
): CapabilityBadge {
  return { id: `${kind}:${label}`, kind, label, tone };
}

function hasSafeguards(tool: CapabilityModel["scope"]["tools"][number]): boolean {
  return (
    tool.safeguards.globallyHidden ||
    tool.safeguards.requiresHumanApproval ||
    tool.safeguards.hiddenFromTrustLevels.length > 0 ||
    tool.safeguards.approvalRequiredForTrustLevels.length > 0
  );
}

function safeguardDetail(tool: CapabilityModel["scope"]["tools"][number]): string {
  const details: string[] = [];
  if (tool.safeguards.globallyHidden) details.push("hidden globally");
  if (tool.safeguards.hiddenFromTrustLevels.length > 0) {
    details.push(`hidden from ${tool.safeguards.hiddenFromTrustLevels.join(", ")}`);
  }
  if (tool.safeguards.requiresHumanApproval) details.push("human approval always required");
  if (tool.safeguards.approvalRequiredForTrustLevels.length > 0) {
    details.push(
      `approval for ${tool.safeguards.approvalRequiredForTrustLevels.join(", ")}`,
    );
  }
  return details.join(" · ");
}
