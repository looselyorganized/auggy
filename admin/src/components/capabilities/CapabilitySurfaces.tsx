import { AlertTriangle, BookOpen, Brain, Info, Network, Route, Shield, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import type {
  AugmentCapabilityModel,
  CapabilityBadge,
  CapabilityModel,
} from "@/lib/capability-model";
import type { AugmentSummary, DashboardData } from "@/lib/types";
import { presentAugment } from "@/lib/capability-presenters";
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
  const hasScopedSurface =
    showConversation ||
    model.scope.routes.length > 0 ||
    model.scope.tools.length > 0 ||
    model.scope.skills.length > 0 ||
    model.scope.memoryAugments.length > 0 ||
    model.scope.safeguards.length > 0 ||
    model.scope.findings.length > 0;

  return (
    <div className="grid gap-4">
      {selectedNode && <AugmentIdentity node={selectedNode} />}
      {!hasScopedSurface ? (
        <CapabilityEmptyState
          title="No runtime surfaces"
          detail="This augment is mounted but reports no routes, tools, skills, memory, access controls, or operator findings."
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
          {model.scope.skills.length > 0 && <SkillSurface model={model} />}
          {model.scope.memoryAugments.length > 0 && <MemorySurface model={model} />}
          {model.scope.safeguards.length > 0 && (
            <CapabilitySurface title="Access & controls" icon={<Shield className="size-4" />}>
              {model.scope.safeguards.map((safeguard) => (
                <CapabilityRow
                  key={safeguard.id}
                  title={safeguard.title}
                  detail={
                    model.scope.selectedAugmentName || !safeguard.augmentName
                      ? safeguard.detail
                      : `${safeguard.augmentName} · ${safeguard.detail}`
                  }
                  badges={safeguard.badges}
                />
              ))}
              {model.scope.safeguards.some((entry) => entry.configurationHref) && (
                <div role="listitem">
                  <Link
                    to="/integrations"
                    className="block rounded-sm px-3 py-2 text-xs font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-sky-300"
                  >
                    Change auth and integration settings →
                  </Link>
                </div>
              )}
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
  const presentation = presentAugment(augment);
  return (
    <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="break-words text-base font-semibold" title={presentation.title}>
            {presentation.title}
          </h4>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {augment.name} · {augment.type}
          </div>
          {presentation.detail && (
            <p className="mt-1 text-xs text-muted-foreground">{presentation.detail}</p>
          )}
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
        {augment.handlesInternalTurns && <Badge variant="info">internal turns</Badge>}
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
  const allowAnonymous = data.web.allowAnonymous.value;
  const detail = allowAnonymous === true
    ? "AG-UI chat, anonymous allowed"
    : allowAnonymous === false
      ? "AG-UI chat, authentication required"
      : "AG-UI chat authentication not reported";
  const label = allowAnonymous === true
    ? "anonymous"
    : allowAnonymous === false
      ? "auth required"
      : "auth not reported";
  return [
    {
      title: "POST /agent/run",
      detail,
      badges: [semanticBadge("auth", label, "neutral")],
    },
  ];
}

function RouteSurface({ model }: { model: CapabilityModel }) {
  const scoped = model.scope.selectedAugmentName !== null;
  return (
    <CapabilitySurface title="App routes" icon={<Route className="size-4" />}>
      {model.scope.routes.map((route) => (
        <CapabilityRow
          key={route.id}
          title={route.title}
          detail={scoped ? route.detail : `${route.augmentName} · ${route.detail}`}
          badges={route.badges}
        />
      ))}
      <div role="listitem">
        <Link
          to="/integrations"
          className="block rounded-sm px-3 py-2 text-xs font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-sky-300"
        >
          Connection and client setup →
        </Link>
      </div>
    </CapabilitySurface>
  );
}

function ToolSurface({ model }: { model: CapabilityModel }) {
  const scoped = model.scope.selectedAugmentName !== null;
  return (
    <CapabilitySurface title="Tools" icon={<Wrench className="size-4" />}>
      {model.scope.tools.map((tool) => (
        <CapabilityRow
          key={tool.id}
          title={tool.title}
          detail={scoped ? tool.detail : `${tool.augmentName} · ${tool.detail}`}
          badges={tool.badges}
        />
      ))}
    </CapabilitySurface>
  );
}

function SkillSurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface title="Skills" icon={<BookOpen className="size-4" />}>
      {model.scope.skills.map((skill) => (
        <CapabilityRow
          key={skill.id}
          title={skill.title}
          detail={skill.detail}
          badges={skill.badges}
        />
      ))}
    </CapabilitySurface>
  );
}

function MemorySurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface title="Memory" icon={<Brain className="size-4" />}>
      {model.scope.memoryAugments.map((augment) => {
        const presentation = presentAugment(augment);
        return (
        <CapabilityRow
          key={augment.name}
          title={presentation.title}
          detail={
            presentation.detail
              ? `${augment.name} · ${presentation.detail}`
              : presentation.subtitle ?? augment.name
          }
          badges={memoryBadges(augment)}
        />
        );
      })}
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

function shouldShowConversation(augment?: AugmentSummary): boolean {
  if (!augment) return true;
  return isWebTransport(augment);
}

function isWebTransport(augment: AugmentSummary): boolean {
  return augment.type === "webTransport" || augment.name === "web";
}

function memoryBadges(augment: AugmentSummary): CapabilityBadge[] {
  const badges: CapabilityBadge[] = [];
  if (augment.isMemoryProvider) badges.push(semanticBadge("tool-category", "provider", "info"));
  if (augment.hasContext) badges.push(semanticBadge("tool-category", "context", "info"));
  if (augment.usesSharedMemoryTools) {
    badges.push(semanticBadge("tool-category", "shared tools", "info"));
  }
  if (augment.memory) {
    badges.push(
      semanticBadge(
        "tool-category",
        augment.memory.mutable ? "writable" : "read-only",
        augment.memory.mutable ? "info" : "neutral",
      ),
    );
    badges.push(semanticBadge("tool-category", augment.memory.placement, "neutral"));
    badges.push(semanticBadge("tool-category", augment.memory.ttl, "neutral"));
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
