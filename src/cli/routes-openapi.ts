import type { RouteManifestEntry, RouteManifestSummary } from "../kernel/route-manifest";

type JsonObject = Record<string, unknown>;

export interface OpenApiRoutesReport {
  agent: {
    name: string;
    configPath: string;
  };
  summary: RouteManifestSummary;
  routes: readonly RouteManifestEntry[];
}

export function createOpenApiDocument(report: OpenApiRoutesReport): JsonObject {
  const paths: JsonObject = {};
  const operationIds = new Set<string>();
  const hasBearerRoutes = report.routes.some(
    (route) => route.auth === "bearer" || route.auth === "creator",
  );
  const hasVisitorRoutes = report.routes.some((route) => route.auth.startsWith("visitor."));
  const hasAgentRoutes = report.routes.some((route) => route.auth === "agent.required");

  for (const route of report.routes) {
    const openApiPath = toOpenApiPath(route.path);
    const pathItem = (paths[openApiPath] ?? {}) as JsonObject;
    pathItem[route.method.toLowerCase()] = operationForRoute(route, operationIds);
    paths[openApiPath] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${report.agent.name} Auggy Routes`,
      version: "0.1.0",
    },
    paths,
    ...(hasBearerRoutes || hasVisitorRoutes || hasAgentRoutes
      ? {
          components: {
            securitySchemes: {
              ...(hasBearerRoutes
                ? {
                    bearerAuth: {
                      type: "http",
                      scheme: "bearer",
                    },
                  }
                : {}),
              ...(hasAgentRoutes
                ? {
                    agentIdAuth: {
                      type: "apiKey",
                      in: "header",
                      name: "x-agent-id",
                    },
                    agentSecretAuth: {
                      type: "apiKey",
                      in: "header",
                      name: "x-agent-secret",
                    },
                  }
                : {}),
              ...(hasVisitorRoutes
                ? {
                    visitorTokenAuth: {
                      type: "apiKey",
                      in: "header",
                      name: "x-visitor-token",
                    },
                  }
                : {}),
            },
          },
        }
      : {}),
    "x-auggy": {
      agent: report.agent,
      summary: report.summary,
    },
  };
}

function operationForRoute(route: RouteManifestEntry, operationIds: Set<string>): JsonObject {
  return {
    operationId: uniqueOperationId(route, operationIds),
    tags: [route.augmentName],
    summary: `${route.method} ${route.path}`,
    security: securityForRoute(route),
    parameters: parametersForRoute(route),
    ...(route.requestJsonSchema?.body ? { requestBody: requestBody(route) } : {}),
    responses: responsesForRoute(route),
    "x-auggy": augmentRouteMetadata(route),
  };
}

function parametersForRoute(route: RouteManifestEntry): JsonObject[] {
  const paramsSchema = route.requestJsonSchema?.params;
  const querySchema = route.requestJsonSchema?.query;
  return [
    ...route.params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: propertySchema(paramsSchema, name) ?? { type: "string" },
    })),
    ...queryParameters(querySchema),
  ];
}

function queryParameters(schema: JsonObject | undefined): JsonObject[] {
  const properties = schemaProperties(schema);
  if (!schema || !properties) return [];

  const required = requiredProperties(schema);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: property,
  }));
}

function requestBody(route: RouteManifestEntry): JsonObject {
  return {
    required: true,
    content: {
      "application/json": {
        schema: route.requestJsonSchema?.body,
      },
    },
  };
}

function responsesForRoute(route: RouteManifestEntry): JsonObject {
  return {
    "200": successResponse(route),
    "400": { description: "Bad request" },
    ...(route.auth === "bearer" ||
    route.auth === "creator" ||
    route.auth === "visitor.required" ||
    route.auth === "agent.required"
      ? { "401": { description: "Unauthorized" } }
      : {}),
    ...(route.rateLimit ? { "429": { description: "Rate limited" } } : {}),
    "500": { description: "Internal server error" },
  };
}

function successResponse(route: RouteManifestEntry): JsonObject {
  return {
    description: "OK",
    ...(route.responseJsonSchema
      ? {
          content: {
            "application/json": {
              schema: route.responseJsonSchema,
            },
          },
        }
      : {}),
  };
}

function securityForRoute(route: RouteManifestEntry): JsonObject[] {
  if (route.auth === "bearer" || route.auth === "creator") return [{ bearerAuth: [] }];
  if (route.auth === "agent.required") return [{ agentIdAuth: [], agentSecretAuth: [] }];
  if (route.auth === "visitor.required") return [{ visitorTokenAuth: [] }];
  if (route.auth === "visitor.optional") return [{}, { visitorTokenAuth: [] }];
  return [];
}

function augmentRouteMetadata(route: RouteManifestEntry): JsonObject {
  return {
    augmentName: route.augmentName,
    auth: route.auth,
    security: route.security,
    public: route.public,
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : {}),
    ...(route.maxBodyBytes !== undefined ? { maxBodyBytes: route.maxBodyBytes } : {}),
    ...(route.rateLimit ? { rateLimit: route.rateLimit } : {}),
    ...(route.policy ? { policy: route.policy } : {}),
    ...(route.requires ? { requires: route.requires } : {}),
  };
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function propertySchema(schema: JsonObject | undefined, property: string): unknown {
  return schemaProperties(schema)?.[property];
}

function schemaProperties(schema: JsonObject | undefined): Record<string, unknown> | undefined {
  const properties = schema?.properties;
  return isRecord(properties) ? properties : undefined;
}

function requiredProperties(schema: JsonObject): Set<string> {
  const required = schema.required;
  return new Set(
    Array.isArray(required) ? required.filter((name) => typeof name === "string") : [],
  );
}

function uniqueOperationId(route: RouteManifestEntry, seen: Set<string>): string {
  const base = [
    route.augmentName,
    route.method.toLowerCase(),
    ...route.path.split("/").filter(Boolean),
  ]
    .join("_")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  let id = base || `${route.method.toLowerCase()}_route`;
  let i = 2;
  while (seen.has(id)) {
    id = `${base}_${i}`;
    i += 1;
  }
  seen.add(id);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
