import { resolve } from "node:path";
import { collectAugmentRoutes } from "../kernel/route-collector";
import {
  createRouteManifest,
  summarizeRouteManifest,
  type RouteManifestEntry,
  type RouteManifestSummary,
} from "../kernel/route-manifest";
import type { Augment } from "../types";
import type { AugmentConfig } from "./types";

export type RouteInspectionIssueKind = "load" | "validation";

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

export async function inspectCustomAugmentRoutes(
  agentDir: string,
  configs: readonly AugmentConfig[],
): Promise<RouteInspectionResult> {
  const augments: Augment[] = [];

  for (const config of configs) {
    if (config.type !== "custom") continue;

    try {
      const augment = await loadCustomAugment(agentDir, config);
      augments.push({ ...augment, name: config.name });
    } catch (err) {
      return emptyInspection([
        {
          kind: "load",
          augmentName: config.name,
          message: `could not inspect custom augment "${config.name}": ${(err as Error).message}`,
        },
      ]);
    }
  }

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
}

export function formatRouteManifestEntry(route: RouteManifestEntry): string {
  const params = route.params.length > 0 ? route.params.join(",") : "-";
  const rateLimit = route.rateLimit ? ` rate=${route.rateLimit.maxPerMinute}/min` : "";
  return `${route.augmentName} ${route.security.toUpperCase()} auth=${route.auth} params=${params}${rateLimit}`;
}

async function loadCustomAugment(agentDir: string, config: AugmentConfig): Promise<Augment> {
  if (!config.source) {
    throw new Error("source path is required");
  }

  const absPath = config.source.startsWith("/") ? config.source : resolve(agentDir, config.source);
  const mod = (await import(absPath)) as Record<string, unknown>;
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error(`"${absPath}" must have a default export function`);
  }

  return factory(config.options ?? {}) as Augment;
}

function emptyInspection(issues: readonly RouteInspectionIssue[]): RouteInspectionResult {
  const manifest = Object.freeze([]) as readonly RouteManifestEntry[];
  return {
    manifest,
    summary: summarizeRouteManifest(manifest),
    issues: Object.freeze([...issues]),
  };
}
