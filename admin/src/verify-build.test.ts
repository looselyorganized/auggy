import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyAdminBuild } from "../scripts/verify-build";
import {
  createLoginArtifactEntry,
  createLoginManifest,
  LOGIN_HTML_PATHS,
  LOGIN_MANIFEST_FILENAME,
  renderLoginDocument,
  serializeLoginManifest,
} from "../scripts/login-artifacts";
import { LOGIN_VARIANTS } from "./LoginPage";

const roots = new Set<string>();
const LOGIN_STYLESHEET_PATH = "assets/login-AbCd1234.css";
const LOGIN_STYLESHEET = ":root{color-scheme:dark}\n";

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function createAdminBuildFixture(): string {
  const distRoot = mkdtempSync(join(tmpdir(), "auggy-admin-build-"));
  roots.add(distRoot);
  const files: Record<string, string> = {
    "assets/index-AbCd1234.js": "console.log('console entry');\n",
    "assets/index-AbCd1234.css": ":root{color-scheme:dark}\n",
    "brand/a1-logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    "brand/auggy-wave.png": "fixture-wave",
    "brand/auggy-white.png": "fixture-white",
    "index.html": `<!doctype html>
<html lang="en"><head><script type="module" src="/console/assets/index-AbCd1234.js"></script><link rel="stylesheet" href="/console/assets/index-AbCd1234.css"></head><body><div id="root"></div></body></html>
`,
  };
  for (const [path, content] of Object.entries(files)) writeFixtureFile(distRoot, path, content);

  const loginRoot = join(distRoot, "login");
  const entries = [createLoginArtifactEntry("stylesheet", LOGIN_STYLESHEET_PATH, LOGIN_STYLESHEET)];
  writeFixtureFile(loginRoot, LOGIN_STYLESHEET_PATH, LOGIN_STYLESHEET);
  for (const variant of LOGIN_VARIANTS) {
    const document = renderLoginDocument(variant, LOGIN_STYLESHEET_PATH);
    const path = LOGIN_HTML_PATHS[variant];
    writeFixtureFile(loginRoot, path, document);
    entries.push(createLoginArtifactEntry(variant, path, document));
  }
  writeFixtureFile(
    loginRoot,
    LOGIN_MANIFEST_FILENAME,
    serializeLoginManifest(createLoginManifest(entries)),
  );
  return distRoot;
}

function writeFixtureFile(root: string, path: string, content: string): void {
  const destination = join(root, ...path.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

describe("admin package build verification", () => {
  test("accepts a complete SPA and fixed no-JavaScript login bundle", () => {
    const distRoot = createAdminBuildFixture();

    expect(() => verifyAdminBuild(distRoot)).not.toThrow();
  });

  test("rejects incomplete, stale, remote, and corrupt output", () => {
    {
      const distRoot = createAdminBuildFixture();
      unlinkSync(join(distRoot, "assets/index-AbCd1234.js"));
      expect(() => verifyAdminBuild(distRoot)).toThrow("missing or unsafe asset");
    }
    {
      const distRoot = createAdminBuildFixture();
      writeFixtureFile(distRoot, "assets/index-AbCd1234.js.map", "{}\n");
      expect(() => verifyAdminBuild(distRoot)).toThrow("must not contain source maps");
    }
    {
      const distRoot = createAdminBuildFixture();
      const indexPath = join(distRoot, "index.html");
      writeFileSync(
        indexPath,
        readFileSync(indexPath, "utf8").replace(
          "</head>",
          '<script src="https://attacker.example/script.js"></script></head>',
        ),
      );
      expect(() => verifyAdminBuild(distRoot)).toThrow("unexpected resource");
    }
    {
      const distRoot = createAdminBuildFixture();
      const loginDocument = join(distRoot, "login/default.html");
      writeFileSync(loginDocument, `${readFileSync(loginDocument, "utf8")}corrupt`);
      expect(() => verifyAdminBuild(distRoot)).toThrow("integrity check failed");
    }
  });

  test("makes direct npm packing rebuild and verify ignored Console output", () => {
    const rootPackage = JSON.parse(
      readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const adminPackage = JSON.parse(
      readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(rootPackage.scripts?.prepack).toBe("bun scripts/prepack.ts");
    expect(rootPackage.scripts?.["verify:admin"]).toBe("bun run --cwd admin verify:build");
    expect(adminPackage.scripts?.build).toEndWith(
      "bun scripts/build-login.ts && bun scripts/verify-build.ts",
    );
    expect(adminPackage.scripts?.["verify:build"]).toBe("bun scripts/verify-build.ts");
  });
});
