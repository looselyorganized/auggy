import type { AugmentSummary, RouteManifestEntry, TrustLevel } from "./types";

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
  augmentNodes: AugmentCapabilityModel[];
  safeguards: CapabilitySafeguardView[];
  findings: CapabilityFinding[];
  issues: CapabilityFinding[];
  notes: CapabilityFinding[];
  scope: CapabilityScope;
}
