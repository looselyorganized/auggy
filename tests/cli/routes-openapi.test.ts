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

    expect(doc.paths["/catalog"]?.get?.security).toEqual([
      {},
      { visitorTokenAuth: [] },
      { externalAuthAssertion: [] },
    ]);
    expect(doc.paths["/orders/{id}"]?.get?.security).toEqual([
      { visitorTokenAuth: [] },
      { externalAuthAssertion: [] },
    ]);
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
        externalAuthAssertion: {
          type: "apiKey",
          in: "header",
          name: "x-auggy-auth-assertion",
        },
      },
    });
  });

  test("exports route policy metadata in x-auggy without adding security schemes", () => {
    const doc = createOpenApiDocument({
      agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
      summary: {
        totalRoutes: 1,
        publicRoutes: 1,
        privateRoutes: 0,
        publicRoutePaths: ["POST /webhooks/stripe"],
      },
      routes: [
        {
          method: "POST",
          path: "/webhooks/stripe",
          augmentName: "payments",
          auth: "none",
          params: [],
          public: true,
          security: "public",
          policy: {
            kind: "webhook.signature",
            provider: "stripe",
            secretEnv: "STRIPE_WEBHOOK_SECRET",
          },
        },
      ],
    }) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: Record<string, unknown>;
    };

    const post = doc.paths["/webhooks/stripe"]?.post;

    expect(post?.security).toEqual([]);
    expect(post?.responses).toEqual({
      "200": { description: "OK" },
      "400": { description: "Bad request" },
      "500": { description: "Internal server error" },
    });
    expect(post?.["x-auggy"]).toMatchObject({
      auth: "none",
      public: true,
      policy: {
        kind: "webhook.signature",
        provider: "stripe",
        secretEnv: "STRIPE_WEBHOOK_SECRET",
      },
    });
    expect(doc.components).toBeUndefined();
  });

  test("exports explicit request and response media types", () => {
    const doc = createOpenApiDocument({
      agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
      summary: {
        totalRoutes: 1,
        publicRoutes: 1,
        privateRoutes: 0,
        publicRoutePaths: ["POST /visitor-auth/verify"],
      },
      routes: [
        {
          method: "POST",
          path: "/visitor-auth/verify",
          augmentName: "visitor-auth",
          auth: "none",
          params: [],
          public: true,
          security: "public",
          requestJsonSchema: {
            body: { type: "object", properties: { token: { type: "string" } } },
          },
          responseJsonSchema: { type: "object", properties: { status: { type: "string" } } },
          requestMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
          responseMediaTypes: ["text/html", "application/json"],
        },
      ],
    }) as {
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: { content?: Record<string, unknown> };
            responses?: Record<string, { content?: Record<string, unknown> }>;
            "x-auggy"?: unknown;
          }
        >
      >;
    };

    const post = doc.paths["/visitor-auth/verify"]?.post;
    expect(Object.keys(post?.requestBody?.content ?? {})).toEqual([
      "application/x-www-form-urlencoded",
      "application/json",
    ]);
    expect(Object.keys(post?.responses?.["200"]?.content ?? {})).toEqual([
      "text/html",
      "application/json",
    ]);
    expect(post?.["x-auggy"]).toMatchObject({
      requestMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
      responseMediaTypes: ["text/html", "application/json"],
    });
  });

  test("exports an explicit request media contract without inventing a schema", () => {
    const doc = createOpenApiDocument({
      agent: { name: "upload", configPath: "/tmp/upload/agent.yaml" },
      summary: {
        totalRoutes: 1,
        publicRoutes: 1,
        privateRoutes: 0,
        publicRoutePaths: ["/upload"],
      },
      routes: [
        {
          method: "POST",
          path: "/upload",
          augmentName: "upload",
          auth: "none",
          params: [],
          public: true,
          security: "public",
          requestMediaTypes: ["application/octet-stream"],
        },
      ],
    }) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };

    expect(doc.paths["/upload"]?.post?.requestBody).toEqual({
      required: true,
      content: { "application/octet-stream": {} },
    });
  });

  test("exports creator route auth as bearer security with semantic metadata", () => {
    const doc = createOpenApiDocument({
      agent: { name: "zip", configPath: "/tmp/zip/agent.yaml" },
      summary: {
        totalRoutes: 1,
        publicRoutes: 0,
        privateRoutes: 1,
        publicRoutePaths: [],
      },
      routes: [
        {
          method: "POST",
          path: "/admin/reindex",
          augmentName: "catalog",
          auth: "creator",
          params: [],
          public: false,
          security: "private",
        },
      ],
    }) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: Record<string, unknown>;
    };

    expect(doc.paths["/admin/reindex"]?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths["/admin/reindex"]?.post?.responses).toMatchObject({
      "401": { description: "Unauthorized" },
    });
    expect(doc.paths["/admin/reindex"]?.post?.["x-auggy"]).toMatchObject({
      auth: "creator",
      security: "private",
      public: false,
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

  test("exports agent route auth as required agent credential headers", () => {
    const doc = createOpenApiDocument({
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
          path: "/agent-api/search",
          augmentName: "agent-api",
          auth: "agent.required",
          params: [],
          public: false,
          security: "private",
        },
      ],
    }) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: Record<string, unknown>;
    };

    expect(doc.paths["/agent-api/search"]?.get?.security).toEqual([
      { agentIdAuth: [], agentSecretAuth: [] },
    ]);
    expect(doc.paths["/agent-api/search"]?.get?.responses).toMatchObject({
      "401": { description: "Unauthorized" },
    });
    expect(doc.paths["/agent-api/search"]?.get?.["x-auggy"]).toMatchObject({
      auth: "agent.required",
      security: "private",
      public: false,
    });
    expect(doc.components).toEqual({
      securitySchemes: {
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
      },
    });
  });
});
