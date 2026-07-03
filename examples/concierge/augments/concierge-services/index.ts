import { defineAugment, defineRoute, defineTool, json } from "auggy";
import { z } from "zod";
import { saveLead, searchServices } from "./domain";
import { CreateLeadSchema, ServiceSearchQuerySchema } from "./schemas";

export interface ConciergeServicesOptions {
  leadsPath?: string;
}

export default function conciergeServices(opts: ConciergeServicesOptions = {}) {
  const leadsPath = opts.leadsPath ?? "./data/leads.jsonl";

  return defineAugment({
    name: "concierge-services",
    type: "custom",
    capabilities: ["tools"],
    httpRoutes: [
      defineRoute.get("/services", {
        auth: "none",
        query: ServiceSearchQuerySchema,
        rateLimit: { maxPerMinute: 60 },
        handler: ({ query }) => json({ services: searchServices(query) }),
      }),
      defineRoute.post("/leads/create", {
        auth: "none",
        body: CreateLeadSchema,
        maxBodyBytes: 8_192,
        rateLimit: { maxPerMinute: 10 },
        handler: ({ body }) => json({ lead: saveLead(body, { leadsPath }) }, 201),
      }),
    ],
    tools: [
      defineTool({
        name: "service_search",
        description: "Search Harbor & Pine services by visitor need, tag, or max budget.",
        category: "business",
        input: ServiceSearchQuerySchema,
        execute: async (input) => JSON.stringify({ services: searchServices(input) }),
      }),
      defineTool({
        name: "save_lead",
        description: "Save a concierge lead for creator follow-up.",
        category: "business",
        input: CreateLeadSchema.extend({
          notifyHint: z
            .string()
            .optional()
            .describe("Optional short reason this lead may need creator attention."),
        }),
        execute: async ({ notifyHint: _notifyHint, ...input }) => {
          const lead = saveLead(input, { leadsPath });
          return JSON.stringify({
            lead,
            nextStep: lead.highIntent
              ? 'Call notify({ to: "creator", summary, reason, visitor }) with a short summary.'
              : "Continue the conversation and set expectations for follow-up.",
          });
        },
      }),
    ],
  });
}
