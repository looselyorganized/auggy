import type {
  CapabilityFinding,
  CapabilityFindingCode,
  CapabilityFindingSeverity,
  SkillCapabilityView,
} from "./capability-model-types";
import type { DashboardData, RouteManifestEntry, ToolSummary } from "./types";

export function buildFindings(
  data: DashboardData,
  skills: readonly SkillCapabilityView[],
): CapabilityFinding[] {
  const identityAvailable =
    data.web.visitorTokensEnabled === true || data.web.externalAuthEnabled === true;
  const identityUnavailable =
    data.web.visitorTokensEnabled === false && data.web.externalAuthEnabled === false;
  const agentAccessAvailable = configuredAgentAccessEntries(data.web.agentAccessEntries) > 0;
  const agentAccessUnavailable =
    data.web.agentAccessEntries !== undefined && !agentAccessAvailable;
  return [
    ...data.routes.entries.flatMap((route) =>
      routeFindings(route, {
        identityAvailable,
        identityUnavailable,
        externalAuth: data.web.externalAuthEnabled,
        agentAccessAvailable,
        agentAccessUnavailable,
      }),
    ),
    ...data.tools.entries.flatMap((tool) =>
      toolFindings(tool, data.web.externalAuthEnabled),
    ),
    ...skillFindings(data, skills),
    ...adminStatusFindings(data),
  ];
}

function routeFindings(
  route: RouteManifestEntry,
  posture: {
    identityAvailable: boolean;
    identityUnavailable: boolean;
    externalAuth: boolean | null;
    agentAccessAvailable: boolean;
    agentAccessUnavailable: boolean;
  },
): CapabilityFinding[] {
  const findings: CapabilityFinding[] = [];
  const surfaceId = `${route.augmentName}:${route.method}:${route.path}`;
  const surfaceLabel = `${route.method} ${route.path}`;
  const add = (
    code: CapabilityFindingCode,
    severity: CapabilityFindingSeverity,
    message: string,
  ) => findings.push({
    id: `${code}:${surfaceId}`,
    code,
    severity,
    augmentName: route.augmentName,
    surfaceKind: "route",
    surfaceId,
    surfaceLabel,
    message,
  });

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
  if (route.auth === "visitor.required" && posture.identityUnavailable) {
    add(
      "route.visitor-identity-required-unavailable",
      "error",
      "Visitor identity is required, but neither visitor tokens nor external auth is enabled.",
    );
  }
  if (route.auth === "visitor.optional" && posture.identityUnavailable) {
    add(
      "route.visitor-identity-optional-unavailable",
      "note",
      "This route remains available anonymously, but no visitor identity mechanism is enabled.",
    );
  }
  if (route.auth === "agent.required" && posture.agentAccessUnavailable) {
    add(
      "route.agent-access-unavailable",
      "error",
      "Agent access is required, but no agent access entries are configured.",
    );
  }
  if (route.requires) {
    const visitorRoute =
      route.auth === "visitor.required" || route.auth === "visitor.optional";
    const unsupported = visitorRoute
      ? posture.externalAuth === false
      : true;
    if (unsupported) {
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

function toolFindings(tool: ToolSummary, externalAuth: boolean | null): CapabilityFinding[] {
  if (tool.constraints.neverExpose) return [];
  const findings: CapabilityFinding[] = [];
  const surfaceId = `${tool.augmentName}:${tool.name}`;
  if (!tool.hasInputSchema) {
    findings.push({
      id: `tool.input-json-schema-missing:${surfaceId}`,
      code: "tool.input-json-schema-missing",
      severity: "note",
      augmentName: tool.augmentName,
      surfaceKind: "tool",
      surfaceId,
      surfaceLabel: tool.name,
      message: "Tool has no JSON input schema for operator inspection.",
    });
  }
  if (tool.requires && externalAuth === false) {
    findings.push({
      id: `tool.delegated-auth-unavailable:${surfaceId}`,
      code: "tool.delegated-auth-unavailable",
      severity: "warning",
      augmentName: tool.augmentName,
      surfaceKind: "tool",
      surfaceId,
      surfaceLabel: tool.name,
      message:
        "Tool requires delegated authorization while external auth is disabled. A custom transport may still provide claims.",
    });
  }
  return findings;
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
    const augmentType = skill.augmentType && data.augments.some((a) => a.type === skill.augmentType)
      ? skill.augmentType
      : undefined;
    return [{
      id: `${code}:${skill.id}`,
      code,
      severity: "note",
      ...(augmentType ? { augmentType } : {}),
      surfaceKind: "skill",
      surfaceId: skill.id,
      surfaceLabel: skill.title,
      message:
        code === "skill.frontmatter-invalid"
          ? "Installed skill frontmatter is invalid and may prevent reliable discovery."
          : "An Auggy-provided skill is available but has not been installed for this agent.",
    }];
  });
}

function adminStatusFindings(data: DashboardData): CapabilityFinding[] {
  return data.blocks.flatMap((block, blockIndex) =>
    block.sections.flatMap((section, sectionIndex): CapabilityFinding[] => {
      if (section.kind !== "status" || section.level === "ok") return [];
      const surfaceId = `${block.augmentName}:${blockIndex}:${sectionIndex}`;
      return [{
        id: `admin.status-${section.level}:${surfaceId}`,
        code: section.level === "error" ? "admin.status-error" : "admin.status-warning",
        severity: section.level === "error" ? "error" : "warning",
        augmentName: block.augmentName,
        surfaceKind: "admin-status",
        surfaceId,
        surfaceLabel: block.title,
        message:
          section.level === "error"
            ? "This augment reported an error in its operator status."
            : "This augment reported a warning in its operator status.",
      }];
    }),
  );
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
