import type {
  AuthorizationConstraintValue,
  AuthorizationConstraints,
  AuthorizationGrant,
  DelegatedAuthorizationDeniedAuditEvent,
  DelegatedAuthorizationDeniedAuditTarget,
  DelegatedAuthorizationFailureReason,
  AuthorizationRequirement,
  AuthorizationResourceBinding,
  RouteAuthContext,
  RouteExternalAuthClaims,
} from "../types";

export type { DelegatedAuthorizationFailureReason } from "../types";

export type DelegatedAuthorizationDecision =
  | { ok: true }
  | {
      ok: false;
      reason: DelegatedAuthorizationFailureReason;
      requirement: AuthorizationRequirement;
    };

export type VisitorAuthRequiredErrorBody = { error: "visitor-auth-required" };

export type DelegatedAuthorizationForbiddenErrorBody = {
  error: "forbidden";
  reason: DelegatedAuthorizationFailureReason;
};

export type DelegatedAuthorizationHttpErrorBody =
  | VisitorAuthRequiredErrorBody
  | DelegatedAuthorizationForbiddenErrorBody;

export interface DelegatedAuthorizationContext {
  auth?: RouteAuthContext | null;
  params?: Record<string, string>;
  input?: unknown;
}

export interface DelegatedAuthorizationDeniedAuditEventOptions {
  target: DelegatedAuthorizationDeniedAuditTarget;
  decision: Extract<DelegatedAuthorizationDecision, { ok: false }>;
  auth?: RouteAuthContext | null;
}

export interface ValidateAuthorizationRequirementsOptions {
  binding?: "route" | "tool" | "any";
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

    const resource = resolveAuthorizationResource(requirement.resource, {
      input: context.input,
      params: context.params,
    });
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

export function visitorAuthRequiredErrorBody(): VisitorAuthRequiredErrorBody {
  return { error: "visitor-auth-required" };
}

export function delegatedAuthorizationForbiddenErrorBody(
  reason: DelegatedAuthorizationFailureReason,
): DelegatedAuthorizationForbiddenErrorBody {
  return { error: "forbidden", reason };
}

export function delegatedAuthorizationDeniedAuditEvent(
  opts: DelegatedAuthorizationDeniedAuditEventOptions,
): DelegatedAuthorizationDeniedAuditEvent {
  const claims = externalAuthClaims(opts.auth);
  return {
    kind: "delegated_authorization_denied",
    reason: opts.decision.reason,
    requirement: opts.decision.requirement,
    target: opts.target,
    ...(claims
      ? {
          ...(claims.keyId !== undefined ? { keyId: claims.keyId } : {}),
          provider: claims.provider,
          subject: claims.subject,
          ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
        }
      : {}),
  };
}

export function validateAuthorizationRequirements(
  value: unknown,
  opts: ValidateAuthorizationRequirementsOptions = {},
): string | undefined {
  if (value === undefined) return undefined;
  const requirements = Array.isArray(value) ? value : [value];
  if (requirements.length === 0) return "requires must not be an empty array";

  for (const requirement of requirements) {
    const error = validateAuthorizationRequirement(requirement, opts);
    if (error) return error;
  }
  return undefined;
}

function externalAuthClaims(
  auth: RouteAuthContext | null | undefined,
): RouteExternalAuthClaims | null {
  if (!auth) return null;
  if (auth.mode !== "visitor" || auth.state !== "recognized") return null;
  return auth.externalAuth ?? null;
}

function grantSatisfiesRequirement(
  grant: AuthorizationGrant,
  requirement: Extract<AuthorizationRequirement, { action: string }>,
  resource: string | undefined,
): boolean {
  if (grant.action !== requirement.action) return false;
  if (resource === undefined && grant.resource !== undefined) return false;
  if (resource !== undefined && grant.resource !== resource) return false;
  return constraintsSatisfy(requirement.constraints, grant.constraints);
}

function resolveAuthorizationResource(
  binding: AuthorizationResourceBinding | undefined,
  context: Pick<DelegatedAuthorizationContext, "input" | "params">,
): { ok: true; value?: string } | { ok: false } {
  if (binding === undefined) return { ok: true };
  if (typeof binding === "string") return { ok: true, value: binding };
  const value =
    "param" in binding
      ? context.params?.[binding.param]
      : inputResource(context.input, binding.input);
  if (value === undefined || value.length === 0) return { ok: false };
  return { ok: true, value };
}

function inputResource(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
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

function validateAuthorizationRequirement(
  value: unknown,
  opts: ValidateAuthorizationRequirementsOptions,
): string | undefined {
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
  if (
    value.resource !== undefined &&
    !isAuthorizationResourceBinding(value.resource, opts.binding ?? "any")
  ) {
    const allowed =
      opts.binding === "route"
        ? "a non-empty string or { param }"
        : opts.binding === "tool"
          ? "a non-empty string or { input }"
          : "a non-empty string, { param }, or { input }";
    return `authorization grant requirement resource must be ${allowed}`;
  }
  if (value.constraints !== undefined && !isAuthorizationConstraints(value.constraints)) {
    return "authorization grant requirement constraints must be a JSON object";
  }
  return undefined;
}

function isAuthorizationResourceBinding(
  value: unknown,
  binding: ValidateAuthorizationRequirementsOptions["binding"],
): value is AuthorizationResourceBinding {
  if (typeof value === "string") return value.length > 0;
  if (!isRecord(value)) return false;
  const hasParam = Object.hasOwn(value, "param");
  const hasInput = Object.hasOwn(value, "input");
  if (hasParam === hasInput) return false;
  if (hasParam) {
    if (binding === "tool") return false;
    return typeof value.param === "string" && value.param.length > 0;
  }
  if (binding === "route") return false;
  return typeof value.input === "string" && value.input.length > 0;
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
