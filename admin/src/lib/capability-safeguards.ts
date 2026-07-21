import type {
  CapabilitySafeguardView,
  RouteCapabilityView,
  ToolCapabilityView,
} from "./capability-model-types";
import { badge, configuredAgentAccessEntries, routeAccessLabel } from "./capability-view-builders";
import type { DashboardData } from "./types";

export function buildSafeguards(
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
      detail: routeAccessLabel(route.auth, route.hasDelegatedRequirements),
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
  const owners: Array<string | undefined> =
    webOwners.length > 0 ? webOwners.map((augment) => augment.name) : [undefined];
  for (const augmentName of owners) {
    safeguards.push({
      id: `web-auth-posture:${augmentName ?? "global"}`,
      kind: "web-auth-posture",
      ...(augmentName ? { augmentName } : {}),
      title: "Web authentication posture",
      detail: webAuthPostureDetail(data),
      badges: [
        badge(
          "auth",
          reportedState(
            data.web.allowAnonymous.value,
            "anonymous chat",
            "chat auth required",
            "chat auth not reported",
          ),
          "neutral",
        ),
        badge(
          "auth",
          reportedState(
            data.web.visitorTokensEnabled,
            "visitor tokens",
            "visitor tokens off",
            "visitor tokens not reported",
          ),
          "neutral",
        ),
        badge(
          "auth",
          reportedState(
            data.web.externalAuthEnabled,
            "external auth",
            "external auth off",
            "external auth not reported",
          ),
          "neutral",
        ),
      ],
      configurationHref: "/integrations",
    });
  }
  return safeguards;
}

function webAuthPostureDetail(data: DashboardData): string {
  const chat = reportedState(
    data.web.allowAnonymous.value,
    "anonymous chat allowed",
    "chat authentication required",
    "chat authentication not reported",
  );
  const visitors = reportedState(
    data.web.visitorTokensEnabled,
    "visitor tokens enabled",
    "visitor tokens disabled",
    "visitor token state not reported",
  );
  const external = reportedState(
    data.web.externalAuthEnabled,
    "external auth enabled",
    "external auth disabled",
    "external auth state not reported",
  );
  const agents = data.web.agentAccessEntries === undefined
    ? "agent access not reported"
    : `${configuredAgentAccessEntries(data.web.agentAccessEntries)} agent access entries`;
  return `${chat}; ${visitors}; ${external}; ${agents}.`;
}

function reportedState(
  value: boolean | null,
  enabled: string,
  disabled: string,
  unknown: string,
): string {
  if (value === true) return enabled;
  if (value === false) return disabled;
  return unknown;
}
