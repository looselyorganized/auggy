import type {
  CapabilityBadge,
  CapabilityBadgeKind,
  CapabilityBadgeTone,
  RouteCapabilityView,
  SkillCapabilityView,
  ToolCapabilityView,
} from "./capability-model-types";
import type {
  AugmentSummary,
  DashboardData,
  InstalledSkillInfo,
  RouteManifestEntry,
  ToolSummary,
} from "./types";

export function buildRouteView(
  route: RouteManifestEntry,
  data: DashboardData,
): RouteCapabilityView {
  const requestMediaTypes =
    route.requestMediaTypes ?? (route.requestJsonSchema?.body ? ["application/json"] : []);
  const responseMediaTypes =
    route.responseMediaTypes ?? (route.responseJsonSchema ? ["application/json"] : []);
  const expectsJsonRequest = includesJsonMediaType(requestMediaTypes);
  const expectsJsonResponse = includesJsonMediaType(responseMediaTypes);
  const hasRequestBodySchema = route.requestJsonSchema?.body !== undefined;
  const hasResponseSchema = route.responseJsonSchema !== undefined;
  const identityAvailable =
    data.web.visitorTokensEnabled === true || data.web.externalAuthEnabled === true;
  const identityUnavailable =
    data.web.visitorTokensEnabled === false && data.web.externalAuthEnabled === false;
  const agentAccessAvailable = configuredAgentAccessEntries(data.web.agentAccessEntries) > 0;
  const agentAccessUnavailable =
    data.web.agentAccessEntries !== undefined && !agentAccessAvailable;
  const badges: CapabilityBadge[] = [
    badge(
      "exposure",
      isPubliclyReachable(route) && route.requires === undefined
        ? "publicly reachable"
        : route.requires
          ? "delegated access"
          : "private route",
      "neutral",
    ),
    badge(
      "auth",
      routeAuthLabel(route.auth),
      authTone(
        route,
        identityAvailable,
        identityUnavailable,
        data.web.externalAuthEnabled,
        agentAccessAvailable,
        agentAccessUnavailable,
      ),
    ),
  ];
  if (hasRequestBodySchema) badges.push(badge("request-schema", "request schema", "info"));
  else if (expectsJsonRequest) {
    badges.push(badge("request-schema", "request schema missing", "info"));
  }
  if (hasResponseSchema) badges.push(badge("response-schema", "response schema", "info"));
  else if (expectsJsonResponse) {
    badges.push(badge("response-schema", "response schema missing", "info"));
  }
  for (const mediaType of requestMediaTypes) {
    badges.push(badge("request-media-type", `accepts ${mediaType}`, "neutral"));
  }
  for (const mediaType of responseMediaTypes) {
    badges.push(badge("response-media-type", `returns ${mediaType}`, "neutral"));
  }
  if (route.rateLimit) badges.push(badge("rate-limit", `${route.rateLimit.maxPerMinute}/min`, "info"));
  if (route.timeoutMs !== undefined) {
    badges.push(badge("timeout", `${route.timeoutMs}ms timeout`, "neutral"));
  }
  if (route.maxBodyBytes !== undefined) {
    badges.push(badge("body-limit", `${route.maxBodyBytes} byte body limit`, "neutral"));
  }
  if (route.policy) {
    const signed = route.policy.kind === "webhook.signature";
    badges.push(
      badge(
        signed ? "webhook-safeguard" : "policy",
        signed ? "signature policy" : route.policy.kind,
        signed ? "info" : "neutral",
      ),
    );
  }
  return {
    id: routeId(route),
    title: routeLabel(route),
    detail: routeAccessLabel(route.auth, route.requires !== undefined),
    augmentName: route.augmentName,
    auth: route.auth,
    hasDelegatedRequirements: route.requires !== undefined,
    webhookSignatureProtected: route.policy?.kind === "webhook.signature",
    badges,
    contract: {
      requestMediaTypes,
      responseMediaTypes,
      expectsJsonRequest,
      expectsJsonResponse,
      hasRequestBodySchema,
      hasResponseSchema,
    },
  };
}

export function buildToolView(tool: ToolSummary): ToolCapabilityView {
  const badges: CapabilityBadge[] = [
    badge("tool-category", tool.category, "neutral"),
    badge(
      "input-schema",
      tool.hasInputSchema ? "input schema" : "input schema missing",
      tool.hasInputSchema ? "info" : "neutral",
    ),
  ];
  if (tool.requires) badges.push(badge("delegated-auth", "delegated auth", "info"));
  if (tool.constraints.neverExpose || tool.constraints.hiddenFromTrustLevels.length > 0) {
    badges.push(
      badge(
        "visibility-safeguard",
        tool.constraints.neverExpose
          ? "not exposed"
          : `hidden: ${tool.constraints.hiddenFromTrustLevels.join(", ")}`,
        "info",
      ),
    );
  }
  if (
    tool.constraints.requiresHumanApproval ||
    tool.constraints.approvalRequiredForTrustLevels.length > 0
  ) {
    badges.push(
      badge(
        "approval-safeguard",
        tool.constraints.requiresHumanApproval
          ? "approval required"
          : `approval: ${tool.constraints.approvalRequiredForTrustLevels.join(", ")}`,
        "info",
      ),
    );
  }
  if (tool.constraints.maxToolCallsPerTurn !== undefined) {
    badges.push(badge("call-limit", `${tool.constraints.maxToolCallsPerTurn}/turn`, "neutral"));
  }
  if (tool.constraints.toolTimeoutMs !== undefined) {
    badges.push(badge("timeout", `${tool.constraints.toolTimeoutMs}ms timeout`, "neutral"));
  }
  return {
    id: toolId(tool),
    title: tool.name,
    detail: tool.description,
    augmentName: tool.augmentName,
    augmentType: tool.augmentType,
    hasDelegatedRequirements: tool.requires !== undefined,
    badges,
    safeguards: {
      globallyHidden: tool.constraints.neverExpose,
      requiresHumanApproval: tool.constraints.requiresHumanApproval,
      hiddenFromTrustLevels: tool.constraints.hiddenFromTrustLevels,
      approvalRequiredForTrustLevels: tool.constraints.approvalRequiredForTrustLevels,
    },
  };
}

export function buildSkillViews(data: DashboardData): SkillCapabilityView[] {
  return [
    ...data.skills.installed.map((skill): SkillCapabilityView => {
      const augmentType = installedSkillOwner(skill);
      return {
        id: `installed:${skill.folder}`,
        title: skill.name ?? skill.folder,
        detail: `${skill.description ?? "Installed skill"} · skills/${skill.folder}/SKILL.md`,
        state: "installed",
        folder: skill.folder,
        frontmatterValid: skill.frontmatterValid,
        ...(augmentType ? { augmentType } : {}),
        badges: [
          badge("skill-state", "installed", skill.frontmatterValid ? "success" : "warning"),
          badge("skill-source", skill.source, "neutral"),
          ...(!skill.frontmatterValid
            ? [badge("control", "frontmatter invalid", "warning")]
            : []),
        ],
      };
    }),
    ...data.skills.available.map(
      (skill): SkillCapabilityView => ({
        id: `available:${skill.fromAugmentType}:${skill.folder}`,
        title: skill.name ?? skill.folder,
        detail: `${skill.description ?? "Bundled skill"} · available from ${skill.fromAugmentType}`,
        state: "available",
        folder: skill.folder,
        augmentType: skill.fromAugmentType,
        badges: [
          badge("skill-state", "available", "info"),
          badge("skill-source", "bundled", "neutral"),
        ],
      }),
    ),
  ];
}

export function badge(
  kind: CapabilityBadgeKind,
  label: string,
  tone: CapabilityBadgeTone,
): CapabilityBadge {
  return { id: `${kind}:${label}`, kind, label, tone };
}

export function hasMemorySurface(augment: AugmentSummary): boolean {
  return augment.isMemoryProvider || augment.usesSharedMemoryTools;
}

export function installedSkillCount(skills: readonly SkillCapabilityView[]): number {
  return skills.filter((skill) => skill.state === "installed").length;
}

export function configuredAgentAccessEntries(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 0;
  return Number(value);
}

export function routeAccessLabel(
  auth: RouteManifestEntry["auth"],
  hasDelegatedRequirements = false,
): string {
  if (hasDelegatedRequirements) {
    return auth === "visitor.required" || auth === "visitor.optional"
      ? "External identity with delegated authorization claims required."
      : `Delegated authorization requirements are incompatible with ${auth} route auth.`;
  }
  switch (auth) {
    case "none": return "Public access without identity.";
    case "visitor.optional": return "Anonymous access with optional visitor identity.";
    case "visitor.required": return "Verified visitor identity required.";
    case "agent.required": return "Configured agent credentials required.";
    case "creator":
    case "bearer": return "Creator credentials required.";
  }
}

function routeAuthLabel(auth: RouteManifestEntry["auth"]): string {
  switch (auth) {
    case "none": return "no route auth";
    case "visitor.optional": return "visitor optional";
    case "visitor.required": return "visitor required";
    case "agent.required": return "agent required";
    case "creator":
    case "bearer": return "creator";
  }
}

function authTone(
  route: RouteManifestEntry,
  identityAvailable: boolean,
  identityUnavailable: boolean,
  externalAuth: boolean | null,
  agentAccessAvailable: boolean,
  agentAccessUnavailable: boolean,
): CapabilityBadgeTone {
  if (route.requires) {
    const visitorRoute =
      route.auth === "visitor.required" || route.auth === "visitor.optional";
    if (!visitorRoute || externalAuth === false) return "danger";
    return externalAuth === true ? "info" : "neutral";
  }
  if (route.auth === "visitor.required") {
    if (identityAvailable) return "info";
    return identityUnavailable ? "danger" : "neutral";
  }
  if (route.auth === "agent.required") {
    if (agentAccessAvailable) return "info";
    return agentAccessUnavailable ? "danger" : "neutral";
  }
  if (route.auth === "visitor.optional") return identityAvailable ? "info" : "neutral";
  return route.auth === "none" ? "neutral" : "info";
}

function includesJsonMediaType(mediaTypes: readonly string[]): boolean {
  return mediaTypes.some((mediaType) => {
    const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const subtype = normalized.split("/", 2)[1];
    return subtype === "json" || subtype?.endsWith("+json") === true;
  });
}

function installedSkillOwner(skill: InstalledSkillInfo): string | undefined {
  return skill.fromAugmentType && skill.fromAugmentType.length > 0
    ? skill.fromAugmentType
    : undefined;
}

function isPubliclyReachable(route: RouteManifestEntry): boolean {
  return route.auth === "none" || route.auth === "visitor.optional";
}
function routeId(route: RouteManifestEntry): string {
  return `${route.augmentName}:${route.method}:${route.path}`;
}
function routeLabel(route: RouteManifestEntry): string {
  return `${route.method} ${route.path}`;
}
function toolId(tool: ToolSummary): string {
  return `${tool.augmentName}:${tool.name}`;
}
