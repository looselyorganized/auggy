import type {
  AugmentHttpRouteAuth,
  AugmentHttpRoutePolicy,
  AugmentHttpRouteRequestJsonSchema,
  AugmentHttpRouteResponseJsonSchema,
  HttpMethod,
} from "../types";
import type { CollectedRoute } from "./route-collector";
import { parseRoutePattern } from "./route-pattern";

export type RouteSecurityPosture = "public" | "private";

export interface RouteManifestEntry {
  method: HttpMethod;
  path: string;
  augmentName: string;
  auth: AugmentHttpRouteAuth;
  params: readonly string[];
  public: boolean;
  security: RouteSecurityPosture;
  timeoutMs?: number;
  maxBodyBytes?: number;
  rateLimit?: {
    maxPerMinute: number;
  };
  policy?: AugmentHttpRoutePolicy;
  requestJsonSchema?: AugmentHttpRouteRequestJsonSchema;
  responseJsonSchema?: AugmentHttpRouteResponseJsonSchema;
}

export interface RouteManifestSummary {
  totalRoutes: number;
  publicRoutes: number;
  privateRoutes: number;
  publicRoutePaths: readonly string[];
}

export function createRouteManifest(
  routes: readonly CollectedRoute[],
): readonly RouteManifestEntry[] {
  return Object.freeze(
    routes.map((route) => {
      const parsed = parseRoutePattern(route.path);
      const params = parsed.ok ? parsed.pattern.params : [];
      const isPublic = route.auth === "none" || route.auth === "visitor.optional";
      const policy = route.policy
        ? (Object.freeze({ ...route.policy }) as AugmentHttpRoutePolicy)
        : undefined;
      return Object.freeze({
        method: route.method,
        path: route.path,
        augmentName: route.augmentName,
        auth: route.auth,
        params: Object.freeze([...params]),
        public: isPublic,
        security: isPublic ? "public" : "private",
        ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
        ...(route.maxBodyBytes !== undefined ? { maxBodyBytes: route.maxBodyBytes } : {}),
        ...(route.rateLimit ? { rateLimit: { maxPerMinute: route.rateLimit.maxPerMinute } } : {}),
        ...(policy ? { policy } : {}),
        ...(route.requestJsonSchema ? { requestJsonSchema: route.requestJsonSchema } : {}),
        ...(route.responseJsonSchema ? { responseJsonSchema: route.responseJsonSchema } : {}),
      });
    }),
  );
}

export function summarizeRouteManifest(
  manifest: readonly RouteManifestEntry[],
): RouteManifestSummary {
  const publicRoutePaths = manifest
    .filter((route) => route.public)
    .map((route) => `${route.method} ${route.path}`);

  return Object.freeze({
    totalRoutes: manifest.length,
    publicRoutes: publicRoutePaths.length,
    privateRoutes: manifest.length - publicRoutePaths.length,
    publicRoutePaths: Object.freeze(publicRoutePaths),
  });
}
