import { AlertTriangle, BookOpen, Brain, Info, Network, Route, Shield, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type {
  AugmentCapabilityModel,
  CapabilityBadge,
  CapabilityFinding,
  CapabilityModel,
  RouteCapabilityView,
  SkillCapabilityView,
  ToolCapabilityView,
} from "@/lib/capability-model";
import { presentAugment } from "@/lib/capability-presenters";
import type { AugmentSummary, DashboardData } from "@/lib/types";
import {
  CapabilityEmptyState,
  type CapabilityField,
  type CapabilityHealth,
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
    <div className="grid gap-5">
      {selectedNode && <AugmentIdentity node={selectedNode} />}
      {!hasScopedSurface ? (
        <CapabilityEmptyState
          title="No runtime surfaces"
          detail="This augment is mounted but reports no routes, tools, skills, memory, access controls, or operator findings."
        />
      ) : (
        <>
          {model.scope.issues.length > 0 && (
            <CapabilitySurface
              title="Issues"
              count={model.scope.issues.length}
              icon={<AlertTriangle className="size-4" />}
            >
              <FindingRows findings={model.scope.issues} />
            </CapabilitySurface>
          )}
          {showConversation && <ConversationSurface data={data} />}
          {model.scope.routes.length > 0 && <RouteSurface model={model} />}
          {model.scope.tools.length > 0 && <ToolSurface model={model} />}
          {model.scope.skills.length > 0 && <SkillSurface model={model} />}
          {model.scope.memoryAugments.length > 0 && <MemorySurface model={model} />}
          {model.scope.safeguards.length > 0 && <SafeguardSurface model={model} />}
          {model.scope.notes.length > 0 && (
            <CapabilitySurface
              title="Notes"
              count={model.scope.notes.length}
              icon={<Info className="size-4" />}
            >
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
  const fields: CapabilityField[] = [
    { label: "Runtime", value: augment.name },
    { label: "Type", value: augment.type },
    { label: "Category", value: capitalize(augment.category) },
    ...(augment.required ? [{ label: "Mount", value: "Required" }] : []),
    ...(augment.version ? [{ label: "Version", value: augment.version }] : []),
    {
      label: "Lifecycle",
      value:
        augment.lifecycleHooks.length > 0
          ? augment.lifecycleHooks.join(", ")
          : "No hooks reported",
    },
  ];
  if (augment.handlesInternalTurns) fields.push({ label: "Turns", value: "Handles internal turns" });

  return (
    <section className="grid gap-3 rounded-md border bg-muted/20 p-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {capitalize(augment.category)}
        </div>
        <h4 className="mt-1 break-words text-base font-semibold" title={presentation.title}>
          {presentation.title}
        </h4>
        {presentation.detail && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{presentation.detail}</p>
        )}
      </div>
      <dl className="grid gap-x-5 gap-y-1.5 text-xs sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="break-words">{field.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ConversationSurface({ data }: { data: DashboardData }) {
  return (
    <CapabilitySurface title="Conversation" count={1} icon={<Network className="size-4" />}>
      {buildConversationSurfaceRows(data).map((row) => (
        <CapabilityRow key={row.title} {...row} />
      ))}
    </CapabilitySurface>
  );
}

export function buildConversationSurfaceRows(
  data: { web: Pick<DashboardData["web"], "allowAnonymous"> },
): Array<{
  title: string;
  prefix: string;
  detail: string;
  health: CapabilityHealth;
  fields: CapabilityField[];
}> {
  const allowAnonymous = data.web.allowAnonymous.value;
  const access =
    allowAnonymous === true
      ? "Public"
      : allowAnonymous === false
        ? "Authentication required"
        : "Not reported";
  return [
    {
      title: "/agent/run",
      prefix: "POST",
      detail: "Primary AG-UI conversation endpoint.",
      health: allowAnonymous === null ? "neutral" : "ready",
      fields: [{ label: "Access", value: access }],
    },
  ];
}

function RouteSurface({ model }: { model: CapabilityModel }) {
  const scoped = model.scope.selectedAugmentName !== null;
  return (
    <CapabilitySurface
      title="App routes"
      count={model.scope.routes.length}
      icon={<Route className="size-4" />}
    >
      {model.scope.routes.map((route) => {
        const [method, ...pathParts] = route.title.split(" ");
        const path = pathParts.join(" ");
        const limits = routeLimits(route.badges);
        return (
          <CapabilityRow
            key={route.id}
            prefix={method}
            title={path}
            detail={scoped ? "Runtime app route." : `Runtime app route owned by ${route.augmentName}.`}
            category={scoped ? undefined : route.augmentName}
            health={healthFor(route.id, model.scope.findings)}
            fields={[
              { label: "Access", value: routeAccessSummary(route) },
              {
                label: "Request",
                value: contractSummary(
                  route.contract.requestMediaTypes,
                  route.contract.hasRequestBodySchema,
                ),
              },
              {
                label: "Response",
                value: contractSummary(
                  route.contract.responseMediaTypes,
                  route.contract.hasResponseSchema,
                ),
              },
              ...(limits ? [{ label: "Limits", value: limits }] : []),
            ]}
            expandedFields={[
              { label: "Owner", value: route.augmentName },
              { label: "Policy", value: route.detail },
              { label: "Request schema", value: route.contract.hasRequestBodySchema ? "Defined" : "Not defined" },
              { label: "Response schema", value: route.contract.hasResponseSchema ? "Defined" : "Not defined" },
              { label: "Accepts", value: mediaTypesLabel(route.contract.requestMediaTypes) },
              { label: "Returns", value: mediaTypesLabel(route.contract.responseMediaTypes) },
              ...routeDetailFields(route.badges),
            ]}
          />
        );
      })}
      <div role="listitem">
        <Link
          to="/integrations"
          className="block rounded-sm px-4 py-3 text-xs font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-sky-300"
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
    <CapabilitySurface
      title="Tools"
      count={model.scope.tools.length}
      icon={<Wrench className="size-4" />}
    >
      {model.scope.tools.map((tool) => (
        <CapabilityRow
          key={tool.id}
          title={tool.title}
          detail={tool.detail}
          category={badgeValue(tool.badges, "tool-category")}
          health={healthFor(tool.id, model.scope.findings)}
          fields={[
            { label: "Access", value: toolAccessSummary(tool) },
            { label: "Input", value: toolInputSummary(tool) },
            ...toolLimitFields(tool.badges),
          ]}
          expandedFields={[
            ...(!scoped ? [{ label: "Owner", value: tool.augmentName }] : []),
            { label: "Augment type", value: tool.augmentType },
            { label: "Visibility", value: toolAccessDetail(tool) },
            { label: "Approval", value: toolApprovalDetail(tool) },
            ...toolDetailFields(tool.badges),
          ]}
        />
      ))}
    </CapabilitySurface>
  );
}

function SkillSurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface
      title="Skills"
      count={model.scope.skills.length}
      icon={<BookOpen className="size-4" />}
    >
      {model.scope.skills.map((skill) => (
        <CapabilityRow
          key={skill.id}
          title={skill.title}
          detail={skill.detail}
          category="Skill"
          health={skillHealth(skill)}
          healthLabel={skill.state === "installed" ? "Installed" : "Available"}
          fields={[
            { label: "State", value: capitalize(skill.state) },
            { label: "Source", value: badgeValue(skill.badges, "skill-source") ?? "Not reported" },
            {
              label: skill.state === "installed" ? "Installed at" : "Installs to",
              value: `skills/${skill.folder}/SKILL.md`,
            },
          ]}
          expandedFields={[
            ...(skill.augmentType ? [{ label: "Augment type", value: skill.augmentType }] : []),
            ...(skill.frontmatterValid !== undefined
              ? [{ label: "Frontmatter", value: skill.frontmatterValid ? "Valid" : "Invalid" }]
              : []),
          ]}
        />
      ))}
    </CapabilitySurface>
  );
}

function MemorySurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface
      title="Memory"
      count={model.scope.memoryAugments.length}
      icon={<Brain className="size-4" />}
    >
      {model.scope.memoryAugments.map((augment) => {
        const presentation = presentAugment(augment);
        const policy = memoryPolicy(augment);
        return (
          <CapabilityRow
            key={augment.name}
            title={presentation.title}
            detail={presentation.detail ?? "Runtime memory surface."}
            category={augment.type}
            health="ready"
            fields={[
              { label: "Access", value: policy.mutable ? writableBy(policy.writeTrustLevels) : "Read-only" },
              { label: "Placement", value: capitalize(policy.placement) },
              { label: "Lifetime", value: capitalize(policy.ttl) },
            ]}
            expandedFields={[
              { label: "Runtime", value: augment.name },
              { label: "Ownership", value: memoryOwnership(augment) },
              { label: "Origin", value: capitalize(policy.origin) },
              { label: "Priority", value: capitalize(policy.priority) },
              { label: "Eviction", value: capitalize(policy.eviction) },
              { label: "Surfaces", value: formatMemorySurfaceCapabilities(augment) ?? "Provider only" },
            ]}
          />
        );
      })}
    </CapabilitySurface>
  );
}

function SafeguardSurface({ model }: { model: CapabilityModel }) {
  return (
    <CapabilitySurface
      title="Access & controls"
      count={model.scope.safeguards.length}
      icon={<Shield className="size-4" />}
    >
      {model.scope.safeguards.map((safeguard) => (
        <CapabilityRow
          key={safeguard.id}
          title={safeguard.title}
          detail={
            model.scope.selectedAugmentName || !safeguard.augmentName
              ? safeguard.detail
              : `${safeguard.augmentName} · ${safeguard.detail}`
          }
          category="Control"
          {...safeguardStatus(safeguard.kind)}
          fields={[
            ...(safeguard.augmentName ? [{ label: "Owner", value: safeguard.augmentName }] : []),
            ...(safeguard.badges.length > 0
              ? [{ label: "Policy", value: safeguard.badges.map((badge) => humanBadgeLabel(badge)).join(" · ") }]
              : []),
          ]}
        />
      ))}
      {model.scope.safeguards.some((entry) => entry.configurationHref) && (
        <div role="listitem">
          <Link
            to="/integrations"
            className="block rounded-sm px-4 py-3 text-xs font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-sky-300"
          >
            Change auth and integration settings →
          </Link>
        </div>
      )}
    </CapabilitySurface>
  );
}

export function formatMemorySurfaceCapabilities(
  augment: Pick<AugmentSummary, "hasContext" | "usesSharedMemoryTools">,
): string | undefined {
  const capabilities = [
    augment.hasContext ? "Context contribution" : undefined,
    augment.usesSharedMemoryTools ? "Shared memory tools" : undefined,
  ].filter((capability): capability is string => capability !== undefined);
  return capabilities.length > 0 ? capabilities.join(" · ") : undefined;
}

function shouldShowConversation(augment?: AugmentSummary): boolean {
  if (!augment) return true;
  return augment.type === "webTransport" || augment.name === "web";
}

function healthFor(surfaceId: string, findings: readonly CapabilityFinding[]): CapabilityHealth {
  const relevant = findings.filter((finding) => finding.surfaceId === surfaceId);
  if (relevant.some((finding) => finding.severity === "error")) return "error";
  if (relevant.some((finding) => finding.severity === "warning")) return "attention";
  return "ready";
}

function skillHealth(skill: SkillCapabilityView): CapabilityHealth {
  if (skill.frontmatterValid === false) return "attention";
  return skill.state === "installed" ? "ready" : "neutral";
}

function routeAccessSummary(route: RouteCapabilityView): string {
  const audience = (() => {
    switch (route.auth) {
    case "none": return "Public";
    case "visitor.optional": return "Public · visitor-aware";
    case "visitor.required": return "Verified visitors";
    case "agent.required": return "Configured agents";
    case "creator":
    case "bearer": return "Creator only";
    }
  })();
  return route.hasDelegatedRequirements ? `${audience} · delegated authorization` : audience;
}

function toolAccessSummary(tool: ToolCapabilityView): string {
  const hidden = new Set(tool.safeguards.hiddenFromTrustLevels);
  if (tool.safeguards.globallyHidden) return "Not exposed";
  const audience = hidden.has("public") && hidden.has("agent")
    ? "Creator only"
    : hidden.has("public")
      ? "Creator and agents"
      : hidden.has("agent")
        ? "Creator and visitors"
        : "All identities";
  return tool.hasDelegatedRequirements ? `${audience} · delegated authorization` : audience;
}

function toolAccessDetail(tool: ToolCapabilityView): string {
  if (tool.safeguards.globallyHidden) return "Hidden from every trust level";
  if (tool.safeguards.hiddenFromTrustLevels.length === 0) return "No trust-level visibility restrictions";
  return `Hidden from ${tool.safeguards.hiddenFromTrustLevels.join(" and ")}`;
}

function toolApprovalDetail(tool: ToolCapabilityView): string {
  if (tool.safeguards.requiresHumanApproval) return "Human approval always required";
  if (tool.safeguards.approvalRequiredForTrustLevels.length > 0) {
    return `Required for ${tool.safeguards.approvalRequiredForTrustLevels.join(" and ")}`;
  }
  return "Not required";
}

function toolInputSummary(tool: ToolCapabilityView): string {
  return badgeValue(tool.badges, "input-schema") === "input schema"
    ? "Structured object · schema defined"
    : "Schema not defined";
}

function toolLimitFields(badges: readonly CapabilityBadge[]): CapabilityField[] {
  const limits = badges
    .filter((badge) => badge.kind === "call-limit" || badge.kind === "timeout")
    .map((badge) => humanBadgeLabel(badge));
  return limits.length > 0 ? [{ label: "Limits", value: limits.join(" · ") }] : [];
}

function toolDetailFields(badges: readonly CapabilityBadge[]): CapabilityField[] {
  return badges
    .filter((badge) => badge.kind === "call-limit" || badge.kind === "timeout" || badge.kind === "delegated-auth")
    .map((badge) => ({ label: detailLabel(badge.kind), value: humanBadgeLabel(badge) }));
}

function routeDetailFields(badges: readonly CapabilityBadge[]): CapabilityField[] {
  return badges
    .filter((badge) => ["rate-limit", "body-limit", "timeout", "policy", "webhook-safeguard"].includes(badge.kind))
    .map((badge) => ({ label: detailLabel(badge.kind), value: humanBadgeLabel(badge) }));
}

function routeLimits(badges: readonly CapabilityBadge[]): string | undefined {
  const limits = badges
    .filter((badge) => badge.kind === "rate-limit" || badge.kind === "body-limit" || badge.kind === "timeout")
    .map((badge) => humanBadgeLabel(badge));
  return limits.length > 0 ? limits.join(" · ") : undefined;
}

function contractSummary(mediaTypes: readonly string[], schemaDefined: boolean): string {
  if (mediaTypes.length === 0 && !schemaDefined) return "No contract declared";
  if (mediaTypes.length === 0) return "Schema defined";
  const media = mediaTypesLabel(mediaTypes);
  const schema = schemaDefined ? "schema defined" : "no schema";
  return `${media} · ${schema}`;
}

function mediaTypesLabel(mediaTypes: readonly string[]): string {
  if (mediaTypes.length === 0) return "Not declared";
  return mediaTypes.map(humanMediaType).join(", ");
}

function humanMediaType(mediaType: string): string {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "application/json" || normalized?.endsWith("+json")) return "JSON";
  if (normalized === "application/x-www-form-urlencoded") return "Form encoded";
  if (normalized === "multipart/form-data") return "Multipart form";
  if (normalized?.startsWith("text/")) return normalized.slice(5).toUpperCase();
  return mediaType;
}

function badgeValue(badges: readonly CapabilityBadge[], kind: CapabilityBadge["kind"]): string | undefined {
  return badges.find((badge) => badge.kind === kind)?.label;
}

function safeguardStatus(kind: string): {
  health: CapabilityHealth;
  healthLabel: string;
} {
  if (kind === "web-auth-posture") return { health: "neutral", healthLabel: "Reported" };
  if (kind === "route-auth") return { health: "neutral", healthLabel: "Configured" };
  return { health: "ready", healthLabel: "Enforced" };
}

function humanBadgeLabel(badge: CapabilityBadge): string {
  if (badge.kind === "call-limit") return `${badge.label.replace("/turn", " calls/turn")}`;
  if (badge.kind === "rate-limit") return `${badge.label.replace("/min", " requests/min")}`;
  if (badge.kind === "body-limit") {
    const bytes = Number.parseInt(badge.label, 10);
    return Number.isFinite(bytes) ? `${formatBytes(bytes)} max body` : badge.label;
  }
  if (badge.kind === "timeout") return badge.label.replace("ms timeout", " ms timeout");
  if (badge.kind === "visibility-safeguard") {
    const levels = badge.label.replace("hidden: ", "");
    return levels === "public, agent" ? "Creator only" : `Hidden from ${levels}`;
  }
  return capitalize(badge.label);
}

function detailLabel(kind: CapabilityBadge["kind"]): string {
  switch (kind) {
    case "call-limit": return "Call limit";
    case "rate-limit": return "Rate limit";
    case "body-limit": return "Body limit";
    case "timeout": return "Timeout";
    case "delegated-auth": return "Authorization";
    case "policy":
    case "webhook-safeguard": return "Policy";
    default: return "Setting";
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

function memoryPolicy(augment: AugmentSummary): {
  mutable: boolean;
  origin: string;
  priority: string;
  placement: string;
  eviction: string;
  ttl: string;
  writeTrustLevels?: string[];
} {
  if (augment.memory) return augment.memory;
  if (augment.type === "fileMemory" && augment.name === "identity") {
    return { mutable: false, origin: "operator", priority: "required", placement: "system", eviction: "never", ttl: "persistent" };
  }
  return { mutable: true, origin: "operator", priority: "high", placement: "preamble", eviction: "drop", ttl: "persistent", writeTrustLevels: ["creator"] };
}

function memoryOwnership(augment: AugmentSummary): string {
  const ownership = augment.memory?.ownership;
  if (ownership?.kind === "namespace") return `${ownership.prefix} namespace`;
  if (ownership?.kind === "static") return `Static labels: ${ownership.labels.join(", ")}`;
  if (augment.name === "identity") return "Static label: self";
  if (augment.type === "fileMemory") return "Static label: learned";
  return "Not reported";
}

function writableBy(levels: readonly string[] | undefined): string {
  if (!levels || levels.length === 0) return "Writable";
  if (levels.length === 1 && levels[0] === "creator") return "Creator-writable";
  return `Writable by ${levels.join(" and ")}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
