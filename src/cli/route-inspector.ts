import { createLifecycleManager } from "../kernel/lifecycle-manager";
import { collectAugmentRoutes } from "../kernel/route-collector";
import {
  createRouteManifest,
  summarizeRouteManifest,
  type RouteManifestEntry,
  type RouteManifestSummary,
} from "../kernel/route-manifest";
import type { Augment } from "../types";
import { resolveAugments } from "./augment-resolver";
import type { AugmentConfig } from "./types";

export type RouteInspectionIssueKind = "load" | "boot" | "validation";

const ROUTE_BUILTIN_TYPES = new Set<AugmentConfig["type"]>(["visitorAuth"]);

export interface RouteInspectionIssue {
  kind: RouteInspectionIssueKind;
  message: string;
  augmentName?: string;
}

export interface RouteInspectionResult {
  manifest: readonly RouteManifestEntry[];
  summary: RouteManifestSummary;
  issues: readonly RouteInspectionIssue[];
}

export async function inspectAugmentRoutes(
  agentDir: string,
  configs: readonly AugmentConfig[],
): Promise<RouteInspectionResult> {
  const routeConfigs = configs.filter(isRouteInspectableConfig);
  if (routeConfigs.length === 0) return emptyInspection([]);

  let augments: Augment[];
  try {
    augments = await resolveAugments(cloneAugmentConfigs(routeConfigs), agentDir);
  } catch (err) {
    return emptyInspection([
      {
        kind: "load",
        message: `could not resolve augments for route inspection: ${(err as Error).message}`,
      },
    ]);
  }

  // Route inspection needs route-providing augments to see boot-time setup, but
  // it must not become a full runtime preflight. Avoid transports and unrelated
  // augments such as budgets whose boot side effects are not needed for routes.
  const bootAugments = augments.filter((augment, index) => {
    if (augment.transport) return false;
    if (augment.httpRoutes) return true;
    return routeConfigs[index]?.type === "custom";
  });
  const lifecycle = createLifecycleManager({ name: "route-inspection", augments: bootAugments });
  try {
    await lifecycle.boot();
    const collected = collectAugmentRoutes(augments);
    if (collected.errors.length > 0) {
      return emptyInspection(
        collected.errors.map((message) => ({
          kind: "validation",
          message,
        })),
      );
    }

    const manifest = createRouteManifest(collected.routes);
    return {
      manifest,
      summary: summarizeRouteManifest(manifest),
      issues: Object.freeze([]),
    };
  } catch (err) {
    return emptyInspection([
      {
        kind: "boot",
        message: `could not boot augments for route inspection: ${(err as Error).message}`,
      },
    ]);
  } finally {
    try {
      await lifecycle.shutdown();
    } catch (err) {
      console.warn(
        `[route-inspector] shutdown after route inspection failed: ${(err as Error).message}`,
      );
    }
  }
}

export function formatRouteManifestEntry(route: RouteManifestEntry): string {
  const params = route.params.length > 0 ? route.params.join(",") : "-";
  const rateLimit = route.rateLimit ? ` rate=${route.rateLimit.maxPerMinute}/min` : "";
  const policy =
    route.policy?.kind === "webhook.signature"
      ? ` policy=${route.policy.kind}:${route.policy.provider}`
      : "";
  return `${route.augmentName} ${route.security.toUpperCase()} auth=${route.auth} params=${params}${rateLimit}${policy}`;
}

function emptyInspection(issues: readonly RouteInspectionIssue[]): RouteInspectionResult {
  const manifest = Object.freeze([]) as readonly RouteManifestEntry[];
  return {
    manifest,
    summary: summarizeRouteManifest(manifest),
    issues: Object.freeze([...issues]),
  };
}

function isRouteInspectableConfig(config: AugmentConfig): boolean {
  return config.type === "custom" || ROUTE_BUILTIN_TYPES.has(config.type);
}

function cloneAugmentConfigs(configs: readonly AugmentConfig[]): AugmentConfig[] {
  return configs.map((config) => ({
    ...config,
    options: clonePlainObject(config.options),
  }));
}

function clonePlainObject<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}
