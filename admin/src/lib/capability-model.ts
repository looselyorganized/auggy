import type {
  AugmentSummary,
  DashboardData,
  RouteManifestEntry,
  ToolSummary,
  TrustLevel,
} from "./types";

export type CapabilityFindingSeverity = "error" | "warning" | "note";

export type CapabilityFindingCode =
  | "route.request-json-schema-missing"
  | "route.response-json-schema-missing"
  | "route.response-media-schema-conflict"
  | "route.visitor-identity-required-unavailable"
  | "route.visitor-identity-optional-unavailable"
  | "route.delegated-auth-unreachable"
  | "route.agent-access-unavailable"
  | "tool.input-json-schema-missing"
  | "tool.delegated-auth-unavailable"
  | "admin.status-warning"
  | "admin.status-error";

export type CapabilitySurfaceKind = "route" | "tool" | "admin-status";

export interface CapabilityFinding {
  id: string;
  code: CapabilityFindingCode;
  severity: CapabilityFindingSeverity;
  augmentName: string;
  surfaceKind: CapabilitySurfaceKind;
  surfaceId: string;
  surfaceLabel: string;
  message: string;
}

export type CapabilityBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type CapabilityBadgeKind =
  | "exposure"
  | "auth"
  | "request-schema"
  | "response-schema"
  | "request-media-type"
  | "response-media-type"
  | "rate-limit"
  | "policy"
  | "tool-category"
  | "input-schema"
  | "delegated-auth"
  | "visibility-safeguard"
  | "approval-safeguard"
  | "webhook-safeguard";

/**
 * Presentation-ready badge metadata. Consumers map `tone` to their component
 * variant instead of inferring meaning from the human-readable label.
 */
export interface CapabilityBadge {
  id: string;
  kind: CapabilityBadgeKind;
  label: string;
  tone: CapabilityBadgeTone;
}

export interface RouteCapabilityView {
  id: string;
  title: string;
  detail: string;
  route: RouteManifestEntry;
  badges: CapabilityBadge[];
  contract: {
    requestMediaTypes: readonly string[];
    responseMediaTypes: readonly string[];
    expectsJsonRequest: boolean;
    expectsJsonResponse: boolean;
    hasRequestBodySchema: boolean;
    hasResponseSchema: boolean;
  };
}

export interface ToolCapabilityView {
  id: string;
  title: string;
  detail: string;
  tool: ToolSummary;
  badges: CapabilityBadge[];
  safeguards: {
    globallyHidden: boolean;
    requiresHumanApproval: boolean;
    hiddenFromTrustLevels: readonly TrustLevel[];
    approvalRequiredForTrustLevels: readonly TrustLevel[];
  };
}

export interface CapabilitySurfaceSummary {
  routeCount: number;
  toolCount: number;
  memoryAugmentCount: number;
  /** Findings requiring action: errors plus warnings. */
  issueCount: number;
  noteCount: number;
}

export interface AugmentCapabilityModel {
  augment: AugmentSummary;
  summary: CapabilitySurfaceSummary;
  routes: RouteCapabilityView[];
  tools: ToolCapabilityView[];
  findings: CapabilityFinding[];
  issues: CapabilityFinding[];
  notes: CapabilityFinding[];
}

export interface CapabilityScope {
  selectedAugmentName: string | null;
  /** True when a requested augment no longer exists and selection fell back to All. */
  normalizedToAll: boolean;
  routes: RouteCapabilityView[];
  tools: ToolCapabilityView[];
  memoryAugments: AugmentSummary[];
  summary: CapabilitySurfaceSummary;
  findings: CapabilityFinding[];
  issues: CapabilityFinding[];
  notes: CapabilityFinding[];
}

export interface CapabilityModel {
  summary: CapabilitySurfaceSummary & { augmentCount: number };
  /** Always global so navigation does not disappear when the right pane is scoped. */
  augmentNodes: AugmentCapabilityModel[];
  findings: CapabilityFinding[];
  issues: CapabilityFinding[];
  notes: CapabilityFinding[];
  scope: CapabilityScope;
}

export function buildCapabilityModel(
  data: DashboardData,
  options: { selectedAugmentName?: string | null } = {},
): CapabilityModel {
  const identityAvailable =
    data.web.visitorTokensEnabled === true || data.web.externalAuthEnabled === true;
  const agentAccessAvailable = configuredAgentAccessEntries(data.web.agentAccessEntries) > 0;
  const routes = data.routes.entries.map((route) => buildRouteView(route, data));
  const tools = data.tools.entries.map(buildToolView);
  const findings: CapabilityFinding[] = [
    ...data.routes.entries.flatMap((route) =>
      routeFindings(route, {
        identityAvailable,
        externalAuthAvailable: data.web.externalAuthEnabled === true,
        agentAccessAvailable,
      }),
    ),
    ...data.tools.entries.flatMap((tool) =>
      toolFindings(tool, data.web.externalAuthEnabled === true),
    ),
    ...adminStatusFindings(data),
  ];

  const augmentNodes = data.augments.map((augment) => {
    const augmentRoutes = routes.filter((route) => route.route.augmentName === augment.name);
    const augmentTools = tools.filter((tool) => tool.tool.augmentName === augment.name);
    const augmentFindings = findings.filter((finding) => finding.augmentName === augment.name);
    const split = splitFindings(augmentFindings);
    return {
      augment,
      summary: summarize(
        augmentRoutes.length,
        augmentTools.length,
        hasMemorySurface(augment) ? 1 : 0,
        augmentFindings,
      ),
      routes: augmentRoutes,
      tools: augmentTools,
      findings: augmentFindings,
      ...split,
    };
  });

  const requestedAugmentName = options.selectedAugmentName ?? null;
  const selectedAugmentName = data.augments.some(
    (augment) => augment.name === requestedAugmentName,
  )
    ? requestedAugmentName
    : null;
  const normalizedToAll = requestedAugmentName !== null && selectedAugmentName === null;
  const scopedRoutes = selectedAugmentName
    ? routes.filter((route) => route.route.augmentName === selectedAugmentName)
    : routes;
  const scopedTools = selectedAugmentName
    ? tools.filter((tool) => tool.tool.augmentName === selectedAugmentName)
    : tools;
  const scopedMemoryAugments = data.augments.filter(
    (augment) => hasMemorySurface(augment) && (!selectedAugmentName || augment.name === selectedAugmentName),
  );
  const scopedFindings = selectedAugmentName
    ? findings.filter((finding) => finding.augmentName === selectedAugmentName)
    : findings;
  const globalSplit = splitFindings(findings);
  const scopedSplit = splitFindings(scopedFindings);

  return {
    summary: {
      augmentCount: data.augments.length,
      ...summarize(
        routes.length,
        tools.length,
        data.augments.filter(hasMemorySurface).length,
        findings,
      ),
    },
    augmentNodes,
    findings,
    ...globalSplit,
    scope: {
      selectedAugmentName,
      normalizedToAll,
      routes: scopedRoutes,
      tools: scopedTools,
      memoryAugments: scopedMemoryAugments,
      summary: summarize(
        scopedRoutes.length,
        scopedTools.length,
        scopedMemoryAugments.length,
        scopedFindings,
      ),
      findings: scopedFindings,
      ...scopedSplit,
    },
  };
}

function buildRouteView(route: RouteManifestEntry, data: DashboardData): RouteCapabilityView {
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
  const externalAuthAvailable = data.web.externalAuthEnabled === true;
  const agentAccessAvailable = configuredAgentAccessEntries(data.web.agentAccessEntries) > 0;
  const badges: CapabilityBadge[] = [
    badge("exposure", route.public ? "public" : "private", "neutral"),
    badge(
      "auth",
      route.auth,
      authTone(route, identityAvailable, externalAuthAvailable, agentAccessAvailable),
    ),
  ];

  if (route.requestJsonSchema) {
    badges.push(badge("request-schema", "request schema", "info"));
  } else if (expectsJsonRequest) {
    badges.push(badge("request-schema", "request schema missing", "info"));
  }
  if (hasResponseSchema) {
    badges.push(badge("response-schema", "response schema", "info"));
  } else if (expectsJsonResponse) {
    badges.push(badge("response-schema", "response schema missing", "info"));
  }
  for (const mediaType of requestMediaTypes) {
    badges.push(badge("request-media-type", mediaType, "neutral"));
  }
  for (const mediaType of responseMediaTypes) {
    badges.push(badge("response-media-type", mediaType, "neutral"));
  }
  if (route.rateLimit) {
    badges.push(badge("rate-limit", `${route.rateLimit.maxPerMinute}/min`, "info"));
  }
  if (route.policy) {
    const isWebhookSafeguard = route.policy.kind === "webhook.signature";
    badges.push(
      badge(
        isWebhookSafeguard ? "webhook-safeguard" : "policy",
        route.policy.kind,
        isWebhookSafeguard ? "success" : "neutral",
      ),
    );
  }

  return {
    id: routeId(route),
    title: routeLabel(route),
    detail: route.augmentName,
    route,
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

function buildToolView(tool: ToolSummary): ToolCapabilityView {
  const badges: CapabilityBadge[] = [badge("tool-category", tool.category, "neutral")];
  badges.push(
    badge(
      "input-schema",
      tool.hasInputSchema ? "input schema" : "input schema missing",
      tool.hasInputSchema ? "info" : "neutral",
    ),
  );
  if (tool.requires) {
    badges.push(badge("delegated-auth", "delegated auth", "info"));
  }
  if (tool.constraints.neverExpose || tool.constraints.hiddenFromTrustLevels.length > 0) {
    badges.push(badge("visibility-safeguard", "hidden", "success"));
  }
  if (
    tool.constraints.requiresHumanApproval ||
    tool.constraints.approvalRequiredForTrustLevels.length > 0
  ) {
    badges.push(badge("approval-safeguard", "approval", "success"));
  }

  return {
    id: toolId(tool),
    title: tool.name,
    detail: `${tool.augmentName} · ${tool.description}`,
    tool,
    badges,
    safeguards: {
      globallyHidden: tool.constraints.neverExpose,
      requiresHumanApproval: tool.constraints.requiresHumanApproval,
      hiddenFromTrustLevels: tool.constraints.hiddenFromTrustLevels,
      approvalRequiredForTrustLevels: tool.constraints.approvalRequiredForTrustLevels,
    },
  };
}

function routeFindings(
  route: RouteManifestEntry,
  posture: {
    identityAvailable: boolean;
    externalAuthAvailable: boolean;
    agentAccessAvailable: boolean;
  },
): CapabilityFinding[] {
  const findings: CapabilityFinding[] = [];
  const surfaceId = routeId(route);
  const surfaceLabel = routeLabel(route);
  const add = (
    code: CapabilityFindingCode,
    severity: CapabilityFindingSeverity,
    message: string,
  ) => {
    findings.push({
      id: `${code}:${surfaceId}`,
      code,
      severity,
      augmentName: route.augmentName,
      surfaceKind: "route",
      surfaceId,
      surfaceLabel,
      message,
    });
  };

  if (includesJsonMediaType(route.requestMediaTypes ?? []) && !route.requestJsonSchema?.body) {
    add(
      "route.request-json-schema-missing",
      "note",
      "Route declares a JSON request body without a request body schema.",
    );
  }
  if (includesJsonMediaType(route.responseMediaTypes ?? []) && !route.responseJsonSchema) {
    add(
      "route.response-json-schema-missing",
      "note",
      "Route declares a JSON success response without a response schema.",
    );
  }
  if (
    route.responseJsonSchema &&
    route.responseMediaTypes !== undefined &&
    !includesJsonMediaType(route.responseMediaTypes)
  ) {
    add(
      "route.response-media-schema-conflict",
      "warning",
      "Route declares a JSON response schema but only non-JSON response media types.",
    );
  }
  if (route.auth === "visitor.required" && !posture.identityAvailable) {
    add(
      "route.visitor-identity-required-unavailable",
      "error",
      "Visitor identity is required, but neither visitor tokens nor external auth is enabled.",
    );
  }
  if (route.auth === "visitor.optional" && !posture.identityAvailable) {
    add(
      "route.visitor-identity-optional-unavailable",
      "note",
      "This route remains available anonymously, but no visitor identity mechanism is enabled.",
    );
  }
  if (route.auth === "agent.required" && !posture.agentAccessAvailable) {
    add(
      "route.agent-access-unavailable",
      "error",
      "Agent access is required, but no agent access entries are configured.",
    );
  }
  if (route.requires) {
    const supportsDelegatedAuth =
      (route.auth === "visitor.required" || route.auth === "visitor.optional") &&
      posture.externalAuthAvailable;
    if (!supportsDelegatedAuth) {
      add(
        "route.delegated-auth-unreachable",
        "error",
        route.auth === "visitor.required" || route.auth === "visitor.optional"
          ? "Delegated authorization is required, but external auth is disabled. Visitor tokens do not carry delegated claims."
          : `Delegated authorization requirements cannot be satisfied by ${route.auth} route auth.`,
      );
    }
  }

  return findings;
}

function toolFindings(tool: ToolSummary, externalAuthAvailable: boolean): CapabilityFinding[] {
  const findings: CapabilityFinding[] = [];
  if (!tool.hasInputSchema) {
    findings.push({
      id: `tool.input-json-schema-missing:${toolId(tool)}`,
      code: "tool.input-json-schema-missing",
      severity: "note",
      augmentName: tool.augmentName,
      surfaceKind: "tool",
      surfaceId: toolId(tool),
      surfaceLabel: tool.name,
      message: "Tool has no JSON input schema for operator inspection.",
    });
  }
  if (tool.requires && !externalAuthAvailable) {
    findings.push({
      id: `tool.delegated-auth-unavailable:${toolId(tool)}`,
      code: "tool.delegated-auth-unavailable",
      severity: "warning",
      augmentName: tool.augmentName,
      surfaceKind: "tool",
      surfaceId: toolId(tool),
      surfaceLabel: tool.name,
      message:
        "Tool requires delegated authorization while external auth is disabled. A custom transport may still provide claims.",
    });
  }
  return findings;
}

function adminStatusFindings(data: DashboardData): CapabilityFinding[] {
  return data.blocks.flatMap((block, blockIndex) =>
    block.sections.flatMap((section, sectionIndex): CapabilityFinding[] => {
      if (section.kind !== "status" || section.level === "ok") return [];
      const severity = section.level === "error" ? "error" : "warning";
      const surfaceId = `${block.augmentName}:${blockIndex}:${sectionIndex}`;
      return [
        {
          id: `admin.status-${section.level}:${surfaceId}`,
          code: section.level === "error" ? "admin.status-error" : "admin.status-warning",
          severity,
          augmentName: block.augmentName,
          surfaceKind: "admin-status",
          surfaceId,
          surfaceLabel: block.title,
          message: section.message,
        },
      ];
    }),
  );
}

function summarize(
  routeCount: number,
  toolCount: number,
  memoryAugmentCount: number,
  findings: readonly CapabilityFinding[],
): CapabilitySurfaceSummary {
  return {
    routeCount,
    toolCount,
    memoryAugmentCount,
    issueCount: findings.filter(
      (finding) => finding.severity === "error" || finding.severity === "warning",
    ).length,
    noteCount: findings.filter((finding) => finding.severity === "note").length,
  };
}

function splitFindings(findings: readonly CapabilityFinding[]): {
  issues: CapabilityFinding[];
  notes: CapabilityFinding[];
} {
  return {
    issues: findings.filter(
      (finding) => finding.severity === "error" || finding.severity === "warning",
    ),
    notes: findings.filter((finding) => finding.severity === "note"),
  };
}

function badge(
  kind: CapabilityBadgeKind,
  label: string,
  tone: CapabilityBadgeTone,
): CapabilityBadge {
  return { id: `${kind}:${label}`, kind, label, tone };
}

function authTone(
  route: RouteManifestEntry,
  identityAvailable: boolean,
  externalAuthAvailable: boolean,
  agentAccessAvailable: boolean,
): CapabilityBadgeTone {
  if (route.requires) {
    const delegatedAuthReachable =
      (route.auth === "visitor.required" || route.auth === "visitor.optional") &&
      externalAuthAvailable;
    if (!delegatedAuthReachable) return "danger";
  }
  if (route.auth === "visitor.required" && !identityAvailable) return "danger";
  if (route.auth === "agent.required" && !agentAccessAvailable) return "danger";
  if (route.auth === "visitor.optional" && !identityAvailable) return "neutral";
  return route.auth === "none" ? "neutral" : "success";
}

function hasMemorySurface(augment: AugmentSummary): boolean {
  return augment.isMemoryProvider || augment.usesSharedMemoryTools;
}

function includesJsonMediaType(mediaTypes: readonly string[]): boolean {
  return mediaTypes.some((mediaType) => {
    const subtype = mediaType.toLowerCase().split("/", 2)[1];
    return subtype === "json" || subtype?.endsWith("+json") === true;
  });
}

function configuredAgentAccessEntries(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return 0;
  return Number(value);
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
