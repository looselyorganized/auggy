import type { ClientRoutesReport } from "../../src/cli/routes-client";
import type { OpenApiRoutesReport } from "../../src/cli/routes-openapi";

export type RouteArtifactReport = ClientRoutesReport & OpenApiRoutesReport;

export function routeArtifactReport(): RouteArtifactReport {
  return {
    agent: { name: "artifact-agent", configPath: "/tmp/artifact-agent/agent.yaml" },
    summary: {
      totalRoutes: 7,
      publicRoutes: 3,
      privateRoutes: 4,
      publicRoutePaths: [
        "GET /catalog/:serviceId",
        "POST /visitor/profile",
        "POST /webhooks/stripe",
      ],
    },
    routes: [
      {
        method: "GET",
        path: "/catalog/:serviceId",
        augmentName: "catalog",
        auth: "none",
        params: ["serviceId"],
        public: true,
        security: "public",
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
              category: { enum: ["hair", "skin"] },
              includeInactive: { type: "boolean" },
            },
            required: ["category"],
          },
        },
        responseJsonSchema: {
          allOf: [
            {
              type: "object",
              properties: {
                serviceId: { type: "string" },
                status: { enum: ["fresh", "stale"] },
              },
              required: ["serviceId", "status"],
            },
            {
              type: "object",
              properties: {
                totals: {
                  type: "object",
                  additionalProperties: { type: "integer" },
                },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      labels: { type: "array", items: { enum: ["new", "popular"] } },
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
        path: "/visitor/me",
        augmentName: "visitor-profile",
        auth: "visitor.required",
        params: [],
        public: false,
        security: "private",
      },
      {
        method: "POST",
        path: "/visitor/profile",
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
              acceptsMarketing: { type: "boolean" },
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
        method: "POST",
        path: "/internal/jobs",
        augmentName: "jobs",
        auth: "bearer",
        params: [],
        public: false,
        security: "private",
        requestJsonSchema: {
          body: {
            type: "object",
            properties: {
              jobType: { enum: ["sync", "cleanup"] },
            },
            required: ["jobType"],
          },
        },
      },
      {
        method: "POST",
        path: "/agent-api/sync",
        augmentName: "agent-api",
        auth: "agent.required",
        params: [],
        public: false,
        security: "private",
        requestJsonSchema: {
          body: {
            type: "object",
            properties: {
              cursor: { type: ["string", "null"] },
            },
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            accepted: { type: "boolean" },
          },
          required: ["accepted"],
        },
      },
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
        requestJsonSchema: {
          body: {
            type: "object",
            properties: {
              eventId: { type: "string" },
              type: { enum: ["checkout.session.completed", "invoice.paid"] },
            },
            required: ["eventId", "type"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: {
            received: { type: "boolean" },
          },
          required: ["received"],
        },
      },
    ],
  };
}
