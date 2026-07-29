import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LOGIN_ERROR_MESSAGES,
  LOGIN_VARIANTS,
  LoginPage,
  type LoginVariant,
} from "../src/LoginPage";

export const LOGIN_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const LOGIN_MANIFEST_FILENAME = "manifest.json";
export const MAX_LOGIN_HTML_BYTES = 256 * 1024;
export const MAX_LOGIN_STYLESHEET_BYTES = 40 * 1024;

export const LOGIN_HTML_PATHS: Readonly<Record<LoginVariant, string>> = {
  default: "default.html",
  "invalid-password": "invalid-password.html",
  "invalid-ticket": "invalid-ticket.html",
};

export type LoginArtifactLogicalName = LoginVariant | "stylesheet";

export interface LoginArtifactEntry {
  logicalName: LoginArtifactLogicalName;
  path: string;
  mediaType: "text/css" | "text/html";
  size: number;
  sha256: string;
}

export interface LoginArtifactManifest {
  schemaVersion: typeof LOGIN_ARTIFACT_SCHEMA_VERSION;
  artifacts: LoginArtifactEntry[];
}

const EXPECTED_LOGICAL_NAMES = new Set<LoginArtifactLogicalName>([...LOGIN_VARIANTS, "stylesheet"]);

export function sha256Hex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createLoginArtifactEntry(
  logicalName: LoginArtifactLogicalName,
  path: string,
  content: Uint8Array | string,
): LoginArtifactEntry {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    logicalName,
    path,
    mediaType: logicalName === "stylesheet" ? "text/css" : "text/html",
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

export function createLoginManifest(entries: readonly LoginArtifactEntry[]): LoginArtifactManifest {
  const manifest: LoginArtifactManifest = {
    schemaVersion: LOGIN_ARTIFACT_SCHEMA_VERSION,
    artifacts: [...entries].sort((left, right) => compareStrings(left.path, right.path)),
  };
  validateLoginManifest(manifest);
  return manifest;
}

export function validateLoginManifest(value: unknown): asserts value is LoginArtifactManifest {
  if (!isPlainObject(value)) throw new Error("login manifest must be an object");
  assertExactKeys(value, ["artifacts", "schemaVersion"], "login manifest");
  if (value.schemaVersion !== LOGIN_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("unsupported login manifest schema");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== EXPECTED_LOGICAL_NAMES.size) {
    throw new Error("login manifest has an invalid artifact count");
  }

  const logicalNames = new Set<LoginArtifactLogicalName>();
  const paths = new Set<string>();
  let previousPath = "";
  for (const rawEntry of value.artifacts) {
    if (!isPlainObject(rawEntry)) throw new Error("login manifest entry must be an object");
    assertExactKeys(
      rawEntry,
      ["logicalName", "mediaType", "path", "sha256", "size"],
      "login manifest entry",
    );
    const { logicalName, mediaType, path, sha256, size } = rawEntry;
    if (
      typeof logicalName !== "string" ||
      !EXPECTED_LOGICAL_NAMES.has(logicalName as LoginArtifactLogicalName)
    ) {
      throw new Error("login manifest has an unknown logical name");
    }
    if (logicalNames.has(logicalName as LoginArtifactLogicalName)) {
      throw new Error("login manifest has a duplicate logical name");
    }
    logicalNames.add(logicalName as LoginArtifactLogicalName);

    if (typeof path !== "string" || !isSafeArtifactPath(path)) {
      throw new Error("login manifest has an unsafe artifact path");
    }
    if (paths.has(path)) throw new Error("login manifest has a duplicate artifact path");
    if (previousPath && compareStrings(previousPath, path) >= 0) {
      throw new Error("login manifest artifacts must be path-sorted");
    }
    previousPath = path;
    paths.add(path);

    const expectedHtmlPath = LOGIN_HTML_PATHS[logicalName as LoginVariant];
    if (logicalName === "stylesheet") {
      if (!/^assets\/login-[A-Za-z0-9_-]{6,64}\.css$/.test(path) || mediaType !== "text/css") {
        throw new Error("login manifest stylesheet entry is invalid");
      }
    } else if (path !== expectedHtmlPath || mediaType !== "text/html") {
      throw new Error("login manifest HTML entry is invalid");
    }
    const byteLimit =
      logicalName === "stylesheet" ? MAX_LOGIN_STYLESHEET_BYTES : MAX_LOGIN_HTML_BYTES;
    if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > byteLimit) {
      throw new Error("login manifest artifact size is invalid");
    }
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error("login manifest artifact digest is invalid");
    }
  }
  if (logicalNames.size !== EXPECTED_LOGICAL_NAMES.size) {
    throw new Error("login manifest is incomplete");
  }
}

export function renderLoginDocument(variant: LoginVariant, stylesheetPath: string): string {
  if (!LOGIN_VARIANTS.includes(variant)) throw new Error("unknown login variant");
  if (!/^assets\/login-[A-Za-z0-9_-]{6,64}\.css$/.test(stylesheetPath)) {
    throw new Error("invalid login stylesheet path");
  }
  const body = renderToStaticMarkup(<LoginPage variant={variant} />);
  const document = `<!doctype html>
<html lang="en" class="dark h-full">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Sign in — Auggy Console</title>
    <link rel="stylesheet" href="/console/login-assets/${stylesheetPath}">
  </head>
  <body class="h-full">${body}</body>
</html>
`;
  validateLoginDocument(document, variant, stylesheetPath);
  return document;
}

export function validateLoginDocument(
  document: string,
  variant: LoginVariant,
  stylesheetPath: string,
): void {
  if (countMatches(document, /<form\b/gi) !== 1) throw new Error("login document needs one form");
  const form = document.match(/<form\b[^>]*>/i)?.[0];
  if (!form || !/\smethod="post"/i.test(form) || /\saction\s*=/i.test(form)) {
    throw new Error("login document form contract is invalid");
  }
  if (countMatches(document, /data-auggy-login-source="registry"/g) !== 1) {
    throw new Error("login document registry marker is invalid");
  }
  if (countMatches(document, new RegExp(`data-auggy-login-variant="${variant}"`, "g")) !== 1) {
    throw new Error("login document variant marker is invalid");
  }
  const passwordInputs = (document.match(/<input\b[^>]*>/gi) ?? []).filter(
    (input) => /\sname="password"/i.test(input) && /\stype="password"/i.test(input),
  );
  const passwordInput = passwordInputs[0];
  if (
    passwordInputs.length !== 1 ||
    !passwordInput ||
    !/\sid="password"/i.test(passwordInput) ||
    !/\sautocomplete="current-password"/i.test(passwordInput) ||
    !/\srequired(?:=""|(?=\s|>))/i.test(passwordInput)
  ) {
    throw new Error("login document password control is invalid");
  }
  if (countMatches(document, /<label\b[^>]*\sfor="password"[^>]*>/gi) !== 1) {
    throw new Error("login document password label is invalid");
  }
  if (countMatches(document, /<button\b[^>]*\stype="submit"[^>]*>/gi) !== 1) {
    throw new Error("login document submit control is invalid");
  }
  if (
    /<(?:script|style|img|iframe|object|embed|audio|video|source|track|picture|svg|use)\b/i.test(
      document,
    ) ||
    /\s(?:on[a-z]+|style)\s*=/i.test(document)
  ) {
    throw new Error("login document must not contain executable content");
  }
  if (/__[A-Z0-9_]+__/.test(document))
    throw new Error("login document has an unresolved placeholder");
  if (/\svalue\s*=/i.test(document)) throw new Error("login document serializes an input value");
  if (containsLocalPath(document)) throw new Error("login document contains a local path");
  const expectedStylesheet = `/console/login-assets/${stylesheetPath}`;
  if (
    countMatches(document, /<link\b/gi) !== 1 ||
    countMatches(document, new RegExp(escapeRegExp(`href="${expectedStylesheet}"`), "g")) !== 1 ||
    !/<link\b[^>]*\srel="stylesheet"[^>]*>/i.test(document)
  ) {
    throw new Error("login document stylesheet reference is invalid");
  }
  if (/(?:https?:|data:|javascript:|href="\/\/|src="\/\/)/i.test(document)) {
    throw new Error("login document contains a remote or executable resource");
  }

  const expectedError = LOGIN_ERROR_MESSAGES[variant];
  const alertCount = countMatches(document, /role="alert"/g);
  if (expectedError) {
    if (
      alertCount !== 1 ||
      !document.includes(expectedError) ||
      countMatches(document, /id="login-error"/g) !== 1 ||
      !/\saria-describedby="login-error"/i.test(passwordInput)
    ) {
      throw new Error("login error variant is invalid");
    }
  } else if (
    alertCount !== 0 ||
    document.includes('id="login-error"') ||
    /\saria-describedby=/i.test(passwordInput)
  ) {
    throw new Error("default login document must not contain error semantics");
  }
  for (const message of Object.values(LOGIN_ERROR_MESSAGES)) {
    if (document.includes(message) !== (message === expectedError)) {
      throw new Error("login document contains an unexpected error message");
    }
  }
}

export function verifyLoginArtifactDirectory(root: string): LoginArtifactManifest {
  const requestedRoot = resolve(root);
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("login artifact root must be a regular directory");
  }
  const canonicalRoot = realpathSync(requestedRoot);
  const manifestPath = resolve(canonicalRoot, LOGIN_MANIFEST_FILENAME);
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("login manifest must be a regular file");
  }
  const manifestBytes = readFileSync(manifestPath);
  if (manifestBytes.byteLength > 64 * 1024) throw new Error("login manifest is too large");
  const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
  validateLoginManifest(parsed);

  const expectedPaths = new Set([
    LOGIN_MANIFEST_FILENAME,
    ...parsed.artifacts.map((entry) => entry.path),
  ]);
  const actualPaths = listFiles(canonicalRoot);
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((path) => !expectedPaths.has(path))
  ) {
    throw new Error("login artifact directory has an unexpected inventory");
  }

  const stylesheet = parsed.artifacts.find((entry) => entry.logicalName === "stylesheet");
  if (!stylesheet) throw new Error("login stylesheet entry is missing");
  for (const entry of parsed.artifacts) {
    const artifactPath = resolve(canonicalRoot, ...entry.path.split("/"));
    if (!isWithin(canonicalRoot, artifactPath)) throw new Error("login artifact escapes its root");
    const stat = lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("login artifact must be a regular file");
    }
    const bytes = readFileSync(artifactPath);
    if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new Error("login artifact integrity check failed");
    }
    const content = bytes.toString("utf8");
    if (containsLocalPath(content)) throw new Error("login artifact contains a local path");
    if (entry.logicalName === "stylesheet") {
      if (/sourceMappingURL|<script\b|@import\b|url\s*\(|javascript:/i.test(content)) {
        throw new Error("login stylesheet contains forbidden output");
      }
    } else {
      validateLoginDocument(content, entry.logicalName, stylesheet.path);
    }
  }
  return parsed;
}

export function serializeLoginManifest(manifest: LoginArtifactManifest): string {
  validateLoginManifest(manifest);
  const canonical: LoginArtifactManifest = {
    schemaVersion: LOGIN_ARTIFACT_SCHEMA_VERSION,
    artifacts: manifest.artifacts.map((entry) => ({
      logicalName: entry.logicalName,
      path: entry.path,
      mediaType: entry.mediaType,
      size: entry.size,
      sha256: entry.sha256,
    })),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function isSafeArtifactPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("%")) return false;
  if (value.includes("\0") || posix.normalize(value) !== value) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error("login artifacts must not contain symlinks");
      if (stat.isDirectory()) visit(absolutePath, relativePath);
      else if (stat.isFile()) files.push(relativePath);
      else throw new Error("login artifacts must contain regular files only");
    }
  };
  visit(root, "");
  return files.sort(compareStrings);
}

function containsLocalPath(value: string): boolean {
  return /(?:file:\/\/|\/Users\/|\/private\/|[A-Za-z]:\\)/.test(value);
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareStrings);
  const sortedExpected = [...expected].sort(compareStrings);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
