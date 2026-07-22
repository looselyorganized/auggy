import { buildFindings } from "./capability-findings";
import type {
  CapabilityFinding,
  CapabilityModel,
  CapabilitySurfaceSummary,
} from "./capability-model-types";
import { buildSafeguards } from "./capability-safeguards";
import {
  buildRouteView,
  buildSkillViews,
  buildToolView,
  hasMemorySurface,
  installedSkillCount,
} from "./capability-view-builders";
import type { DashboardData } from "./types";

export type {
  AugmentCapabilityModel,
  CapabilityBadge,
  CapabilityBadgeKind,
  CapabilityBadgeTone,
  CapabilityFinding,
  CapabilityFindingCode,
  CapabilityFindingSeverity,
  CapabilityModel,
  CapabilitySafeguardKind,
  CapabilitySafeguardView,
  CapabilityScope,
  CapabilitySurfaceKind,
  CapabilitySurfaceSummary,
  RouteCapabilityView,
  SkillCapabilityView,
  ToolCapabilityView,
} from "./capability-model-types";

export function buildCapabilityModel(
  data: DashboardData,
  options: { selectedAugmentName?: string | null } = {},
): CapabilityModel {
  const routes = data.routes.entries.map((route) => buildRouteView(route, data));
  const tools = data.tools.entries.map(buildToolView);
  const skills = buildSkillViews(data);
  const safeguards = buildSafeguards(data, routes, tools);
  const findings = buildFindings(data, skills);

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
      ...splitFindings(augmentFindings),
    };
  });

  const requestedAugmentName = options.selectedAugmentName ?? null;
  const selectedAugment = data.augments.find(
    (augment) => augment.name === requestedAugmentName,
  );
  const selectedAugmentName = selectedAugment?.name ?? null;
  const scopedRoutes = selectedAugmentName
    ? routes.filter((route) => route.augmentName === selectedAugmentName)
    : routes;
  const scopedTools = selectedAugmentName
    ? tools.filter((tool) => tool.augmentName === selectedAugmentName)
    : tools;
  const scopedSkills = selectedAugmentName
    ? skills.filter((skill) => skill.augmentType === selectedAugment?.type)
    : skills;
  const scopedSafeguards = selectedAugmentName
    ? safeguards.filter((safeguard) => safeguard.augmentName === selectedAugmentName)
    : safeguards;
  const scopedMemoryAugments = data.augments.filter(
    (augment) =>
      hasMemorySurface(augment) && (!selectedAugmentName || augment.name === selectedAugmentName),
  );
  const scopedFindings = selectedAugmentName
    ? findings.filter(
        (finding) =>
          finding.augmentName === selectedAugmentName ||
          finding.augmentType === selectedAugment?.type,
      )
    : findings;

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
    ...splitFindings(findings),
    scope: {
      selectedAugmentName,
      normalizedToAll: requestedAugmentName !== null && selectedAugmentName === null,
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
      ...splitFindings(scopedFindings),
    },
  };
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
