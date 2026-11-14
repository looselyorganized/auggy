/** Passive ingress classification. This module must never import augment factories. */
import type { AuthoringDocument } from "../authoring/contracts";
import type { AugmentConfig, BuiltinAugmentType } from "../types";
import {
  BUILTIN_INGRESS,
  DEPLOYMENT_LIMITS,
  type DeploymentProfile,
  type ProfileSelection,
  type ResolvedDeploymentProfile,
} from "./contracts";

function fail(message: string): never {
  throw new Error(`[deployment-profile] ${message}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function controls(value: string, space = false): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < (space ? 33 : 32) ||
      (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
  );
}

function unresolved(value: unknown): boolean {
  return typeof value === "string" && value.includes("${");
}

function port(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

export function validateHealthPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    Buffer.byteLength(value) > DEPLOYMENT_LIMITS.healthPathBytes ||
    /[\\?#]/.test(value) ||
    controls(value, true)
  ) {
    fail("Health path must be a bounded origin-relative path without query, fragment or controls.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail("Health path contains malformed percent escapes.");
  }
  if (decoded.includes("\\") || controls(decoded) || decoded.startsWith("//")) {
    fail("Health path contains an encoded unsafe character.");
  }
  if (new URL(value, "https://deployment.invalid").origin !== "https://deployment.invalid") {
    fail("Health path must preserve the deployment origin.");
  }
}

export function validateDeploymentProfile(value: unknown): asserts value is DeploymentProfile {
  const profile = record(value);
  if (!profile) fail("Expected a deployment profile.");
  if (profile.kind === "none") {
    if (Object.keys(profile).length !== 1) fail("A worker profile cannot declare HTTP fields.");
    return;
  }
  if (
    profile.kind !== "http" ||
    !port(profile.port) ||
    Object.keys(profile).length !== 4 ||
    !Object.keys(profile).every((key) =>
      ["kind", "port", "healthPath", "consolePath"].includes(key),
    ) ||
    (profile.consolePath !== null && profile.consolePath !== "/console")
  ) {
    fail("HTTP profile requires a valid port and explicit health/console capabilities.");
  }
  if (profile.healthPath !== null) validateHealthPath(profile.healthPath);
}

interface Listener {
  readonly port: number | null;
  readonly web: boolean;
  readonly console: boolean;
}

function classify(augments: readonly { type: string; options?: unknown }[]): {
  listeners: Listener[];
  unknown: boolean;
  unresolvedKnown: boolean;
} {
  const listeners: Listener[] = [];
  let unknown = false;
  let unresolvedKnown = false;
  for (const augment of augments) {
    if (!Object.hasOwn(BUILTIN_INGRESS, augment.type)) {
      unknown = true;
      continue;
    }
    const kind = BUILTIN_INGRESS[augment.type as BuiltinAugmentType];
    if (kind === "none") continue;
    const options = record(augment.options ?? {});
    if (!options) fail("Known listener options must be a mapping.");
    let rawPort: unknown;
    let web = false;
    let console = false;
    if (kind === "web") {
      rawPort = options.port;
      web = true;
      const adminRoute = options.adminRoute;
      if (adminRoute !== undefined && typeof adminRoute !== "boolean" && !unresolved(adminRoute)) {
        fail("webTransport adminRoute must be a boolean or unresolved environment expression.");
      }
      console = adminRoute === undefined || adminRoute === true;
    } else if (kind === "link") {
      rawPort = options.port === undefined ? 8081 : options.port;
    } else {
      const inbound = record(options.inbound);
      if (!inbound) fail("telegramTransport requires an inbound mode.");
      if (unresolved(inbound.mode)) {
        unknown = true;
        unresolvedKnown = true;
        continue;
      }
      if (inbound.mode === "polling") continue;
      if (inbound.mode !== "webhook") fail("telegramTransport requires polling or webhook mode.");
      const webhook = record(inbound.webhook);
      if (!webhook) fail("Telegram webhook mode requires webhook options.");
      rawPort = webhook.port === undefined ? 8081 : webhook.port;
    }
    if (!port(rawPort) && !unresolved(rawPort)) {
      fail("Known listener port must be an integer from 1 to 65535.");
    }
    if (unresolved(rawPort)) {
      unknown = true;
      unresolvedKnown = true;
    }
    listeners.push({ port: port(rawPort) ? rawPort : null, web, console });
  }
  if (listeners.length > 1) fail("Multiple known listeners require a custom deployment topology.");
  return { listeners, unknown, unresolvedKnown };
}

export function resolveDeploymentProfile(
  document: AuthoringDocument,
  selection: ProfileSelection,
): ResolvedDeploymentProfile {
  if (!["auto", "none", "http"].includes(selection.ingress))
    fail("Select auto, none or http ingress.");
  if (selection.port !== undefined && !port(selection.port))
    fail("--port must be an integer from 1 to 65535.");
  if (selection.healthPath !== undefined) validateHealthPath(selection.healthPath);
  const { listeners, unknown } = classify(document.declarations);
  const listener = listeners[0];
  if (selection.ingress === "auto" && unknown) {
    fail("Ingress is unresolved; select --ingress none or --ingress http with a literal --port.");
  }
  if (selection.ingress === "none" || (selection.ingress === "auto" && !listener)) {
    if (listener) fail("A worker profile conflicts with a known HTTP listener.");
    if (selection.port !== undefined || selection.healthPath !== undefined) {
      fail("HTTP flags require an HTTP profile.");
    }
    return {
      profile: { kind: "none" },
      selection: selection.ingress,
      evidence: unknown ? "operator-declared" : "known-config",
      diagnostics: [],
    };
  }
  if (!listener && !unknown)
    fail("HTTP selection does not enable a listener; declare one in the application.");
  if (
    listener?.port !== null &&
    listener?.port !== undefined &&
    selection.port !== undefined &&
    listener.port !== selection.port
  ) {
    fail("--port conflicts with the known listener port.");
  }
  const selectedPort = selection.port ?? listener?.port;
  if (!port(selectedPort)) fail("Unresolved or custom HTTP requires a literal --port.");
  return {
    profile: {
      kind: "http",
      port: selectedPort,
      healthPath: selection.healthPath ?? (listener?.web ? "/health" : null),
      consolePath: listener?.console ? "/console" : null,
    },
    selection: selection.ingress,
    evidence: unknown ? "operator-declared" : "known-config",
    diagnostics: [],
  };
}

export function reconcileDeploymentProfile(
  profile: DeploymentProfile,
  augments: readonly AugmentConfig[],
): void {
  validateDeploymentProfile(profile);
  const { listeners, unknown, unresolvedKnown } = classify(augments);
  if (unresolvedKnown) fail("Known listener configuration remains unresolved at launch.");
  if (profile.kind === "http" && listeners.length === 0 && !unknown)
    fail("HTTP profile conflicts with a resolved worker configuration.");
  const listener = listeners[0];
  if (
    listener &&
    (profile.kind === "none" || listener.port === null || listener.port !== profile.port)
  ) {
    fail("Resolved known listener conflicts with the deployment profile.");
  }
  if (profile.kind === "http" && profile.consolePath !== null && !listener?.console) {
    fail("The deployment profile advertises a console absent from resolved known configuration.");
  }
}
