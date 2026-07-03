import { describe, expect, test } from "bun:test";
import { createOpenApiDocument } from "../../src/cli/routes-openapi";
import type { OpenApiRoutesReport } from "../../src/cli/routes-openapi";

function report(): OpenApiRoutesReport {
  return {
    agent: {
      name: "zip",
      configPath: "/tmp/zip/agent.yaml",
    },
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
              tag: { type: "string" },
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
        path: "/leads/create",
        augmentName: "concierge-services",
        auth: "bearer",
        params: [],
        public: false,
        security: "private",
        maxBodyBytes: 65_536,
        requestJsonSchema: {
          body: {
            type: "object",
            properties: {
              email: { type: "string", format: "email" },
              serviceId: { type: "string" },
            },
            required: ["email", "serviceId"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            leadId: { type: "string" },
            saved: { type: "boolean" },
          },
          required: ["leadId", "saved"],
        },
      },
    ],
  };
}

describe("createOpenApiDocument", () => {
  test("creates an OpenAPI 3.1 document from a route report", () => {
    const doc = createOpenApiDocument(report());

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({
      title: "zip Auggy Routes",
      version: "0.1.0",
    });
    expect(doc["x-auggy"]).toEqual({
      agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
      summary: {
        totalRoutes: 2,
        publicRoutes: 1,
        privateRoutes: 1,
        publicRoutePaths: ["GET /services/:serviceId"],
      },
    });
  });

  test("converts path params, query schemas, body schemas, and auth posture", () => {
    const doc = createOpenApiDocument(report()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: Record<string, unknown>;
    };

    const get = doc.paths["/services/{serviceId}"]?.get;
    const post = doc.paths["/leads/create"]?.post;

    expect(get?.security).toEqual([]);
    expect(get?.parameters).toEqual([
      {
        name: "serviceId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "need",
        in: "query",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "tag",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ]);
    expect(get?.responses).toEqual({
      "200": {
        description: "OK",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                serviceId: { type: "string" },
                name: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
              },
              required: ["serviceId", "name"],
            },
          },
        },
      },
      "400": { description: "Bad request" },
      "429": { description: "Rate limited" },
      "500": { description: "Internal server error" },
    });
    expect(get?.["x-auggy"]).toEqual({
      augmentName: "concierge-services",
      auth: "none",
      security: "public",
      public: true,
      rateLimit: { maxPerMinute: 30 },
    });

    expect(post?.security).toEqual([{ bearerAuth: [] }]);
    expect(post?.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              email: { type: "string", format: "email" },
              serviceId: { type: "string" },
            },
            required: ["email", "serviceId"],
          },
        },
      },
    });
    expect(post?.responses).toEqual({
      "200": {
        description: "OK",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                leadId: { type: "string" },
                saved: { type: "boolean" },
              },
              required: ["leadId", "saved"],
            },
          },
        },
      },
      "400": { description: "Bad request" },
      "401": { description: "Unauthorized" },
      "500": { description: "Internal server error" },
    });
    expect(doc.components).toEqual({
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    });
  });

  test("exports visitor route auth as x-visitor-token security", () => {
    const doc = createOpenApiDocument({
      agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
      summary: {
        totalRoutes: 2,
        publicRoutes: 1,
        privateRoutes: 1,
        publicRoutePaths: ["GET /catalog"],
      },
      routes: [
        {
          method: "GET",
          path: "/catalog",
          augmentName: "catalog",
          auth: "visitor.optional",
          params: [],
          public: true,
          security: "public",
        },
        {
          method: "GET",
          path: "/orders/:id",
          augmentName: "orders",
          auth: "visitor.required",
          params: ["id"],
          public: false,
          security: "private",
        },
      ],
    }) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: Record<string, unknown>;
    };

    expect(doc.paths["/catalog"]?.get?.security).toEqual([{}, { visitorTokenAuth: [] }]);
    expect(doc.paths["/orders/{id}"]?.get?.security).toEqual([{ visitorTokenAuth: [] }]);
    expect(doc.paths["/orders/{id}"]?.get?.responses).toMatchObject({
      "401": { description: "Unauthorized" },
    });
    expect(doc.components).toEqual({
      securitySchemes: {
        visitorTokenAuth: {
          type: "apiKey",
          in: "header",
          name: "x-visitor-token",
        },
      },
    });
  });
});
