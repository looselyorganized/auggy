import type {
  AugmentSummary,
  DashboardData,
  InstalledSkillInfo,
  RouteManifestEntry,
  ToolSummary,
  TrustLevel,
} from "./types";

export type CapabilityFindingSeverity = "error" | "warning" | "note";

export type CapabilityFindingCode =
  | "route.request-json-schema-missing"
  | "route.response-json-schema-missing"
  | "route.response-media-schema-conflict"
  | "route.exposure-metadata-conflict"
  | "route.visitor-identity-required-unavailable"
  | "route.visitor-identity-optional-unavailable"
  | "route.delegated-auth-unreachable"
  | "route.agent-access-unavailable"
  | "tool.input-json-schema-missing"
  | "tool.delegated-auth-unavailable"
  | "skill.frontmatter-invalid"
  | "skill.available-not-installed"
  | "admin.status-warning"
  | "admin.status-error";

export type CapabilitySurfaceKind = "route" | "tool" | "skill" | "admin-status";

export interface CapabilityFinding {
  id: string;
  code: CapabilityFindingCode;
  severity: CapabilityFindingSeverity;
  augmentName?: string;
  augmentType?: string;
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
  | "webhook-safeguard"
  | "call-limit"
  | "body-limit"
  | "timeout"
  | "skill-state"
  | "skill-source"
  | "control";

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
  augmentName: string;
  auth: RouteManifestEntry["auth"];
  hasDelegatedRequirements: boolean;
  webhookSignatureProtected: boolean;
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
  augmentName: string;
  augmentType: string;
  hasDelegatedRequirements: boolean;
  badges: CapabilityBadge[];
  safeguards: {
    globallyHidden: boolean;
    requiresHumanApproval: boolean;
    hiddenFromTrustLevels: readonly TrustLevel[];
    approvalRequiredForTrustLevels: readonly TrustLevel[];
  };
}

export interface SkillCapabilityView {
  id: string;
  title: string;
  detail: string;
  state: "installed" | "available";
  folder: string;
  frontmatterValid?: boolean;
  augmentType?: string;
  badges: CapabilityBadge[];
}

export type CapabilitySafeguardKind =
  | "route-auth"
  | "route-requirements"
  | "webhook-signature"
  | "tool-visibility"
  | "tool-approval"
  | "turn-gate"
  | "web-auth-posture";

export interface CapabilitySafeguardView {
  id: string;
  kind: CapabilitySafeguardKind;
  augmentName?: string;
  title: string;
  detail: string;
  badges: CapabilityBadge[];
  configurationHref?: "/integrations";
}

export interface CapabilitySurfaceSummary {
  routeCount: number;
  toolCount: number;
  skillCount: number;
  memoryAugmentCount: number;
  /** Findings requiring action: errors plus warnings. */
  issueCount: number;
  errorCount: number;
  warningCount: number;
  noteCount: number;
}

export interface AugmentCapabilityModel {
  augment: AugmentSummary;
  summary: CapabilitySurfaceSummary;
  routes: RouteCapabilityView[];
  tools: ToolCapabilityView[];
  skills: SkillCapabilityView[];
  safeguards: CapabilitySafeguardView[];
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
  skills: SkillCapabilityView[];
  safeguards: CapabilitySafeguardView[];
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
  safeguards: CapabilitySafeguardView[];
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
  const skills = buildSkillViews(data);
  const safeguards = buildSafeguards(data, routes, tools);
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
    ...skillFindings(data, skills),
    ...adminStatusFindings(data),
  ];

  const augmentNodes = data.augments.map((augment) => {
    const augmentRoutes = routes.filter((route) => route.augmentName === augment.name);
    const augmentTools = tools.filter((tool) => tool.augmentName === augment.name);
    const augmentSkills = skills.filter((skill) => skill.augmentType === augment.type);
    const augmentSafeguards = safeguards.filter(
      (safeguard) => safeguard.augmentName === augment.name,
    );
    const augmentFindings = findings.filter(
      (finding) =>
        finding.augmentName === augment.name || finding.augmentType === augment.type,
    );
    const split = splitFindings(augmentFindings);
    return {
      augment,
      summary: summarize(
        augmentRoutes.length,
        augmentTools.length,
        installedSkillCount(augmentSkills),
        hasMemorySurface(augment) ? 1 : 0,
        augmentFindings,
      ),
      routes: augmentRoutes,
      tools: augmentTools,
      skills: augmentSkills,
      safeguards: augmentSafeguards,
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
    ? routes.filter((route) => route.augmentName === selectedAugmentName)
    : routes;
  const scopedTools = selectedAugmentName
    ? tools.filter((tool) => tool.augmentName === selectedAugmentName)
    : tools;
  const selectedAugmentType = selectedAugmentName
    ? data.augments.find((augment) => augment.name === selectedAugmentName)?.type
    : undefined;
  const scopedSkills = selectedAugmentName
    ? skills.filter((skill) => skill.augmentType === selectedAugmentType)
    : skills;
  const scopedSafeguards = selectedAugmentName
    ? safeguards.filter((safeguard) => safeguard.augmentName === selectedAugmentName)
    : safeguards;
  const scopedMemoryAugments = data.augments.filter(
    (augment) => hasMemorySurface(augment) && (!selectedAugmentName || augment.name === selectedAugmentName),
  );
  const scopedFindings = selectedAugmentName
    ? findings.filter(
        (finding) =>
          finding.augmentName === selectedAugmentName ||
          finding.augmentType === selectedAugmentType,
      )
    : findings;
  const globalSplit = splitFindings(findings);
  const scopedSplit = splitFindings(scopedFindings);

  return {
    summary: {
      augmentCount: data.augments.length,
      ...summarize(
        routes.length,
        tools.length,
        installedSkillCount(skills),
        data.augments.filter(hasMemorySurface).length,
        findings,
      ),
    },
    augmentNodes,
    safeguards,
    findings,
    ...globalSplit,
    scope: {
      selectedAugmentName,
      normalizedToAll,
      routes: scopedRoutes,
      tools: scopedTools,
      skills: scopedSkills,
      safeguards: scopedSafeguards,
      memoryAugments: scopedMemoryAugments,
      summary: summarize(
        scopedRoutes.length,
        scopedTools.length,
        installedSkillCount(scopedSkills),
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
  const publiclyReachable = isPubliclyReachable(route);
  const badges: CapabilityBadge[] = [
    badge(
      "exposure",
      publiclyReachable ? "publicly reachable" : "private route",
      "neutral",
    ),
    badge(
      "auth",
      routeAuthLabel(route.auth),
      authTone(route, identityAvailable, externalAuthAvailable, agentAccessAvailable),
    ),
  ];

  if (hasRequestBodySchema) {
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
    badges.push(badge("request-media-type", `accepts ${mediaType}`, "neutral"));
  }
  for (const mediaType of responseMediaTypes) {
    badges.push(badge("response-media-type", `returns ${mediaType}`, "neutral"));
  }
  if (route.rateLimit) {
    badges.push(badge("rate-limit", `${route.rateLimit.maxPerMinute}/min`, "info"));
  }
  if (route.timeoutMs !== undefined) {
    badges.push(badge("timeout", `${route.timeoutMs}ms timeout`, "neutral"));
  }
  if (route.maxBodyBytes !== undefined) {
    badges.push(badge("body-limit", `${route.maxBodyBytes} byte body limit`, "neutral"));
  }
  if (route.policy) {
    const isWebhookSafeguard = route.policy.kind === "webhook.signature";
    badges.push(
      badge(
        isWebhookSafeguard ? "webhook-safeguard" : "policy",
        isWebhookSafeguard ? "signature policy" : route.policy.kind,
        isWebhookSafeguard ? "info" : "neutral",
      ),
    );
  }

  return {
    id: routeId(route),
    title: routeLabel(route),
    detail: routeAccessLabel(route.auth),
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
    badges.push(
      badge("call-limit", `${tool.constraints.maxToolCallsPerTurn}/turn`, "neutral"),
    );
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

function buildSkillViews(data: DashboardData): SkillCapabilityView[] {
  const installed = data.skills.installed.map((skill): SkillCapabilityView => {
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
  });
  const available = data.skills.available.map(
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
  );
  return [...installed, ...available];
}

function skillFindings(
  data: DashboardData,
  skills: readonly SkillCapabilityView[],
): CapabilityFinding[] {
  return skills.flatMap((skill): CapabilityFinding[] => {
    const code: CapabilityFindingCode | undefined =
      skill.state === "available"
        ? "skill.available-not-installed"
        : skill.frontmatterValid === false
          ? "skill.frontmatter-invalid"
          : undefined;
    if (!code) return [];
    const mountedOwnerType = skill.augmentType
      ? data.augments.some((augment) => augment.type === skill.augmentType)
        ? skill.augmentType
        : undefined
      : undefined;
    return [{
      id: `${code}:${skill.id}`,
      code,
      severity: "note",
      ...(mountedOwnerType ? { augmentType: mountedOwnerType } : {}),
      surfaceKind: "skill",
      surfaceId: skill.id,
      surfaceLabel: skill.title,
      message:
        code === "skill.frontmatter-invalid"
          ? "Installed skill frontmatter is invalid and may prevent reliable discovery."
          : "A bundled skill is available but has not been installed for this agent.",
    }];
  });
}

function installedSkillOwner(skill: InstalledSkillInfo): string | undefined {
  return skill.fromAugmentType && skill.fromAugmentType.length > 0
    ? skill.fromAugmentType
    : undefined;
}

function buildSafeguards(
  data: DashboardData,
  routes: readonly RouteCapabilityView[],
  tools: readonly ToolCapabilityView[],
): CapabilitySafeguardView[] {
  const safeguards: CapabilitySafeguardView[] = [];
  for (const route of routes) {
    const authBadge = route.badges.find((entry) => entry.kind === "auth");
    safeguards.push({
      id: `route-auth:${route.id}`,
      kind: "route-auth",
      augmentName: route.augmentName,
      title: route.title,
      detail: routeAccessLabel(route.auth),
      badges: authBadge ? [authBadge] : [],
    });
    if (route.hasDelegatedRequirements) {
      safeguards.push({
        id: `route-requirements:${route.id}`,
        kind: "route-requirements",
        augmentName: route.augmentName,
        title: route.title,
        detail: "Delegated authorization requirements are enforced for this route.",
        badges: [badge("delegated-auth", "delegated auth required", "info")],
      });
    }
    if (route.webhookSignatureProtected) {
      safeguards.push({
        id: `webhook-signature:${route.id}`,
        kind: "webhook-signature",
        augmentName: route.augmentName,
        title: route.title,
        detail: "A webhook signature policy is configured for this route.",
        badges: [badge("webhook-safeguard", "signature policy", "info")],
      });
    }
  }

  for (const tool of tools) {
    if (tool.safeguards.globallyHidden || tool.safeguards.hiddenFromTrustLevels.length > 0) {
      safeguards.push({
        id: `tool-visibility:${tool.id}`,
        kind: "tool-visibility",
        augmentName: tool.augmentName,
        title: tool.title,
        detail: tool.safeguards.globallyHidden
          ? "Tool is hidden from every trust level."
          : `Tool is hidden from ${tool.safeguards.hiddenFromTrustLevels.join(", ")}.`,
        badges: tool.badges.filter((entry) => entry.kind === "visibility-safeguard"),
      });
    }
    if (
      tool.safeguards.requiresHumanApproval ||
      tool.safeguards.approvalRequiredForTrustLevels.length > 0
    ) {
      safeguards.push({
        id: `tool-approval:${tool.id}`,
        kind: "tool-approval",
        augmentName: tool.augmentName,
        title: tool.title,
        detail: tool.safeguards.requiresHumanApproval
          ? "Human approval is always required before execution."
          : `Human approval is required for ${tool.safeguards.approvalRequiredForTrustLevels.join(", ")}.`,
        badges: tool.badges.filter((entry) => entry.kind === "approval-safeguard"),
      });
    }
  }

  for (const augment of data.augments) {
    if (augment.hasTurnGate) {
      safeguards.push({
        id: `turn-gate:${augment.name}`,
        kind: "turn-gate",
        augmentName: augment.name,
        title: "Turn gate",
        detail: "A turn gate is registered before model execution.",
        badges: [badge("control", "turn gate registered", "info")],
      });
    }
  }

  const webOwners = data.augments.filter(
    (augment) => augment.type === "webTransport" || augment.name === "web",
  );
  const postureOwners: Array<string | undefined> =
    webOwners.length > 0 ? webOwners.map((augment) => augment.name) : [undefined];
  for (const augmentName of postureOwners) {
    safeguards.push({
      id: `web-auth-posture:${augmentName ?? "global"}`,
      kind: "web-auth-posture",
      ...(augmentName ? { augmentName } : {}),
      title: "Web authentication posture",
      detail: webAuthPostureDetail(data),
      badges: [
        badge(
          "auth",
          data.web.allowAnonymous.value === true ? "anonymous chat" : "creator chat",
          "neutral",
        ),
        badge(
          "auth",
          data.web.visitorTokensEnabled === true ? "visitor tokens" : "visitor tokens off",
          "neutral",
        ),
        badge(
          "auth",
          data.web.externalAuthEnabled === true ? "external auth" : "external auth off",
          "neutral",
        ),
      ],
      configurationHref: "/integrations",
    });
  }
  return safeguards;
}

function routeAccessLabel(auth: RouteManifestEntry["auth"]): string {
  switch (auth) {
    case "none":
      return "Public access without identity.";
    case "visitor.optional":
      return "Anonymous access with optional visitor identity.";
    case "visitor.required":
      return "Verified visitor identity required.";
    case "agent.required":
      return "Configured agent credentials required.";
    case "creator":
    case "bearer":
      return "Creator credentials required.";
  }
}

function routeAuthLabel(auth: RouteManifestEntry["auth"]): string {
  switch (auth) {
    case "none":
      return "no route auth";
    case "visitor.optional":
      return "visitor optional";
    case "visitor.required":
      return "visitor required";
    case "agent.required":
      return "agent required";
    case "creator":
    case "bearer":
      return "creator";
  }
}

function webAuthPostureDetail(data: DashboardData): string {
  const chat = data.web.allowAnonymous.value === true ? "anonymous chat allowed" : "creator-only chat";
  const visitors =
    data.web.visitorTokensEnabled === true ? "visitor tokens enabled" : "visitor tokens disabled";
  const external =
    data.web.externalAuthEnabled === true ? "external auth enabled" : "external auth disabled";
  const agents = `${configuredAgentAccessEntries(data.web.agentAccessEntries)} agent access entries`;
  return `${chat}; ${visitors}; ${external}; ${agents}.`;
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
  if (route.public !== isPubliclyReachable(route)) {
    add(
      "route.exposure-metadata-conflict",
      "warning",
      "Route exposure metadata disagrees with its authentication mode.",
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
  if (tool.constraints.neverExpose) return [];
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
  skillCount: number,
  memoryAugmentCount: number,
  findings: readonly CapabilityFinding[],
): CapabilitySurfaceSummary {
  return {
    routeCount,
    toolCount,
    skillCount,
    memoryAugmentCount,
    issueCount: findings.filter(
      (finding) => finding.severity === "error" || finding.severity === "warning",
    ).length,
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
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
  if (route.auth === "visitor.optional") return identityAvailable ? "info" : "neutral";
  return route.auth === "none" ? "neutral" : "success";
}

function hasMemorySurface(augment: AugmentSummary): boolean {
  return augment.isMemoryProvider || augment.usesSharedMemoryTools;
}

function installedSkillCount(skills: readonly SkillCapabilityView[]): number {
  return skills.filter((skill) => skill.state === "installed").length;
}

function includesJsonMediaType(mediaTypes: readonly string[]): boolean {
  return mediaTypes.some((mediaType) => {
    const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const subtype = normalized.split("/", 2)[1];
    return subtype === "json" || subtype?.endsWith("+json") === true;
  });
}

function isPubliclyReachable(route: RouteManifestEntry): boolean {
  return route.auth === "none" || route.auth === "visitor.optional";
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
