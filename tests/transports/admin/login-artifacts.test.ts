import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONSOLE_LOGIN_VARIANTS,
  loadConsoleLoginArtifacts,
  type ConsoleLoginVariant,
} from "@/transports/admin/login-artifacts";

type LogicalName = ConsoleLoginVariant | "stylesheet";

interface FixtureEntry {
  logicalName: LogicalName;
  path: string;
  mediaType: "text/css" | "text/html";
  size: number;
  sha256: string;
}

interface FixtureManifest {
  schemaVersion: 1;
  artifacts: FixtureEntry[];
}

const STYLESHEET_PATH = "assets/login-AbCd1234.css";
const STYLESHEET = ":root{color-scheme:dark}.login{color:currentColor}\n";
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function createFixture(): { root: string; loginRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "auggy-runtime-login-"));
  const loginRoot = join(root, "login");
  roots.add(root);
  mkdirSync(loginRoot, { recursive: true });

  const contents = new Map<LogicalName, string>([["stylesheet", STYLESHEET]]);
  for (const variant of CONSOLE_LOGIN_VARIANTS) contents.set(variant, loginDocument(variant));
  const artifacts = [...contents.entries()]
    .map(([logicalName, content]) => {
      const path = logicalName === "stylesheet" ? STYLESHEET_PATH : `${logicalName}.html`;
      const bytes = Buffer.from(content);
      mkdirSync(dirname(join(loginRoot, path)), { recursive: true });
      writeFileSync(join(loginRoot, path), bytes);
      return {
        logicalName,
        path,
        mediaType: logicalName === "stylesheet" ? "text/css" : "text/html",
        size: bytes.byteLength,
        sha256: sha256(bytes),
      } satisfies FixtureEntry;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  writeManifest(loginRoot, { schemaVersion: 1, artifacts });
  return { root, loginRoot };
}

function loginDocument(variant: ConsoleLoginVariant): string {
  const error =
    variant === "invalid-password"
      ? "Invalid console password."
      : variant === "invalid-ticket"
        ? "This automatic sign-in link is invalid or expired."
        : undefined;
  const errorMarkup = error ? `<p id="login-error" role="alert">${error}</p>` : "";
  const describedBy = error ? ' aria-invalid="true" aria-describedby="login-error"' : "";
  return `<!doctype html>
<html lang="en"><head><meta name="robots" content="noindex, nofollow"><title>Sign in — Auggy Console</title><link rel="stylesheet" href="/console/login-assets/${STYLESHEET_PATH}"></head>
<body><main data-auggy-login-source="registry" data-auggy-login-variant="${variant}"><div data-slot="card">${errorMarkup}<form method="post"><label for="password">Console password</label><input data-slot="input" id="password" name="password" type="password" autocomplete="current-password" required${describedBy}><button data-slot="button" type="submit">Open Console</button></form></div></main></body></html>
`;
}

function readManifest(loginRoot: string): FixtureManifest {
  return JSON.parse(readFileSync(join(loginRoot, "manifest.json"), "utf8")) as FixtureManifest;
}

function writeManifest(
  loginRoot: string,
  manifest: FixtureManifest | Record<string, unknown>,
): void {
  writeFileSync(join(loginRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function replaceAndResign(
  loginRoot: string,
  logicalName: LogicalName,
  mutate: (content: string) => string,
): void {
  const manifest = readManifest(loginRoot);
  const entry = manifest.artifacts.find((candidate) => candidate.logicalName === logicalName);
  if (!entry) throw new Error(`missing fixture entry: ${logicalName}`);
  const path = join(loginRoot, entry.path);
  const bytes = Buffer.from(mutate(readFileSync(path, "utf8")));
  writeFileSync(path, bytes);
  entry.size = bytes.byteLength;
  entry.sha256 = sha256(bytes);
  writeManifest(loginRoot, manifest);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("loadConsoleLoginArtifacts", () => {
  test("loads the exact fixed variants and fingerprinted stylesheet as one unit", async () => {
    const { root } = createFixture();

    const result = await loadConsoleLoginArtifacts(root);

    expect(result).toBeDefined();
    expect(Object.keys(result?.variants ?? {})).toEqual([...CONSOLE_LOGIN_VARIANTS]);
    expect(result?.variants.default).toContain('data-auggy-login-variant="default"');
    expect(result?.variants["invalid-password"]).toContain("Invalid console password.");
    expect(result?.variants["invalid-ticket"]).toContain(
      "This automatic sign-in link is invalid or expired.",
    );
    expect(result?.stylesheet.path).toBe(STYLESHEET_PATH);
    expect(new TextDecoder().decode(result?.stylesheet.bytes)).toBe(STYLESHEET);
  });

  test("treats absent and incomplete bundles as unavailable", async () => {
    const { root, loginRoot } = createFixture();
    unlinkSync(join(loginRoot, "invalid-ticket.html"));

    expect(await loadConsoleLoginArtifacts()).toBeUndefined();
    expect(await loadConsoleLoginArtifacts(join(root, "missing"))).toBeUndefined();
    expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
  });

  test("rejects malformed, non-canonical, and integrity-invalid manifests", async () => {
    {
      const { root, loginRoot } = createFixture();
      const manifest = readManifest(loginRoot);
      writeManifest(loginRoot, { ...manifest, generatedAt: "now" });
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
    {
      const { root, loginRoot } = createFixture();
      const manifest = readManifest(loginRoot);
      manifest.artifacts.reverse();
      writeManifest(loginRoot, manifest);
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
    {
      const { root, loginRoot } = createFixture();
      const manifest = readManifest(loginRoot);
      manifest.artifacts[0]!.sha256 = "0".repeat(64);
      writeManifest(loginRoot, manifest);
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
  });

  test("rejects re-signed executable markup and stylesheet content", async () => {
    {
      const { root, loginRoot } = createFixture();
      replaceAndResign(loginRoot, "default", (document) =>
        document.replace("</body>", "<script>location='//attacker.example'</script></body>"),
      );
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
    {
      const { root, loginRoot } = createFixture();
      replaceAndResign(loginRoot, "invalid-password", (document) =>
        document.replace(' aria-invalid="true"', ""),
      );
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
    {
      const { root, loginRoot } = createFixture();
      replaceAndResign(
        loginRoot,
        "stylesheet",
        (css) => `${css}@import url(https://attacker.example/login.css);`,
      );
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
    {
      const { root, loginRoot } = createFixture();
      replaceAndResign(loginRoot, "stylesheet", () => `.x{color:red}${" ".repeat(40 * 1024)}`);
      expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
    }
  });

  test("rejects a symlinked artifact even when it resolves inside the login root", async () => {
    const { root, loginRoot } = createFixture();
    const defaultPath = join(loginRoot, "default.html");
    writeFileSync(join(loginRoot, "shadow.html"), readFileSync(defaultPath));
    unlinkSync(defaultPath);
    symlinkSync("shadow.html", defaultPath);

    expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
  });

  test("rejects a symlinked manifest even when it resolves inside the login root", async () => {
    const { root, loginRoot } = createFixture();
    const manifestPath = join(loginRoot, "manifest.json");
    writeFileSync(join(loginRoot, "shadow-manifest.json"), readFileSync(manifestPath));
    unlinkSync(manifestPath);
    symlinkSync("shadow-manifest.json", manifestPath);

    expect(await loadConsoleLoginArtifacts(root)).toBeUndefined();
  });
});
