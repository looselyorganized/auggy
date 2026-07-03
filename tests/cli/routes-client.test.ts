import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createTypeScriptClient,
  type ClientRoutesReport,
  type TypeScriptClientTarget,
} from "../../src/cli/routes-client";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface LoadedClient {
  createAuggyClient(config: Record<string, unknown>): {
    get(
      path: string,
      input?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<{ ok: boolean; status: number; data: unknown; visitorToken?: string }>;
    post(
      path: string,
      input?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<{ ok: boolean; status: number; data: unknown; visitorToken?: string }>;
  };
}

function report(): ClientRoutesReport {
  return {
    agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
    summary: {
      totalRoutes: 4,
      publicRoutes: 1,
      privateRoutes: 3,
      publicRoutePaths: ["GET /services/:serviceId"],
    },
    routes: [
      {
        method: "GET",
        path: "/services/:serviceId",
        augmentName: "concierge-services",
        auth: "none",
        params: ["serviceId"],
        public: true,
        security: "public",
        requestJsonSchema: {
          params: {
            type: "object",
            properties: { serviceId: { type: "string" } },
            required: ["serviceId"],
          },
          query: {
            type: "object",
            properties: {
              need: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              urgent: { type: "boolean" },
            },
            required: ["need"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            serviceId: { type: "string" },
            name: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["serviceId", "name"],
        },
      },
      {
        method: "POST",
        path: "/leads/:leadId/notes",
        augmentName: "concierge-services",
        auth: "bearer",
        params: ["leadId"],
        public: false,
        security: "private",
        requestJsonSchema: {
          params: {
            type: "object",
            properties: { leadId: { type: "string" } },
            required: ["leadId"],
          },
          body: {
            type: "object",
            properties: {
              note: { type: "string" },
              priority: { enum: ["low", "high"] },
              score: { type: ["number", "null"] },
            },
            required: ["note"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            noteId: { type: "string" },
            saved: { type: "boolean" },
          },
          required: ["noteId", "saved"],
        },
      },
      {
        method: "GET",
        path: "/me",
        augmentName: "visitor-profile",
        auth: "visitor.required",
        params: [],
        public: false,
        security: "private",
      },
      {
        method: "GET",
        path: "/agent-api/search",
        augmentName: "agent-api",
        auth: "agent.required",
        params: [],
        public: false,
        security: "private",
      },
    ],
  };
}

function clientFixtureReport(): ClientRoutesReport {
  return {
    agent: { name: "fixtures", configPath: "/tmp/fixtures/agent.yaml" },
    summary: {
      totalRoutes: 9,
      publicRoutes: 6,
      privateRoutes: 3,
      publicRoutePaths: [
        "GET /catalog/summary",
        "GET /health",
        "GET /services",
        "GET /search",
        "GET /services/:serviceId",
        "POST /profile",
      ],
    },
    routes: [
      {
        method: "GET",
        path: "/catalog/summary",
        augmentName: "catalog",
        auth: "none",
        params: [],
        public: true,
        security: "public",
        responseJsonSchema: {
          allOf: [
            {
              type: "object",
              properties: {
                status: { enum: ["fresh", "stale"] },
                tags: { type: "array", items: { type: "string" } },
              },
              required: ["status", "tags"],
            },
            {
              type: "object",
              properties: {
                totals: {
                  type: "object",
                  additionalProperties: { type: "integer" },
                },
                nextCursor: { type: ["string", "null"] },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      details: {
                        type: "object",
                        properties: {
                          rating: { type: "number" },
                          labels: {
                            type: "array",
                            items: { enum: ["new", "popular"] },
                          },
                        },
                        required: ["rating"],
                      },
                    },
                    required: ["id"],
                  },
                },
              },
              required: ["totals", "items"],
            },
          ],
        },
      },
      {
        method: "GET",
        path: "/health",
        augmentName: "health",
        auth: "none",
        params: [],
        public: true,
        security: "public",
      },
      {
        method: "GET",
        path: "/services",
        augmentName: "catalog",
        auth: "none",
        params: [],
        public: true,
        security: "public",
        requestJsonSchema: {
          query: {
            type: "object",
            properties: {
              category: { type: "string" },
            },
          },
        },
      },
      {
        method: "GET",
        path: "/search",
        augmentName: "catalog",
        auth: "none",
        params: [],
        public: true,
        security: "public",
        requestJsonSchema: {
          query: {
            type: "object",
            properties: {
              q: { type: "string" },
            },
            required: ["q"],
          },
        },
      },
      {
        method: "GET",
        path: "/services/:serviceId",
        augmentName: "catalog",
        auth: "none",
        params: ["serviceId"],
        public: true,
        security: "public",
        requestJsonSchema: {
          params: {
            type: "object",
            properties: { serviceId: { type: "string" } },
            required: ["serviceId"],
          },
          query: {
            type: "object",
            properties: {
              need: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["need"],
          },
        },
      },
      {
        method: "GET",
        path: "/me",
        augmentName: "visitor-profile",
        auth: "visitor.required",
        params: [],
        public: false,
        security: "private",
      },
      {
        method: "POST",
        path: "/profile",
        augmentName: "visitor-profile",
        auth: "visitor.optional",
        params: [],
        public: true,
        security: "public",
        requestJsonSchema: {
          body: {
            type: "object",
            properties: {
              displayName: { type: "string" },
            },
            required: ["displayName"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            visitorId: { type: "string" },
            displayName: { type: "string" },
          },
          required: ["visitorId", "displayName"],
        },
      },
      {
        method: "POST",
        path: "/admin/reindex",
        augmentName: "catalog",
        auth: "creator",
        params: [],
        public: false,
        security: "private",
        requestJsonSchema: {
          body: {
            type: "object",
            properties: {
              reason: { type: "string" },
            },
            required: ["reason"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            queued: { type: "boolean" },
            jobId: { type: "string" },
          },
          required: ["queued", "jobId"],
        },
      },
      {
        method: "GET",
        path: "/agent-api/search",
        augmentName: "agent-api",
        auth: "agent.required",
        params: [],
        public: false,
        security: "private",
        requestJsonSchema: {
          query: {
            type: "object",
            properties: {
              q: { type: "string" },
            },
            required: ["q"],
          },
        },
      },
    ],
  };
}

async function loadGeneratedClient(source: string): Promise<LoadedClient> {
  const root = mkdtempSync(join(tmpdir(), "routes-client-runtime-test-"));
  roots.push(root);
  const file = join(root, "client.mjs");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  writeFileSync(file, js);
  return (await import(pathToFileURL(file).href)) as LoadedClient;
}

async function expectGeneratedClientTypechecks(
  name: string,
  clientReport: ClientRoutesReport,
  target?: TypeScriptClientTarget,
  usageSource?: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `routes-client-tsc-test-${name}-`));
  roots.push(root);
  const clientPath = join(root, "client.ts");
  const tsconfigPath = join(root, "tsconfig.json");

  writeFileSync(clientPath, createTypeScriptClient(clientReport, { target }));
  if (usageSource) {
    writeFileSync(join(root, "usage.ts"), usageSource);
  }
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2022", "DOM"],
          target: "ES2022",
          module: "ESNext",
          strict: true,
          noEmit: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
        },
        include: usageSource ? ["client.ts", "usage.ts"] : ["client.ts"],
      },
      null,
      2,
    ),
  );

  const proc = Bun.spawn(["bunx", "tsc", "-p", tsconfigPath], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}

function practicalBrowserUsageFixture(): string {
  return `
    import { createAuggyClient } from "./client";

    const api = createAuggyClient({
      baseUrl: "https://agent.example",
      visitorToken: () => {
        const token = sessionStorage.getItem("auggy-visitor-token");
        return token ?? undefined;
      },
      authAssertion: async () => {
        const token = sessionStorage.getItem("auggy-auth-assertion");
        return token ?? undefined;
      },
      onVisitorToken: (token) => {
        sessionStorage.setItem("auggy-visitor-token", token);
      },
    });

    async function renderCatalog() {
      const health = await api.get("/health");
      if (!health.ok) return;

      await api.get("/services");
      await api.get("/services", { query: { category: "hair" } });
    }

    async function loadProfile() {
      const profile = await api.get("/me");
      if (profile.ok) {
        const data: unknown = profile.data;
        console.log(data);
      }
    }

    async function updateProfile(displayName: string) {
      const result = await api.post("/profile", { body: { displayName } });
      if (result.ok) {
        result.data.visitorId.toUpperCase();
        result.data.displayName.toUpperCase();
      }
    }

    renderCatalog();
    loadProfile();
    updateProfile("Alice");

    // @ts-expect-error browser target omits creator/bearer/agent routes.
    api.post("/admin/reindex", { body: { reason: "manual" } });
    // @ts-expect-error browser target omits agent routes.
    api.get("/agent-api/search", { query: { q: "inventory" } });
    // @ts-expect-error required query routes still require input.
    api.get("/search");
  `;
}

function practicalServerUsageFixture(): string {
  return `
    import { createAuggyClient } from "./client";

    const api = createAuggyClient({
      baseUrl: "https://agent.example",
      bearerToken: async () => "creator-secret",
      agentCredentials: () => ({ agentId: "worker-agent", agentSecret: "agent-secret" }),
    });

    async function reindexCatalog() {
      const result = await api.post("/admin/reindex", {
        body: { reason: "manual" },
      });
      if (result.ok) {
        result.data.jobId.toUpperCase();
        result.data.queued.valueOf();
      }
    }

    reindexCatalog();

    // Public routes are usable from the server client too.
    api.get("/health");
    api.get("/services", { query: { category: "hair" } });
    api.get("/agent-api/search", { query: { q: "inventory" } });

    // @ts-expect-error server target omits visitor-token routes.
    api.get("/me");
    // @ts-expect-error server target omits visitor-token POST routes.
    api.post("/profile", { body: { displayName: "Alice" } });
  `;
}

describe("createTypeScriptClient", () => {
  test("generates a browser TypeScript client from a route manifest by default", () => {
    const source = createTypeScriptClient(report());

    expect(source).toContain("Generated by auggy routes --client ts v0.");
    expect(source).toContain("Target: browser.");
    expect(source).toContain("Browser clients omit creator/bearer/agent routes");
    expect(source).toContain("export type AuggyClientResult<TData = unknown> =");
    expect(source).toContain(
      "| { ok: true; status: number; data: TData; response: Response; visitorToken?: string }",
    );
    expect(source).toContain(
      "| { ok: false; status: number; data: unknown; response: Response; visitorToken?: string };",
    );
    expect(source).toContain(": {} extends TInput");
    expect(source).toContain("export interface AuggyGetInputs");
    expect(source).toContain(
      '"/services/:serviceId": { params: { serviceId: string; }; query: { need: string; tags?: Array<string>; urgent?: boolean; }; };',
    );
    expect(source).toContain("export interface AuggyGetOutputs");
    expect(source).toContain(
      '"/services/:serviceId": { serviceId: string; name: string; tags?: Array<string>; };',
    );
    expect(source).toContain('"/me": unknown;');
    expect(source).toContain('"/me": {};');
    expect(source).not.toContain('"/leads/:leadId/notes":');
    expect(source).not.toContain('"/agent-api/search":');
    expect(source).not.toContain("bearerToken?: TokenProvider;");
    expect(source).not.toContain("agentCredentials?: AgentCredentialsProvider;");
    expect(source).toContain("visitorToken?: TokenProvider;");
    expect(source).toContain("authAssertion?: TokenProvider;");
    expect(source).toContain('headers.set("x-auggy-auth-assertion", credentials.authAssertion);');
    expect(source).toContain("requires a visitorToken or authAssertion");
    expect(source).toContain('"GET /services/:serviceId":');
    expect(source).toContain('auth: "visitor.required"');
    expect(source).toContain("export function createAuggyClient");
    expect(source).toContain("export type AuggyClient = ReturnType<typeof createAuggyClient>;");
    expect(source).toContain(
      "export type AuggyGetResult<Path extends AuggyGetPath> = AuggyClientResult<AuggyGetOutputs[Path]>;",
    );
    expect(source).toContain(
      "export type AuggyPostResult<Path extends AuggyPostPath> = AuggyClientResult<AuggyPostOutputs[Path]>;",
    );

    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    expect(js).toContain("function createAuggyClient");
  });

  test("generates a server TypeScript client with bearer routes", () => {
    const source = createTypeScriptClient(report(), { target: "server" });

    expect(source).toContain("Target: server.");
    expect(source).toContain("Server clients include creator/bearer and agent routes");
    expect(source).toContain(
      '"/leads/:leadId/notes": { params: { leadId: string; }; body: { note: string; priority?: "low" | "high"; score?: number | null; }; };',
    );
    expect(source).toContain('"/leads/:leadId/notes": { noteId: string; saved: boolean; };');
    expect(source).toContain('"/agent-api/search": {};');
    expect(source).toContain("bearerToken?: TokenProvider;");
    expect(source).toContain("agentCredentials?: AgentCredentialsProvider;");
    expect(source).toContain("x-agent-id");
    expect(source).toContain("x-agent-secret");
    expect(source).not.toContain("visitorToken?: TokenProvider;");
    expect(source).not.toContain("authAssertion?: TokenProvider;");
    expect(source).not.toContain("x-auggy-auth-assertion");
    expect(source).not.toContain('"/me": {};');
    expect(source).toContain("Routes omitted for this target:");
    expect(source).toContain("* - GET /me auth=visitor.required");
  });

  test("emits empty input maps for agents with no routes", () => {
    const source = createTypeScriptClient({
      agent: { name: "empty", configPath: "/tmp/empty/agent.yaml" },
      summary: {
        totalRoutes: 0,
        publicRoutes: 0,
        privateRoutes: 0,
        publicRoutePaths: [],
      },
      routes: [],
    });

    expect(source).toContain("export interface AuggyGetInputs {}");
    expect(source).toContain("export interface AuggyPostInputs {}");
    expect(source).toContain("export interface AuggyGetOutputs {}");
    expect(source).toContain("export interface AuggyPostOutputs {}");
    expect(source).toContain("const ROUTES: Record<string, RouteMeta> = {\n};");
  });

  test("emits clients that typecheck for empty, auth-subset, and no-input usage", async () => {
    const emptyReport: ClientRoutesReport = {
      agent: { name: "empty", configPath: "/tmp/empty/agent.yaml" },
      summary: {
        totalRoutes: 0,
        publicRoutes: 0,
        privateRoutes: 0,
        publicRoutePaths: [],
      },
      routes: [],
    };
    const bearerOnlyReport: ClientRoutesReport = {
      agent: { name: "private", configPath: "/tmp/private/agent.yaml" },
      summary: {
        totalRoutes: 2,
        publicRoutes: 1,
        privateRoutes: 1,
        publicRoutePaths: ["GET /services/:serviceId"],
      },
      routes: [
        {
          method: "GET",
          path: "/services/:serviceId",
          augmentName: "concierge-services",
          auth: "none",
          params: ["serviceId"],
          public: true,
          security: "public",
          requestJsonSchema: {
            params: {
              type: "object",
              properties: { serviceId: { type: "string" } },
              required: ["serviceId"],
            },
          },
        },
        {
          method: "POST",
          path: "/leads",
          augmentName: "concierge-services",
          auth: "bearer",
          params: [],
          public: false,
          security: "private",
          requestJsonSchema: {
            body: {
              type: "object",
              properties: { email: { type: "string" } },
              required: ["email"],
            },
          },
        },
      ],
    };

    await expectGeneratedClientTypechecks("empty-browser", emptyReport, "browser");
    await expectGeneratedClientTypechecks("empty-server", emptyReport, "server");
    await expectGeneratedClientTypechecks("bearer-server", bearerOnlyReport, "server");
    await expectGeneratedClientTypechecks(
      "visitor-browser",
      report(),
      "browser",
      `
        import { createAuggyClient } from "./client";

        const api = createAuggyClient({ baseUrl: "https://agent.example" });
        const assertionApi = createAuggyClient({
          baseUrl: "https://agent.example",
          authAssertion: async () => "app-assertion",
        });

        api.get("/me");
        api.get("/me", { headers: { "x-test": "1" } });
        assertionApi.get("/me");
        async function main() {
          const service = await api.get("/services/:serviceId", {
            params: { serviceId: "svc_123" },
            query: { need: "trim" },
          });
          // @ts-expect-error typed response data requires ok narrowing.
          service.data.name;
          if (service.ok) {
            service.data.name.toUpperCase();
            service.data.tags?.[0]?.toUpperCase();
          } else {
            const failedData: unknown = service.data;
            console.log(failedData);
            // @ts-expect-error failed result data is unknown.
            service.data.name;
          }

          const me = await api.get("/me");
          if (me.ok) {
            const unknownMeData: unknown = me.data;
            console.log(unknownMeData);
            // @ts-expect-error routes without response schemas keep unknown data.
            me.data.email;
          }
        }

        api.get("/services/:serviceId", {
          params: { serviceId: "svc_123" },
          query: { need: "trim" },
        });

        // @ts-expect-error input is required for routes with params/query.
        api.get("/services/:serviceId");
      `,
    );
  });

  test("typechecks generated public contract aliases", async () => {
    await expectGeneratedClientTypechecks(
      "contract-aliases-browser",
      clientFixtureReport(),
      "browser",
      `
        import {
          createAuggyClient,
          type AuggyClient,
          type AuggyGetResult,
          type AuggyPostResult,
        } from "./client";

        const api: AuggyClient = createAuggyClient({
          baseUrl: "https://agent.example",
          visitorToken: () => "visitor-token",
        });

        async function main() {
          const health: AuggyGetResult<"/health"> = await api.get("/health");
          if (health.ok) {
            const healthData: unknown = health.data;
            console.log(healthData);
          }

          const profile: AuggyPostResult<"/profile"> = await api.post("/profile", {
            body: { displayName: "Alice" },
          });
          if (profile.ok) {
            profile.data.visitorId.toUpperCase();
            profile.data.displayName.toUpperCase();
          } else {
            const failedData: unknown = profile.data;
            console.log(failedData);
          }
        }

        // @ts-expect-error browser target omits bearer POST result paths.
        type AdminResult = AuggyPostResult<"/admin/reindex">;
        // @ts-expect-error browser target omits agent GET result paths.
        type AgentResult = AuggyGetResult<"/agent-api/search">;
        // @ts-expect-error unknown route paths are not part of result aliases.
        type MissingResult = AuggyGetResult<"/missing">;
      `,
    );

    await expectGeneratedClientTypechecks(
      "contract-aliases-server",
      clientFixtureReport(),
      "server",
      `
        import {
          createAuggyClient,
          type AuggyClient,
          type AuggyGetResult,
          type AuggyPostResult,
        } from "./client";

        const api: AuggyClient = createAuggyClient({
          baseUrl: "https://agent.example",
          bearerToken: "creator-secret",
          agentCredentials: { agentId: "worker-agent", agentSecret: "agent-secret" },
        });

        async function main() {
          const services: AuggyGetResult<"/services"> = await api.get("/services");
          if (services.ok) {
            const servicesData: unknown = services.data;
            console.log(servicesData);
          }

          const reindex: AuggyPostResult<"/admin/reindex"> = await api.post("/admin/reindex", {
            body: { reason: "manual" },
          });
          if (reindex.ok) {
            reindex.data.jobId.toUpperCase();
            reindex.data.queued.valueOf();
          } else {
            const failedData: unknown = reindex.data;
            console.log(failedData);
          }

          const agentSearch: AuggyGetResult<"/agent-api/search"> = await api.get(
            "/agent-api/search",
            { query: { q: "inventory" } },
          );
          if (agentSearch.ok) {
            const agentSearchData: unknown = agentSearch.data;
            console.log(agentSearchData);
          }
        }

        // @ts-expect-error server target omits visitor POST result paths.
        type ProfileResult = AuggyPostResult<"/profile">;
        // @ts-expect-error server target omits visitor GET result paths.
        type MeResult = AuggyGetResult<"/me">;
      `,
    );
  });

  test("typechecks practical browser and server app usage fixtures", async () => {
    await expectGeneratedClientTypechecks(
      "practical-browser-app",
      clientFixtureReport(),
      "browser",
      practicalBrowserUsageFixture(),
    );
    await expectGeneratedClientTypechecks(
      "practical-server-app",
      clientFixtureReport(),
      "server",
      practicalServerUsageFixture(),
    );
  });

  test("typechecks composed response schemas", async () => {
    await expectGeneratedClientTypechecks(
      "composed-response-schema-browser",
      clientFixtureReport(),
      "browser",
      `
        import { createAuggyClient, type AuggyGetResult } from "./client";

        const api = createAuggyClient({ baseUrl: "https://agent.example" });

        async function main() {
          const summary: AuggyGetResult<"/catalog/summary"> = await api.get("/catalog/summary");
          // @ts-expect-error typed response data requires ok narrowing.
          summary.data.status;
          if (summary.ok) {
            const status: "fresh" | "stale" = summary.data.status;
            summary.data.tags[0]?.toUpperCase();
            const total = summary.data.totals.services;
            total?.toFixed();
            summary.data.items[0]?.id.toUpperCase();
            summary.data.items[0]?.details?.rating.toFixed();
            const label: "new" | "popular" | undefined =
              summary.data.items[0]?.details?.labels?.[0];
            const cursor: string | null | undefined = summary.data.nextCursor;
            console.log(status, label, cursor);

            // @ts-expect-error response enum values are preserved.
            const badStatus: "archived" = summary.data.status;
            // @ts-expect-error dictionary response values are numbers.
            const badTotal: string = summary.data.totals.services;
            console.log(badStatus, badTotal);
          } else {
            const failedData: unknown = summary.data;
            console.log(failedData);
            // @ts-expect-error failed result data is unknown.
            summary.data.status;
          }
        }

        main();
      `,
    );

    const source = createTypeScriptClient(clientFixtureReport(), { target: "browser" });
    expect(source).toContain(
      '"/catalog/summary": { status: "fresh" | "stale"; tags: Array<string>; } & { totals: Record<string, number>; nextCursor?: string | null; items: Array<{ id: string; details?: { rating: number; labels?: Array<"new" | "popular">; }; }>; };',
    );
  });

  test("typechecks the generated-client fixture matrix", async () => {
    await expectGeneratedClientTypechecks(
      "fixture-browser",
      clientFixtureReport(),
      "browser",
      `
        import { createAuggyClient } from "./client";

        const api = createAuggyClient({
          baseUrl: "https://agent.example",
          visitorToken: () => "visitor-token",
          authAssertion: () => "app-assertion",
          onVisitorToken: (token) => console.log(token),
        });

        api.get("/me");
        api.get("/services", {});
        api.get("/health");
        api.get("/health", { headers: { "x-health": "1" } });
        api.get("/services");
        api.get("/services", { query: { category: "hair" } });
        api.get("/services", { headers: { "x-mode": "options-only" } });
        api.get("/search", { query: { q: "hair" } });
        api.get("/services/:serviceId", {
          params: { serviceId: "svc_123" },
          query: { need: "trim", tags: ["dry"] },
        });
        async function main() {
          const profile = await api.post("/profile", { body: { displayName: "Alice" } });
          // @ts-expect-error typed response data requires ok narrowing.
          profile.data.visitorId;
          if (profile.ok) {
            profile.data.visitorId.toUpperCase();
            profile.data.displayName.toUpperCase();
          } else {
            const failedProfileData: unknown = profile.data;
            console.log(failedProfileData);
            // @ts-expect-error failed result data is unknown.
            profile.data.visitorId;
          }

          const services = await api.get("/services", {});
          if (services.ok) {
            const unknownServicesData: unknown = services.data;
            console.log(unknownServicesData);
            // @ts-expect-error routes without response schemas keep unknown data.
            services.data.items;
          }
        }

        api.post("/profile", { body: { displayName: "Alice" } });

        // @ts-expect-error no-input routes do not accept route input.
        api.get("/health", { query: { category: "hair" } });
        // @ts-expect-error required query input cannot be omitted.
        api.get("/search");
        // @ts-expect-error required query routes cannot treat options as input.
        api.get("/search", { headers: { "x-test": "1" } });
        // @ts-expect-error body input cannot be omitted.
        api.post("/profile");
        // @ts-expect-error body routes cannot treat options as input.
        api.post("/profile", { headers: { "x-test": "1" } });
        // @ts-expect-error browser target omits creator/bearer/agent routes.
        api.post("/admin/reindex", { body: { reason: "manual" } });
        // @ts-expect-error browser target omits agent routes.
        api.get("/agent-api/search", { query: { q: "inventory" } });
        // @ts-expect-error required query input cannot be omitted.
        api.get("/services/:serviceId", { params: { serviceId: "svc_123" } });
        // @ts-expect-error params routes cannot treat options as input.
        api.get("/services/:serviceId", { headers: { "x-test": "1" } });
        // @ts-expect-error optional query field still has typed values.
        api.get("/services", { query: { category: 123 } });
      `,
    );

    await expectGeneratedClientTypechecks(
      "fixture-server",
      clientFixtureReport(),
      "server",
      `
        import { createAuggyClient } from "./client";

        const api = createAuggyClient({
          baseUrl: "https://agent.example",
          bearerToken: "creator-secret",
          agentCredentials: { agentId: "worker-agent", agentSecret: "agent-secret" },
        });

        api.get("/health");
        api.get("/health", { headers: { "x-health": "1" } });
        api.get("/services");
        api.get("/services", {});
        api.get("/services", { headers: { "x-mode": "options-only" } });
        api.get("/search", { query: { q: "hair" } });
        api.get("/services/:serviceId", {
          params: { serviceId: "svc_123" },
          query: { need: "trim" },
        });
        api.get("/agent-api/search", { query: { q: "inventory" } });
        async function main() {
          const reindex = await api.post("/admin/reindex", { body: { reason: "manual" } });
          // @ts-expect-error typed response data requires ok narrowing.
          reindex.data.jobId;
          if (reindex.ok) {
            reindex.data.jobId.toUpperCase();
            reindex.data.queued.valueOf();
          } else {
            const failedReindexData: unknown = reindex.data;
            console.log(failedReindexData);
            // @ts-expect-error failed result data is unknown.
            reindex.data.jobId;
          }
        }

        api.post("/admin/reindex", { body: { reason: "manual" } });

        // @ts-expect-error required query input cannot be omitted.
        api.get("/search");
        // @ts-expect-error agent routes with required query still require input.
        api.get("/agent-api/search");
        // @ts-expect-error body input cannot be omitted.
        api.post("/admin/reindex");
        // @ts-expect-error server target omits visitor routes.
        api.get("/me");
        // @ts-expect-error server target omits visitor-token POST routes.
        api.post("/profile", { body: { displayName: "Alice" } });
      `,
    );
  });

  test("browser generated runtime sends params, query, and visitor auth headers", async () => {
    const mod = await loadGeneratedClient(createTypeScriptClient(report()));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const seenVisitorTokens: string[] = [];
    const fetchImpl = async (url: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ requestUrl: String(url) }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-visitor-token": "vis-next",
        },
      });
    };

    const api = mod.createAuggyClient({
      baseUrl: "https://agent.example",
      fetch: fetchImpl,
      visitorToken: "visitor-token",
      authAssertion: () => "app-assertion",
      onVisitorToken: (token: string) => seenVisitorTokens.push(token),
    });
    const assertionOnlyApi = mod.createAuggyClient({
      baseUrl: "https://agent.example",
      fetch: fetchImpl,
      authAssertion: async () => "assertion-only",
    });

    const getResult = await api.get("/services/:serviceId", {
      params: { serviceId: "hair cut" },
      query: { need: "trim", tags: ["wash", "dry"], urgent: false },
    });
    await api.get("/me");
    await api.get("/me", { headers: { "x-test": "1" } });
    await assertionOnlyApi.get("/me");
    await expect(
      api.post("/leads/:leadId/notes", {
        params: { leadId: "lead 1" },
        body: { note: "Call back" },
      }),
    ).rejects.toThrow("Unknown Auggy route: POST /leads/:leadId/notes");
    await expect(api.get("/agent-api/search")).rejects.toThrow(
      "Unknown Auggy route: GET /agent-api/search",
    );

    expect(getResult).toMatchObject({ ok: true, status: 201, visitorToken: "vis-next" });
    expect(calls[0]?.url).toBe(
      "https://agent.example/services/hair%20cut?need=trim&tags=wash&tags=dry&urgent=false",
    );
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBeNull();
    expect(new Headers(calls[0]?.init.headers).get("x-visitor-token")).toBeNull();
    expect(new Headers(calls[0]?.init.headers).get("x-auggy-auth-assertion")).toBeNull();
    expect(calls[1]?.url).toBe("https://agent.example/me");
    expect(new Headers(calls[1]?.init.headers).get("x-visitor-token")).toBe("visitor-token");
    expect(new Headers(calls[1]?.init.headers).get("x-auggy-auth-assertion")).toBe("app-assertion");
    expect(calls[2]?.url).toBe("https://agent.example/me");
    expect(new Headers(calls[2]?.init.headers).get("x-test")).toBe("1");
    expect(new Headers(calls[3]?.init.headers).get("x-visitor-token")).toBeNull();
    expect(new Headers(calls[3]?.init.headers).get("x-auggy-auth-assertion")).toBe(
      "assertion-only",
    );
    expect(seenVisitorTokens).toEqual(["vis-next", "vis-next", "vis-next"]);
  });

  test("server generated runtime sends JSON bodies and bearer auth headers", async () => {
    const mod = await loadGeneratedClient(createTypeScriptClient(report(), { target: "server" }));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: unknown, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ requestUrl: String(url) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    const api = mod.createAuggyClient({
      baseUrl: "https://agent.example",
      fetch: fetchImpl,
      bearerToken: () => "creator-secret",
      agentCredentials: () => ({ agentId: "worker-agent", agentSecret: "agent-secret" }),
    });

    const postResult = await api.post("/leads/:leadId/notes", {
      params: { leadId: "lead 1" },
      body: { note: "Call back" },
    });
    await expect(api.get("/me", {})).rejects.toThrow("Unknown Auggy route: GET /me");
    const agentResult = await api.get("/agent-api/search");

    expect(postResult.data).toEqual({
      requestUrl: "https://agent.example/leads/lead%201/notes",
    });
    expect(calls[0]?.url).toBe("https://agent.example/leads/lead%201/notes");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer creator-secret");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ note: "Call back" }));
    expect(agentResult.data).toEqual({
      requestUrl: "https://agent.example/agent-api/search",
    });
    expect(calls[1]?.url).toBe("https://agent.example/agent-api/search");
    expect(new Headers(calls[1]?.init.headers).get("x-agent-id")).toBe("worker-agent");
    expect(new Headers(calls[1]?.init.headers).get("x-agent-secret")).toBe("agent-secret");
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBeNull();
  });

  test("generated runtime returns non-2xx results without throwing", async () => {
    const mod = await loadGeneratedClient(createTypeScriptClient(report()));
    const api = mod.createAuggyClient({
      baseUrl: "https://agent.example",
      fetch: async () =>
        new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    });

    const result = await api.get("/services/:serviceId", {
      params: { serviceId: "svc" },
      query: { need: "trim" },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      data: { error: "invalid_request" },
    });
  });

  test("generated runtime throws for missing local inputs and malformed JSON", async () => {
    const mod = await loadGeneratedClient(createTypeScriptClient(report()));
    const malformedApi = mod.createAuggyClient({
      baseUrl: "https://agent.example",
      fetch: async () => new Response("{", { headers: { "content-type": "application/json" } }),
    });
    const serverMod = await loadGeneratedClient(
      createTypeScriptClient(report(), { target: "server" }),
    );
    const noBearerApi = serverMod.createAuggyClient({
      baseUrl: "https://agent.example",
      fetch: async () => new Response("{}"),
    });

    await expect(
      malformedApi.get("/services/:serviceId", {
        params: {},
        query: { need: "trim" },
      }),
    ).rejects.toThrow("Missing route param: serviceId");
    await expect(
      noBearerApi.post("/leads/:leadId/notes", {
        params: { leadId: "lead-1" },
        body: { note: "Call back" },
      }),
    ).rejects.toThrow("This Auggy route requires a bearerToken.");
    await expect(noBearerApi.get("/agent-api/search")).rejects.toThrow(
      "This Auggy route requires agentCredentials.",
    );
    await expect(malformedApi.get("/me")).rejects.toThrow(
      "This Auggy route requires a visitorToken or authAssertion.",
    );
    await expect(
      malformedApi.get("/services/:serviceId", {
        params: { serviceId: "svc" },
        query: { need: "trim" },
      }),
    ).rejects.toThrow();
  });
});
