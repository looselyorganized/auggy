import type {
  AugmentHttpRouteAuth,
  AugmentHttpRoutePolicy,
  AugmentHttpRouteRequestJsonSchema,
  AugmentHttpRouteResponseJsonSchema,
  AuthorizationRequirement,
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
  requires?: AuthorizationRequirement | readonly AuthorizationRequirement[];
  requestJsonSchema?: AugmentHttpRouteRequestJsonSchema;
  responseJsonSchema?: AugmentHttpRouteResponseJsonSchema;
  requestMediaTypes?: readonly string[];
  responseMediaTypes?: readonly string[];
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
        ...(route.requires ? { requires: freezeRequires(route.requires) } : {}),
        ...(route.requestJsonSchema ? { requestJsonSchema: route.requestJsonSchema } : {}),
        ...(route.responseJsonSchema ? { responseJsonSchema: route.responseJsonSchema } : {}),
        ...(route.requestMediaTypes
          ? { requestMediaTypes: Object.freeze([...route.requestMediaTypes]) }
          : {}),
        ...(route.responseMediaTypes
          ? { responseMediaTypes: Object.freeze([...route.responseMediaTypes]) }
          : {}),
      });
    }),
  );
}

function freezeRequires(
  requires: AuthorizationRequirement | readonly AuthorizationRequirement[],
): AuthorizationRequirement | readonly AuthorizationRequirement[] {
  if (isAuthorizationRequirementArray(requires)) {
    return Object.freeze(requires.map((requirement) => freezeRequirement(requirement)));
  }
  return freezeRequirement(requires);
}

function isAuthorizationRequirementArray(
  requires: AuthorizationRequirement | readonly AuthorizationRequirement[],
): requires is readonly AuthorizationRequirement[] {
  return Array.isArray(requires);
}

function freezeRequirement(requirement: AuthorizationRequirement): AuthorizationRequirement {
  if ("scope" in requirement) return Object.freeze({ scope: requirement.scope });
  return Object.freeze({
    action: requirement.action,
    ...(requirement.resource !== undefined
      ? { resource: freezeResource(requirement.resource) }
      : {}),
    ...(requirement.constraints !== undefined
      ? { constraints: deepFreezeJson(cloneJson(requirement.constraints)) }
      : {}),
  }) as AuthorizationRequirement;
}

function freezeResource(
  resource: Exclude<Extract<AuthorizationRequirement, { action: string }>["resource"], undefined>,
): Exclude<Extract<AuthorizationRequirement, { action: string }>["resource"], undefined> {
  if (typeof resource === "string") return resource;
  if ("input" in resource) return Object.freeze({ input: resource.input });
  return Object.freeze({ param: resource.param });
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ) as T;
  }
  return value;
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value);
  }
  return value;
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
