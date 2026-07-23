import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TEMPLATE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "scaffold-starter-skills",
  "auggy",
  "assets",
  "templates",
  "nextjs-server-client",
  "admin-reindex-route.ts.txt",
);

type VerifiedOperatorSession = {
  subject: string;
  roles: readonly string[];
};

type AdminClient = {
  post: (
    path: string,
    input: { body: { reason: string } },
  ) => Promise<{ ok: boolean; status: number; data: unknown }>;
};

type HandlerDependencies = {
  expectedOrigin: () => string | undefined;
  verifySession: (request: Request) => Promise<VerifiedOperatorSession | null>;
  verifyCsrfToken: (
    request: Request,
    session: VerifiedOperatorSession,
    token: string,
  ) => Promise<boolean>;
  getClient: () => AdminClient;
};

type TemplateModule = {
  POST: (request: Request) => Promise<Response>;
  createAdminReindexHandler: (
    dependencies: HandlerDependencies,
  ) => (request: Request) => Promise<Response>;
};

let template: TemplateModule;
let defaultClientResolutions = 0;
let executableDirectory: string | undefined;

beforeAll(async () => {
  const source = readFileSync(TEMPLATE_PATH, "utf8");
  const executableSource = source.replace('import "server-only";', "").replace(
    'import { createAuggyClient } from "@/src/auggy-client.server";',
    `const createAuggyClient = () => {
        globalThis.__auggyAdminTemplateClientResolutions += 1;
        return {
          post: async () => ({ ok: true, status: 200, data: { queued: true } }),
        };
      };`,
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const javascript = transpiler.transformSync(executableSource);
  executableDirectory = mkdtempSync(join(tmpdir(), "auggy-admin-template-"));
  const executablePath = join(executableDirectory, "route.mjs");
  writeFileSync(executablePath, javascript, { mode: 0o600 });

  Object.assign(globalThis, {
    __auggyAdminTemplateClientResolutions: 0,
  });
  template = (await import(pathToFileURL(executablePath).href)) as TemplateModule;
  defaultClientResolutions = (
    globalThis as typeof globalThis & { __auggyAdminTemplateClientResolutions: number }
  ).__auggyAdminTemplateClientResolutions;
});

afterAll(() => {
  if (executableDirectory) rmSync(executableDirectory, { recursive: true, force: true });
});

function request(origin = "https://app.example.com", csrf = "csrf-token-at-least-16-chars") {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (csrf) headers.set("x-csrf-token", csrf);
  return new Request("https://internal.invalid/api/admin/reindex", {
    method: "POST",
    headers,
  });
}

function makeHarness(overrides: Partial<HandlerDependencies> = {}): HandlerDependencies & {
  events: string[];
  clientCalls: Array<{ path: string; input: { body: { reason: string } } }>;
} {
  const events: string[] = [];
  const clientCalls: Array<{ path: string; input: { body: { reason: string } } }> = [];

  return {
    events,
    clientCalls,
    expectedOrigin: () => {
      events.push("origin-config");
      return "https://app.example.com";
    },
    verifySession: async () => {
      events.push("session");
      return { subject: "user-1", roles: ["admin"] };
    },
    verifyCsrfToken: async () => {
      events.push("csrf");
      return true;
    },
    getClient: () => {
      events.push("client");
      return {
        post: async (path, input) => {
          events.push("reindex");
          clientCalls.push({ path, input });
          return { ok: true, status: 200, data: { queued: true } };
        },
      };
    },
    ...overrides,
  };
}

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(response.headers.get("cache-control")).toContain("no-store");
}

describe("generated Next.js admin reindex route", () => {
  test("the shipped default is fail closed before resolving server credentials", async () => {
    expect(typeof template.createAdminReindexHandler).toBe("function");
    const response = await template.POST(request());

    await expectError(response, 503, "admin_origin_unavailable");
    expect(
      (
        globalThis as typeof globalThis & {
          __auggyAdminTemplateClientResolutions: number;
        }
      ).__auggyAdminTemplateClientResolutions,
    ).toBe(defaultClientResolutions);
  });

  test("rejects anonymous, malformed, non-admin, and mixed-case role sessions", async () => {
    for (const session of [
      null,
      { subject: "", roles: ["admin"] },
      { subject: "user-1", roles: [] },
      { subject: "user-1", roles: ["member"] },
      { subject: "user-1", roles: ["Admin"] },
      { subject: "user-1", roles: "admin" },
    ] as const) {
      const harness = makeHarness({
        verifySession: async () => session as VerifiedOperatorSession | null,
      });
      const response = await template.createAdminReindexHandler(harness)(request());

      expect([401, 403, 503]).toContain(response.status);
      expect(harness.events).not.toContain("client");
      expect(harness.clientCalls).toHaveLength(0);
    }
  });

  test("rejects missing, malformed, null, and inexact origins before authentication", async () => {
    for (const [configured, supplied] of [
      [undefined, "https://app.example.com"],
      ["not a URL", "https://app.example.com"],
      ["https://app.example.com/path", "https://app.example.com"],
      ["https://app.example.com", ""],
      ["https://app.example.com", "null"],
      ["https://app.example.com", "http://app.example.com"],
      ["https://app.example.com", "https://app.example.com:444"],
      ["https://app.example.com", "https://app.example.com.evil"],
      ["https://app.example.com", "https://app.example.com, https://evil.example"],
    ] as const) {
      const harness = makeHarness({
        expectedOrigin: () => configured,
      });
      const response = await template.createAdminReindexHandler(harness)(request(supplied));

      expect([403, 503]).toContain(response.status);
      expect(harness.events).not.toContain("session");
      expect(harness.events).not.toContain("client");
    }
  });

  test("requires a bounded session-bound CSRF token on every request", async () => {
    let accepted = false;
    const harness = makeHarness({
      verifyCsrfToken: async () => {
        if (accepted) return false;
        accepted = true;
        return true;
      },
    });
    const handler = template.createAdminReindexHandler(harness);

    const missing = await handler(request("https://app.example.com", ""));
    await expectError(missing, 403, "csrf_denied");
    const first = await handler(request());
    expect(first.status).toBe(200);
    const replay = await handler(request());
    await expectError(replay, 403, "csrf_denied");
    expect(harness.clientCalls).toHaveLength(1);
  });

  test("allows exact admin and operator roles only after every gate", async () => {
    for (const role of ["admin", "operator"] as const) {
      const harness = makeHarness();
      harness.verifySession = async () => {
        harness.events.push("session");
        return { subject: `user-${role}`, roles: [role] };
      };
      const response = await template.createAdminReindexHandler(harness)(request());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ queued: true });
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(harness.events).toEqual(["origin-config", "session", "csrf", "client", "reindex"]);
      expect(harness.clientCalls).toEqual([
        {
          path: "/admin/reindex",
          input: { body: { reason: "manual-refresh" } },
        },
      ]);
    }
  });

  test("sanitizes verifier and downstream failures", async () => {
    const sentinel = "sk-test-do-not-leak";
    const cases: Array<{
      overrides: Partial<HandlerDependencies>;
      status: number;
      error: string;
    }> = [
      {
        overrides: {
          verifySession: async () => {
            throw new Error(sentinel);
          },
        },
        status: 503,
        error: "operator_auth_unavailable",
      },
      {
        overrides: {
          verifyCsrfToken: async () => {
            throw new Error(sentinel);
          },
        },
        status: 503,
        error: "csrf_unavailable",
      },
      {
        overrides: {
          getClient: () => ({
            post: async () => {
              throw new Error(sentinel);
            },
          }),
        },
        status: 502,
        error: "reindex_unavailable",
      },
      {
        overrides: {
          getClient: () => ({
            post: async () => ({ ok: false, status: 403, data: { detail: sentinel } }),
          }),
        },
        status: 403,
        error: "reindex_failed",
      },
    ];

    for (const { overrides, status, error } of cases) {
      const response = await template.createAdminReindexHandler(makeHarness(overrides))(request());
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(body).toBe(JSON.stringify({ error }));
      expect(body).not.toContain(sentinel);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  test("keeps the credential-bearing template server-only", () => {
    const source = readFileSync(TEMPLATE_PATH, "utf8");
    expect(source).toContain('import "server-only";');
    expect(source).not.toContain("NEXT_PUBLIC_");
  });
});
