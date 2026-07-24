import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TEMPLATES_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "scaffold-starter-skills",
  "auggy",
  "assets",
  "templates",
);
const AUTH_ROOT = join(TEMPLATES_ROOT, "app-auth-bridge");
const REFERENCES_ROOT = join(TEMPLATES_ROOT, "..", "..", "references");

type AssertionSecurityModule = {
  assertionJson(body: unknown, status?: number): Response;
  assertionMethodNotAllowed(): Response;
  requireCookieAssertionRequest(request: Request, expectedOrigin?: string): Response | null;
};

let security: AssertionSecurityModule;
let executableDirectory: string | undefined;

beforeAll(async () => {
  const source = readFileSync(join(AUTH_ROOT, "assertion-response.ts.txt"), "utf8");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const javascript = transpiler.transformSync(source);
  executableDirectory = mkdtempSync(join(tmpdir(), "auggy-auth-bridge-template-"));
  const executablePath = join(executableDirectory, "assertion-response.mjs");
  writeFileSync(executablePath, javascript, { mode: 0o600 });
  security = (await import(pathToFileURL(executablePath).href)) as AssertionSecurityModule;
});

afterAll(() => {
  if (executableDirectory) rmSync(executableDirectory, { recursive: true, force: true });
});

function cookieRequest(
  origin = "https://app.example.test",
  csrf = "1",
  fetchSite = "same-origin",
): Request {
  return new Request("https://internal.invalid/api/auggy-auth-assertion", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": fetchSite,
      "x-auggy-csrf-request": csrf,
    },
  });
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")).toContain("Cookie");
  expect(response.headers.get("vary")).toContain("Authorization");
}

describe("generated app-auth bridge assertion boundary", () => {
  test("success, denial, and method responses are non-cacheable", async () => {
    const success = security.assertionJson({ assertion: "signed" });
    expect(success.status).toBe(200);
    expectNoStore(success);

    const denied = security.requireCookieAssertionRequest(
      cookieRequest("https://evil.example.test"),
      "https://app.example.test",
    );
    expect(denied?.status).toBe(403);
    expectNoStore(denied!);

    const method = security.assertionMethodNotAllowed();
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    expectNoStore(method);
  });

  test("cookie-authenticated assertion minting requires exact origin and a custom CSRF header", () => {
    expect(
      security.requireCookieAssertionRequest(cookieRequest(), "https://app.example.test"),
    ).toBeNull();
    expect(
      security.requireCookieAssertionRequest(
        cookieRequest("https://app.example.test", ""),
        "https://app.example.test",
      )?.status,
    ).toBe(403);
    expect(
      security.requireCookieAssertionRequest(
        cookieRequest("https://app.example.test", "1", "cross-site"),
        "https://app.example.test",
      )?.status,
    ).toBe(403);
    expect(security.requireCookieAssertionRequest(cookieRequest(), undefined)?.status).toBe(503);
  });

  test("every assertion route is POST-only and uses the non-cacheable response helper", () => {
    for (const filename of [
      "next-route.ts.txt",
      "clerk-next-route.ts.txt",
      "custom-session-next-route.ts.txt",
      "supabase-next-route.ts.txt",
    ]) {
      const source = readFileSync(join(AUTH_ROOT, filename), "utf8");
      expect(source).toContain("export async function POST");
      expect(source).toContain("export function GET");
      expect(source).toContain("assertionMethodNotAllowed");
      expect(source).toContain("assertionJson");
      expect(source).not.toContain("Response.json");
    }
  });

  test("cookie routes enforce CSRF before session verification", () => {
    for (const filename of [
      "next-route.ts.txt",
      "clerk-next-route.ts.txt",
      "custom-session-next-route.ts.txt",
    ]) {
      const source = readFileSync(join(AUTH_ROOT, filename), "utf8");
      expect(source.indexOf("requireCookieAssertionRequest")).toBeLessThan(
        source.indexOf("verify"),
      );
    }
  });

  test("browser and transport templates enable request and replay protections", () => {
    const browser = readFileSync(
      join(TEMPLATES_ROOT, "nextjs-browser-client", "service-search.tsx.txt"),
      "utf8",
    );
    expect(browser).toContain('method: "POST"');
    expect(browser).toContain('cache: "no-store"');
    expect(browser).toContain('"x-auggy-csrf-request": "1"');

    const transport = readFileSync(join(AUTH_ROOT, "webtransport-external-auth.ts.txt"), "utf8");
    expect(transport).toContain("ExternalAuthReplayStore");
    expect(transport).toContain("replayProtection: { enabled: true, store: replayStore }");

    const yaml = readFileSync(join(AUTH_ROOT, "webtransport-external-auth.yaml.txt"), "utf8");
    expect(yaml).toContain("enabled: true");
    expect(yaml).toContain("fail closed");
  });

  test("shipped reference recipes preserve the assertion security boundary", () => {
    for (const filename of ["generated-clients.md", "nextjs-integration.md"]) {
      const source = readFileSync(join(REFERENCES_ROOT, filename), "utf8");
      expect(source).toContain('fetch("/api/auggy-auth-assertion", {');
      expect(source).toContain('method: "POST"');
      expect(source).toContain('cache: "no-store"');
      expect(source).toContain('"x-auggy-csrf-request": "1"');
      expect(source).toContain("as { assertion?: unknown }");
      expect(source).toContain('typeof body.assertion === "string"');
      expect(source).not.toContain(
        'fetch("/api/auggy-auth-assertion", { credentials: "include" })',
      );
    }

    const next = readFileSync(join(REFERENCES_ROOT, "nextjs-integration.md"), "utf8");
    for (const template of [
      "app-auth-bridge/next-route.ts.txt",
      "app-auth-bridge/assertion-response.ts.txt",
      "app-auth-bridge/app-policy.ts.txt",
    ]) {
      expect(next).toContain(template);
    }
    expect(next).toContain("POST-only");
    expect(next).toContain("Origin");
    expect(next).toContain("CSRF");
    expect(next).toContain("no-store");
    expect(next).not.toContain("export async function GET()");
    expect(next).not.toContain("return Response.json({ assertion });");

    const trust = readFileSync(join(REFERENCES_ROOT, "authz-memory-trust.md"), "utf8");
    expect(trust).toContain("replayProtection: { enabled: true, store: sharedReplayStore }");
    expect(trust).toContain("never supplies an implicit replay store");
  });
});
