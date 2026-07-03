import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  formatRoutesReport,
  routesCommand,
  runRoutes,
  type RoutesReport,
} from "../../../src/cli/commands/routes";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "routes-command-test-"));
  roots.push(root);
  return root;
}

function writeAgent(root: string, name: string, opts: { routes?: "valid" | "reserved" } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  const config = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name,
    engine: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
    augments: ["concierge-services"],
  };

  writeFileSync(join(dir, "agent.yaml"), stringify(config));
  mkdirSync(join(dir, "augments", "concierge-services"), { recursive: true });
  writeFileSync(
    join(dir, "augments", "concierge-services", "augment.yaml"),
    stringify({ type: "custom", source: "./index.ts", config: {} }),
  );
  writeFileSync(
    join(dir, "augments", "concierge-services", "index.ts"),
    customRouteModule(opts.routes ?? "valid"),
  );

  return dir;
}

function writeVisitorAuthAgent(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, "agent.yaml"),
    stringify({
      id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      name,
      engine: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      augments: ["webTransport", "visitorAuth"],
    }),
  );

  mkdirSync(join(dir, "augments", "webTransport"), { recursive: true });
  writeFileSync(
    join(dir, "augments", "webTransport", "augment.yaml"),
    stringify({
      type: "webTransport",
      config: {
        port: 0,
        auth: { type: "bearer", token: "test-token" },
      },
    }),
  );

  mkdirSync(join(dir, "augments", "visitorAuth"), { recursive: true });
  writeFileSync(
    join(dir, "augments", "visitorAuth", "augment.yaml"),
    stringify({
      type: "visitorAuth",
      config: {
        publicUrl: "http://localhost:8080",
        dbPath: "./visitor-auth.db",
        agentMail: { transport: "console" },
        signingKey: "visitor-route-secret",
        layeredMemoryDbPath: null,
      },
    }),
  );

  mkdirSync(join(dir, "skills", "visitorAuth"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "visitorAuth", "SKILL.md"),
    "---\nname: visitorAuth\ndescription: Test visitor auth skill.\n---\n",
  );

  return dir;
}

function customRouteModule(kind: "valid" | "reserved"): string {
  if (kind === "reserved") {
    return `
      export default function conciergeServices() {
        return {
          name: "concierge-services",
          httpRoutes: [
            {
              method: "GET",
              path: "/console",
              auth: "none",
              handler: async () => new Response(JSON.stringify({ ok: true })),
            },
          ],
        };
      }
    `;
  }

  return `
    export default function conciergeServices() {
      return {
        name: "concierge-services",
        httpRoutes: [
          {
            method: "GET",
            path: "/services/:serviceId",
            auth: "none",
            rateLimit: { maxPerMinute: 30 },
            requestJsonSchema: {
              params: {
                type: "object",
                properties: {
                  serviceId: { type: "string", minLength: 1 },
                },
                required: ["serviceId"],
              },
              query: {
                type: "object",
                properties: {
                  need: { type: "string", minLength: 1 },
                },
                required: ["need"],
              },
            },
            handler: async () => new Response(JSON.stringify({ ok: true })),
          },
          {
            method: "POST",
            path: "/leads/:leadId/notes",
            auth: "bearer",
            maxBodyBytes: 65536,
            requestJsonSchema: {
              params: {
                type: "object",
                properties: {
                  leadId: { type: "string", minLength: 1 },
                },
                required: ["leadId"],
              },
              body: {
                type: "object",
                properties: {
                  note: { type: "string", minLength: 1 },
                },
                required: ["note"],
              },
            },
            handler: async () => new Response(JSON.stringify({ ok: true })),
          },
        ],
      };
    }
  `;
}

describe("runRoutes", () => {
  test("returns a route manifest for a named agent", async () => {
    const root = tempRoot();
    writeAgent(root, "zip");

    const report = await runRoutes("zip", { cwd: root });

    expect(report.agent.name).toBe("zip");
    expect(report.agent.configPath).toBe(join(root, "zip", "agent.yaml"));
    expect(report.summary).toEqual({
      totalRoutes: 2,
      publicRoutes: 1,
      privateRoutes: 1,
      publicRoutePaths: ["GET /services/:serviceId"],
    });
    expect(report.routes.map((route) => route.path)).toEqual([
      "/services/:serviceId",
      "/leads/:leadId/notes",
    ]);
    expect(report.routes[0]?.params).toEqual(["serviceId"]);
    expect(report.routes[1]?.params).toEqual(["leadId"]);
    expect(report.routes[0]?.requestJsonSchema?.query).toMatchObject({
      properties: { need: { type: "string", minLength: 1 } },
    });
  });

  test("defaults to project-local agent.yaml when name is omitted", async () => {
    const root = tempRoot();
    const dir = writeAgent(root, "zip");

    const report = await runRoutes(undefined, { cwd: dir });

    expect(report.agent.name).toBe("zip");
    expect(report.routes).toHaveLength(2);
  });

  test("surfaces route validation failures", async () => {
    const root = tempRoot();
    writeAgent(root, "zip", { routes: "reserved" });

    await expect(runRoutes("zip", { cwd: root })).rejects.toThrow(
      'GET "/console" — that path is reserved by webTransport',
    );
  });

  test("includes built-in routes after augment resolution and boot", async () => {
    const root = tempRoot();
    writeVisitorAuthAgent(root, "zip");

    const report = await runRoutes("zip", { cwd: root });

    expect(report.routes.map((route) => `${route.method} ${route.path}`)).toContain(
      "POST /visitor-auth/request",
    );
    expect(report.routes.map((route) => `${route.method} ${route.path}`)).toContain(
      "GET /visitor-auth/verify",
    );
    expect(report.routes.find((route) => route.path === "/visitor-auth/request")).toMatchObject({
      augmentName: "visitorAuth",
      auth: "visitor.optional",
      public: true,
      security: "public",
    });
  });
});

describe("formatRoutesReport", () => {
  test("prints a concise human route table", async () => {
    const root = tempRoot();
    writeAgent(root, "zip");
    const report = await runRoutes("zip", { cwd: root });

    const text = formatRoutesReport(report);

    expect(text).toContain("Routes for zip");
    expect(text).toContain("WARN route posture: 2 route(s): 1 public, 1 private");
    expect(text).toContain(
      "GET   /services/:serviceId  concierge-services  PUBLIC   auth=none  params=serviceId",
    );
    expect(text).toContain(
      "POST  /leads/:leadId/notes  concierge-services  PRIVATE  auth=bearer  params=leadId",
    );
  });

  test("prints an empty state when no routes are registered", () => {
    const report: RoutesReport = {
      agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
      summary: {
        totalRoutes: 0,
        publicRoutes: 0,
        privateRoutes: 0,
        publicRoutePaths: [],
      },
      routes: [],
    };

    expect(formatRoutesReport(report)).toBe("Routes for zip\n\nNo augment routes found.");
  });
});

describe("routesCommand", () => {
  test("prints JSON output", async () => {
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = routesCommand({
        exit,
        runRoutes: async () => ({
          agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
          summary: {
            totalRoutes: 1,
            publicRoutes: 0,
            privateRoutes: 1,
            publicRoutePaths: [],
          },
          routes: [
            {
              method: "GET",
              path: "/services/:serviceId",
              augmentName: "concierge-services",
              auth: "bearer",
              params: ["serviceId"],
              public: false,
              security: "private",
            },
          ],
        }),
      });

      await cmd.parseAsync(["zip", "--json"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    expect(exit).toHaveBeenCalledWith(0);
    const parsed = JSON.parse(logs.join("\n")) as RoutesReport;
    expect(parsed.agent.name).toBe("zip");
    expect(parsed.routes[0]?.path).toBe("/services/:serviceId");
  });

  test("prints OpenAPI output", async () => {
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = routesCommand({
        exit,
        runRoutes: async () => ({
          agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
          summary: {
            totalRoutes: 1,
            publicRoutes: 1,
            privateRoutes: 0,
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
          ],
        }),
      });

      await cmd.parseAsync(["zip", "--openapi"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    expect(exit).toHaveBeenCalledWith(0);
    const parsed = JSON.parse(logs.join("\n")) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.paths["/services/{serviceId}"]).toBeDefined();
  });

  test("rejects conflicting machine-readable output flags", async () => {
    const exit = mock((_code: number) => {});
    const run = mock(async (): Promise<RoutesReport> => {
      throw new Error("should not run");
    });
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = routesCommand({ exit, runRoutes: run });
      await cmd.parseAsync(["zip", "--json", "--openapi"], { from: "user" });
    } finally {
      console.error = origError;
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(run).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("Choose either --json or --openapi.");
  });

  test("exits 1 when routes cannot be inspected", async () => {
    const exit = mock((_code: number) => {});
    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = routesCommand({
        exit,
        runRoutes: async () => {
          throw new Error("Could not inspect routes");
        },
      });

      await cmd.parseAsync(["zip"], { from: "user" });
    } finally {
      console.error = origError;
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("Error: Could not inspect routes");
  });
});
