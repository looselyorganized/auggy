import { describe, expect, test } from "bun:test";
import { createTypeScriptClient, type TypeScriptClientTarget } from "../../src/cli/routes-client";
import { createOpenApiDocument } from "../../src/cli/routes-openapi";
import type { RouteManifestEntry } from "../../src/kernel/route-manifest";
import { routeArtifactReport } from "../fixtures/route-artifact-report";

type OpenApiOperation = {
  security?: unknown;
  parameters?: Array<{ name: string; in: string; required: boolean; schema: unknown }>;
  requestBody?: { content?: { "application/json"?: { schema?: unknown } } };
  responses?: Record<string, { content?: { "application/json"?: { schema?: unknown } } }>;
  "x-auggy"?: unknown;
};

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { securitySchemes?: Record<string, unknown> };
};

describe("route artifact parity", () => {
  test("OpenAPI preserves manifest auth, schemas, and route metadata", () => {
    const report = routeArtifactReport();
    const doc = createOpenApiDocument(report) as OpenApiDocument;

    expect(openApiRouteKeys(doc)).toEqual(routeKeys(report.routes, "openapi"));

    for (const route of report.routes) {
      const operation = operationForRoute(doc, route);
      const expectedMetadata = {
        augmentName: route.augmentName,
        auth: route.auth,
        security: route.security,
        public: route.public,
        ...(route.policy ? { policy: route.policy } : {}),
        ...(route.requires ? { requires: route.requires } : {}),
      };
      expect(operation).toBeDefined();
      expect(operation?.["x-auggy"]).toMatchObject(expectedMetadata);
      expect(operation?.security).toEqual(openApiSecurityForAuth(route.auth));
      expect(operation?.parameters ?? []).toEqual(openApiParametersForRoute(route));

      if (route.requestJsonSchema?.body) {
        expect(operation?.requestBody?.content?.["application/json"]?.schema).toEqual(
          route.requestJsonSchema.body,
        );
      } else {
        expect(operation?.requestBody).toBeUndefined();
      }

      if (route.responseJsonSchema) {
        expect(operation?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual(
          route.responseJsonSchema,
        );
      } else {
        expect(operation?.responses?.["200"]?.content).toBeUndefined();
      }
    }

    expect(openApiSecuritySchemeNames(doc)).toEqual([
      "agentIdAuth",
      "agentSecretAuth",
      "bearerAuth",
      "externalAuthAssertion",
      "visitorTokenAuth",
    ]);
  });

  test("generated clients preserve target filtering and route auth metadata", () => {
    const report = routeArtifactReport();
    const browser = createTypeScriptClient(report, { target: "browser" });
    const server = createTypeScriptClient(report, { target: "server" });

    expect(generatedRouteKeys(browser)).toEqual(
      routeKeys(routesForTarget(report.routes, "browser")),
    );
    expect(generatedRouteKeys(server)).toEqual(routeKeys(routesForTarget(report.routes, "server")));

    for (const route of routesForTarget(report.routes, "browser")) {
      expect(browser).toContain(generatedRouteEntry(route));
    }
    for (const route of routesForTarget(report.routes, "server")) {
      expect(server).toContain(generatedRouteEntry(route));
    }
    for (const route of report.routes.filter((route) => !supportsTarget(route, "browser"))) {
      expect(browser).not.toContain(generatedRouteKey(route));
      expect(browser).not.toContain(generatedInputEntryPrefix(route));
    }
    for (const route of report.routes.filter((route) => !supportsTarget(route, "server"))) {
      expect(server).not.toContain(generatedRouteKey(route));
      expect(server).not.toContain(generatedInputEntryPrefix(route));
    }
  });

  test("generated client input and output maps track manifest schemas", () => {
    const report = routeArtifactReport();
    const browser = createTypeScriptClient(report, { target: "browser" });
    const server = createTypeScriptClient(report, { target: "server" });

    for (const route of routesForTarget(report.routes, "browser")) {
      expectInputSchemaParity(browser, route);
      expectOutputSchemaParity(browser, route);
    }
    for (const route of routesForTarget(report.routes, "server")) {
      expectInputSchemaParity(server, route);
      expectOutputSchemaParity(server, route);
    }
  });
});

function routeKeys(
  routes: readonly RouteManifestEntry[],
  format: "manifest" | "openapi" = "manifest",
): string[] {
  return routes
    .map(
      (route) => `${route.method} ${format === "openapi" ? toOpenApiPath(route.path) : route.path}`,
    )
    .sort();
}

function routesForTarget(
  routes: readonly RouteManifestEntry[],
  target: TypeScriptClientTarget,
): RouteManifestEntry[] {
  return routes.filter((route) => supportsTarget(route, target));
}

function supportsTarget(route: RouteManifestEntry, target: TypeScriptClientTarget): boolean {
  if (target === "browser" && route.policy?.kind === "webhook.signature") return false;
  if (route.auth === "none") return true;
  if (route.auth === "bearer" || route.auth === "creator" || route.auth === "agent.required") {
    return target === "server";
  }
  return target === "browser";
}

function openApiRouteKeys(doc: OpenApiDocument): string[] {
  return Object.entries(doc.paths)
    .flatMap(([path, pathItem]) =>
      Object.keys(pathItem).map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function openApiSecuritySchemeNames(doc: OpenApiDocument): string[] {
  return Object.keys(doc.components?.securitySchemes ?? {}).sort();
}

function operationForRoute(
  doc: OpenApiDocument,
  route: RouteManifestEntry,
): OpenApiOperation | undefined {
  return doc.paths[toOpenApiPath(route.path)]?.[route.method.toLowerCase()];
}

function openApiParametersForRoute(
  route: RouteManifestEntry,
): Array<{ name: string; in: string; required: boolean; schema: unknown }> {
  const paramsSchema = route.requestJsonSchema?.params;
  const querySchema = route.requestJsonSchema?.query;
  return [
    ...route.params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: schemaProperty(paramsSchema, name) ?? { type: "string" },
    })),
    ...Object.entries(schemaProperties(querySchema)).map(([name, schema]) => ({
      name,
      in: "query",
      required: requiredProperties(querySchema).has(name),
      schema,
    })),
  ];
}

function openApiSecurityForAuth(auth: RouteManifestEntry["auth"]): unknown {
  if (auth === "bearer" || auth === "creator") return [{ bearerAuth: [] }];
  if (auth === "agent.required") return [{ agentIdAuth: [], agentSecretAuth: [] }];
  if (auth === "visitor.required") {
    return [{ visitorTokenAuth: [] }, { externalAuthAssertion: [] }];
  }
  if (auth === "visitor.optional") {
    return [{}, { visitorTokenAuth: [] }, { externalAuthAssertion: [] }];
  }
  return [];
}

function generatedRouteKeys(source: string): string[] {
  return [...source.matchAll(/^\s+"(GET|POST) ([^"]+)": \{ method:/gm)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
}

function generatedRouteEntry(route: RouteManifestEntry): string {
  return `  ${JSON.stringify(`${route.method} ${route.path}`)}: { method: ${JSON.stringify(
    route.method,
  )}, path: ${JSON.stringify(route.path)}, auth: ${JSON.stringify(
    route.auth,
  )}, params: ${JSON.stringify(route.params)}${generatedRequiresSource(route)} },`;
}

function generatedRequiresSource(route: RouteManifestEntry): string {
  return route.requires ? `, requires: ${JSON.stringify(route.requires)}` : "";
}

function generatedRouteKey(route: RouteManifestEntry): string {
  return `${JSON.stringify(`${route.method} ${route.path}`)}: { method:`;
}

function generatedInputEntryPrefix(route: RouteManifestEntry): string {
  return `  ${JSON.stringify(route.path)}:`;
}

function expectInputSchemaParity(source: string, route: RouteManifestEntry): void {
  const input = generatedMapEntry(source, inputMapName(route.method), route.path);
  expect(input).toBeDefined();
  const hasInput =
    route.params.length > 0 ||
    route.requestJsonSchema?.query !== undefined ||
    route.requestJsonSchema?.body !== undefined;
  if (hasInput) {
    expect(input).not.toBe("{}");
  } else {
    expect(input).toBe("{}");
  }
  if (route.params.length > 0) expect(input).toContain("params:");
  if (route.requestJsonSchema?.query) expect(input).toContain("query");
  if (route.requestJsonSchema?.body) expect(input).toContain("body:");
}

function expectOutputSchemaParity(source: string, route: RouteManifestEntry): void {
  const output = generatedMapEntry(source, outputMapName(route.method), route.path);
  expect(output).toBeDefined();
  if (route.responseJsonSchema) {
    expect(output).not.toBe("unknown");
    if (Array.isArray((route.responseJsonSchema as { allOf?: unknown }).allOf)) {
      expect(output).toContain(" & ");
    }
  } else {
    expect(output).toBe("unknown");
  }
}

function generatedMapEntry(
  source: string,
  interfaceName: string,
  path: string,
): string | undefined {
  const block = source.match(
    new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  if (!block) return undefined;
  const escapedPath = escapeRegExp(JSON.stringify(path));
  return block.match(new RegExp(`^\\s+${escapedPath}: (.*);$`, "m"))?.[1];
}

function inputMapName(method: RouteManifestEntry["method"]): string {
  return method === "GET" ? "AuggyGetInputs" : "AuggyPostInputs";
}

function outputMapName(method: RouteManifestEntry["method"]): string {
  return method === "GET" ? "AuggyGetOutputs" : "AuggyPostOutputs";
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function schemaProperty(schema: unknown, property: string): unknown {
  return schemaProperties(schema)[property];
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const properties = schema.properties;
  return isRecord(properties) ? properties : {};
}

function requiredProperties(schema: unknown): Set<string> {
  if (!isRecord(schema)) return new Set();
  const required = schema.required;
  return new Set(
    Array.isArray(required) ? required.filter((name) => typeof name === "string") : [],
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
