import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { serveStaticFile } from "./admin-static";

export const CONSOLE_LOGIN_VARIANTS = ["default", "invalid-password", "invalid-ticket"] as const;

export type ConsoleLoginVariant = (typeof CONSOLE_LOGIN_VARIANTS)[number];

export interface ConsoleLoginArtifacts {
  variants: Readonly<Record<ConsoleLoginVariant, string>>;
  stylesheet: {
    path: string;
    bytes: Uint8Array;
  };
}

interface LoginArtifactEntry {
  logicalName: ConsoleLoginVariant | "stylesheet";
  path: string;
  mediaType: "text/css" | "text/html";
  size: number;
  sha256: string;
}

interface LoginArtifactManifest {
  schemaVersion: 1;
  artifacts: LoginArtifactEntry[];
}

const LOGIN_MANIFEST_FILENAME = "manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_STYLESHEET_BYTES = 1024 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const HTML_PATHS: Readonly<Record<ConsoleLoginVariant, string>> = {
  default: "default.html",
  "invalid-password": "invalid-password.html",
  "invalid-ticket": "invalid-ticket.html",
};
const ERROR_MESSAGES: Readonly<Partial<Record<ConsoleLoginVariant, string>>> = {
  "invalid-password": "Invalid console password.",
  "invalid-ticket": "This automatic sign-in link is invalid or expired.",
};
const EXPECTED_LOGICAL_NAMES = new Set<LoginArtifactEntry["logicalName"]>([
  ...CONSOLE_LOGIN_VARIANTS,
  "stylesheet",
]);

/**
 * Load the generated pre-authentication Console login bundle as one validated
 * unit. A partial, stale, or hostile bundle is indistinguishable from an
 * absent bundle so callers can deterministically use the semantic fallback.
 */
export async function loadConsoleLoginArtifacts(
  staticDir?: string,
): Promise<ConsoleLoginArtifacts | undefined> {
  if (!staticDir) return undefined;

  try {
    const loginRoot = resolve(staticDir, "login");
    if (!isRegularDirectory(loginRoot)) return undefined;

    if (!hasOnlyRegularPathComponents(loginRoot, LOGIN_MANIFEST_FILENAME)) return undefined;
    const manifestBytes = await readArtifact(loginRoot, LOGIN_MANIFEST_FILENAME);
    if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) return undefined;
    const parsed: unknown = JSON.parse(decodeUtf8(manifestBytes));
    const manifest = parseManifest(parsed);
    if (!manifest) return undefined;

    const loaded = new Map<LoginArtifactEntry["logicalName"], Uint8Array>();
    for (const entry of manifest.artifacts) {
      if (!hasOnlyRegularPathComponents(loginRoot, entry.path)) return undefined;
      const bytes = await readArtifact(loginRoot, entry.path);
      if (!bytes || bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
        return undefined;
      }
      loaded.set(entry.logicalName, bytes);
    }

    const stylesheetEntry = manifest.artifacts.find((entry) => entry.logicalName === "stylesheet");
    const stylesheetBytes = loaded.get("stylesheet");
    if (!stylesheetEntry || !stylesheetBytes) return undefined;
    const stylesheet = decodeUtf8(stylesheetBytes);
    if (!isSafeStylesheet(stylesheet)) return undefined;

    const variants = {} as Record<ConsoleLoginVariant, string>;
    for (const variant of CONSOLE_LOGIN_VARIANTS) {
      const bytes = loaded.get(variant);
      if (!bytes) return undefined;
      const document = decodeUtf8(bytes);
      if (!isSafeLoginDocument(document, variant, stylesheetEntry.path)) return undefined;
      variants[variant] = document;
    }

    return {
      variants,
      stylesheet: {
        path: stylesheetEntry.path,
        bytes: stylesheetBytes,
      },
    };
  } catch {
    return undefined;
  }
}

async function readArtifact(root: string, relativePath: string): Promise<Uint8Array | undefined> {
  const response = serveStaticFile(root, relativePath);
  if (response?.status !== 200) return undefined;
  return new Uint8Array(await response.arrayBuffer());
}

function parseManifest(value: unknown): LoginArtifactManifest | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["artifacts", "schemaVersion"])) {
    return undefined;
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.artifacts)) return undefined;
  if (value.artifacts.length !== EXPECTED_LOGICAL_NAMES.size) return undefined;

  const logicalNames = new Set<LoginArtifactEntry["logicalName"]>();
  const paths = new Set<string>();
  const artifacts: LoginArtifactEntry[] = [];
  let previousPath = "";

  for (const rawEntry of value.artifacts) {
    if (
      !isPlainObject(rawEntry) ||
      !hasExactKeys(rawEntry, ["logicalName", "mediaType", "path", "sha256", "size"])
    ) {
      return undefined;
    }
    const { logicalName, mediaType, path, sha256, size } = rawEntry;
    if (
      typeof logicalName !== "string" ||
      !EXPECTED_LOGICAL_NAMES.has(logicalName as LoginArtifactEntry["logicalName"]) ||
      logicalNames.has(logicalName as LoginArtifactEntry["logicalName"])
    ) {
      return undefined;
    }
    if (
      typeof path !== "string" ||
      !isSafeArtifactPath(path) ||
      paths.has(path) ||
      (previousPath !== "" && previousPath >= path)
    ) {
      return undefined;
    }
    if (
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(size)
    ) {
      return undefined;
    }

    const typedLogicalName = logicalName as LoginArtifactEntry["logicalName"];
    const byteLimit = typedLogicalName === "stylesheet" ? MAX_STYLESHEET_BYTES : MAX_HTML_BYTES;
    if ((size as number) <= 0 || (size as number) > byteLimit) return undefined;
    if (typedLogicalName === "stylesheet") {
      if (mediaType !== "text/css" || !/^assets\/login-[A-Za-z0-9_-]{6,64}\.css$/.test(path)) {
        return undefined;
      }
    } else if (mediaType !== "text/html" || path !== HTML_PATHS[typedLogicalName]) {
      return undefined;
    }

    logicalNames.add(typedLogicalName);
    paths.add(path);
    previousPath = path;
    artifacts.push({
      logicalName: typedLogicalName,
      mediaType: mediaType as LoginArtifactEntry["mediaType"],
      path,
      sha256,
      size: size as number,
    });
  }

  return logicalNames.size === EXPECTED_LOGICAL_NAMES.size
    ? { schemaVersion: 1, artifacts }
    : undefined;
}

function isSafeLoginDocument(
  document: string,
  variant: ConsoleLoginVariant,
  stylesheetPath: string,
): boolean {
  if (
    !document.startsWith("<!doctype html>") ||
    countMatches(document, /<title>Sign in — Auggy Console<\/title>/g) !== 1 ||
    countMatches(
      document,
      /<meta\b[^>]*\sname="robots"[^>]*\scontent="noindex, nofollow"[^>]*>/gi,
    ) !== 1
  ) {
    return false;
  }
  const forms = document.match(/<form\b[^>]*>/gi) ?? [];
  if (
    forms.length !== 1 ||
    !/\smethod="post"/i.test(forms[0] ?? "") ||
    /\saction\s*=/i.test(forms[0] ?? "")
  ) {
    return false;
  }
  if (countMatches(document, /data-auggy-login-source="registry"/g) !== 1) return false;
  if (countMatches(document, new RegExp(`data-auggy-login-variant="${variant}"`, "g")) !== 1) {
    return false;
  }
  for (const slot of ["card", "input", "button"]) {
    if (countMatches(document, new RegExp(`data-slot="${slot}"`, "g")) !== 1) return false;
  }

  const inputs = document.match(/<input\b[^>]*>/gi) ?? [];
  const passwordInput = inputs[0] ?? "";
  if (
    inputs.length !== 1 ||
    !/\sid="password"/i.test(passwordInput) ||
    !/\sname="password"/i.test(passwordInput) ||
    !/\stype="password"/i.test(passwordInput) ||
    !/\sautocomplete="current-password"/i.test(passwordInput) ||
    !/\srequired(?:=""|(?=\s|>))/i.test(passwordInput) ||
    /\svalue\s*=/i.test(passwordInput)
  ) {
    return false;
  }
  if (countMatches(document, /<label\b[^>]*\sfor="password"[^>]*>/gi) !== 1) return false;
  if (countMatches(document, /<button\b[^>]*\stype="submit"[^>]*>/gi) !== 1) return false;

  if (
    /<(?:script|style|img|iframe|object|embed|audio|video|source|track|picture|svg|use|base)\b/i.test(
      document,
    ) ||
    /<meta\b[^>]*\shttp-equiv\s*=/i.test(document) ||
    /\s(?:on[a-z]+|style|formaction)\s*=/i.test(document) ||
    /<(?:textarea|select|option|datalist|output)\b/i.test(document) ||
    /__[A-Z0-9_]+__/.test(document) ||
    countMatches(document, /\sname="password"/gi) !== 1 ||
    /\svalue\s*=/i.test(document) ||
    containsLocalPath(document)
  ) {
    return false;
  }

  const expectedStylesheet = `/console/login-assets/${stylesheetPath}`;
  if (
    countMatches(document, /<link\b/gi) !== 1 ||
    countMatches(document, /\shref\s*=/gi) !== 1 ||
    !document.includes(`href="${expectedStylesheet}"`) ||
    !/<link\b[^>]*\srel="stylesheet"[^>]*>/i.test(document) ||
    /\s(?:src|srcset)\s*=/i.test(document)
  ) {
    return false;
  }
  if (/(?:https?:|data:|javascript:|href="\/\/|src="\/\/)/i.test(document)) return false;

  const expectedError = ERROR_MESSAGES[variant];
  const alertCount = countMatches(document, /\srole="alert"/gi);
  if (expectedError) {
    if (
      alertCount !== 1 ||
      countMatches(document, /\sid="login-error"/gi) !== 1 ||
      !document.includes(expectedError) ||
      !/\saria-invalid="true"/i.test(passwordInput) ||
      !/\saria-describedby="login-error"/i.test(passwordInput)
    ) {
      return false;
    }
  } else if (
    alertCount !== 0 ||
    /\sid="login-error"/i.test(document) ||
    /\saria-invalid\s*=/i.test(passwordInput) ||
    /\saria-describedby\s*=/i.test(passwordInput)
  ) {
    return false;
  }
  for (const message of Object.values(ERROR_MESSAGES)) {
    if (document.includes(message) !== (message === expectedError)) return false;
  }

  return true;
}

function isSafeStylesheet(stylesheet: string): boolean {
  return (
    stylesheet.length > 0 &&
    !/(?:sourceMappingURL|sourceURL|@import\b|url\s*\(|<script\b|javascript:)/i.test(stylesheet) &&
    !containsLocalPath(stylesheet)
  );
}

function isSafeArtifactPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("%")) return false;
  if (value.includes("\0") || posix.normalize(value) !== value) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasOnlyRegularPathComponents(root: string, relativePath: string): boolean {
  try {
    let current = root;
    const segments = relativePath.split("/");
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return false;
      const isLast = index === segments.length - 1;
      if (isLast ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isRegularDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containsLocalPath(value: string): boolean {
  return /(?:file:\/\/|\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/.test(
    value,
  );
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareStrings);
  const sortedExpected = [...expected].sort(compareStrings);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
