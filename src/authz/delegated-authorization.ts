import type {
  AuthorizationConstraintValue,
  AuthorizationConstraints,
  AuthorizationGrant,
  AuthorizationRequirement,
  AuthorizationResourceBinding,
  RouteAuthContext,
  RouteExternalAuthClaims,
} from "../types";

export type DelegatedAuthorizationFailureReason =
  | "authorization-claims-required"
  | "authorization-scope-missing"
  | "authorization-grant-missing"
  | "authorization-resource-unresolved";

export type DelegatedAuthorizationDecision =
  | { ok: true }
  | {
      ok: false;
      reason: DelegatedAuthorizationFailureReason;
      requirement: AuthorizationRequirement;
    };

export interface DelegatedAuthorizationContext {
  auth: RouteAuthContext;
  params?: Record<string, string>;
}

export function normalizeAuthorizationRequirements(
  requires: AuthorizationRequirement | readonly AuthorizationRequirement[] | undefined,
): readonly AuthorizationRequirement[] {
  if (requires === undefined) return [];
  return isAuthorizationRequirementArray(requires) ? [...requires] : [requires];
}

export function evaluateDelegatedAuthorization(
  requires: AuthorizationRequirement | readonly AuthorizationRequirement[] | undefined,
  context: DelegatedAuthorizationContext,
): DelegatedAuthorizationDecision {
  const requirements = normalizeAuthorizationRequirements(requires);
  if (requirements.length === 0) return { ok: true };

  const claims = externalAuthClaims(context.auth);
  if (!claims) {
    return {
      ok: false,
      reason: "authorization-claims-required",
      requirement: requirements[0]!,
    };
  }

  for (const requirement of requirements) {
    if ("scope" in requirement) {
      if (!claims.scopes?.includes(requirement.scope)) {
        return { ok: false, reason: "authorization-scope-missing", requirement };
      }
      continue;
    }

    const resource = resolveAuthorizationResource(requirement.resource, context.params);
    if (!resource.ok) {
      return { ok: false, reason: "authorization-resource-unresolved", requirement };
    }

    const matchingGrant = claims.grants?.some((grant) =>
      grantSatisfiesRequirement(grant, requirement, resource.value),
    );
    if (!matchingGrant) {
      return { ok: false, reason: "authorization-grant-missing", requirement };
    }
  }

  return { ok: true };
}

export function validateAuthorizationRequirements(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const requirements = Array.isArray(value) ? value : [value];
  if (requirements.length === 0) return "requires must not be an empty array";

  for (const requirement of requirements) {
    const error = validateAuthorizationRequirement(requirement);
    if (error) return error;
  }
  return undefined;
}

function externalAuthClaims(auth: RouteAuthContext): RouteExternalAuthClaims | null {
  if (auth.mode !== "visitor" || auth.state !== "recognized") return null;
  return auth.externalAuth ?? null;
}

function grantSatisfiesRequirement(
  grant: AuthorizationGrant,
  requirement: Extract<AuthorizationRequirement, { action: string }>,
  resource: string | undefined,
): boolean {
  if (grant.action !== requirement.action) return false;
  if (resource !== undefined && grant.resource !== resource) return false;
  return constraintsSatisfy(requirement.constraints, grant.constraints);
}

function resolveAuthorizationResource(
  binding: AuthorizationResourceBinding | undefined,
  params: Record<string, string> | undefined,
): { ok: true; value?: string } | { ok: false } {
  if (binding === undefined) return { ok: true };
  if (typeof binding === "string") return { ok: true, value: binding };
  const value = params?.[binding.param];
  if (!value) return { ok: false };
  return { ok: true, value };
}

function constraintsSatisfy(
  required: AuthorizationConstraints | undefined,
  actual: AuthorizationConstraints | undefined,
): boolean {
  if (required === undefined) return true;
  if (actual === undefined) return false;
  return Object.entries(required).every(([key, value]) =>
    authorizationConstraintValueEqual(actual[key], value),
  );
}

function authorizationConstraintValueEqual(
  left: AuthorizationConstraintValue | undefined,
  right: AuthorizationConstraintValue,
): boolean {
  if (left === undefined) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => authorizationConstraintValueEqual(item, right[index]!));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return rightKeys.every((key) => authorizationConstraintValueEqual(left[key], right[key]!));
  }
  return left === right;
}

function validateAuthorizationRequirement(value: unknown): string | undefined {
  if (!isRecord(value)) return "each authorization requirement must be an object";
  const hasScope = Object.hasOwn(value, "scope");
  const hasAction = Object.hasOwn(value, "action");
  if (hasScope === hasAction) {
    return 'authorization requirement must contain exactly one of "scope" or "action"';
  }
  if (hasScope) {
    if (typeof value.scope !== "string" || value.scope.length === 0) {
      return "authorization scope requirement must use a non-empty string";
    }
    return undefined;
  }

  if (typeof value.action !== "string" || value.action.length === 0) {
    return "authorization grant requirement must use a non-empty action string";
  }
  if (value.resource !== undefined && !isAuthorizationResourceBinding(value.resource)) {
    return "authorization grant requirement resource must be a non-empty string or { param }";
  }
  if (value.constraints !== undefined && !isAuthorizationConstraints(value.constraints)) {
    return "authorization grant requirement constraints must be a JSON object";
  }
  return undefined;
}

function isAuthorizationResourceBinding(value: unknown): value is AuthorizationResourceBinding {
  if (typeof value === "string") return value.length > 0;
  if (!isRecord(value)) return false;
  return typeof value.param === "string" && value.param.length > 0;
}

function isAuthorizationConstraints(value: unknown): value is AuthorizationConstraints {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isAuthorizationConstraintValue);
}

function isAuthorizationConstraintValue(value: unknown): value is AuthorizationConstraintValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isAuthorizationConstraintValue);
      if (!isRecord(value)) return false;
      return Object.values(value).every(isAuthorizationConstraintValue);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthorizationRequirementArray(
  value: AuthorizationRequirement | readonly AuthorizationRequirement[],
): value is readonly AuthorizationRequirement[] {
  return Array.isArray(value);
}
