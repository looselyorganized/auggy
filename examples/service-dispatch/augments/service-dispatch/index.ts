import {
  defineAugment,
  defineRoute,
  defineTool,
  json,
  type RouteAuthContext,
  type ToolExecuteContext,
  type ToolResult,
} from "auggy";
import { z } from "zod";
import { type DispatchActor, DispatchError, ServiceDispatch } from "./domain";
import {
  AppointmentHoldResponseSchema,
  AppointmentParamsSchema,
  AppointmentResponseSchema,
  AvailabilityQuerySchema,
  AvailabilityResponseSchema,
  CoverageQuerySchema,
  CoverageResponseSchema,
  CreateIntakeSchema,
  HoldAppointmentSchema,
  IntakeResponseSchema,
  ServicesResponseSchema,
} from "./schemas";

export interface ServiceDispatchAugmentOptions {
  service?: ServiceDispatch;
}

export default function serviceDispatchAugment(opts: ServiceDispatchAugmentOptions = {}) {
  const service = opts.service ?? new ServiceDispatch();

  return defineAugment({
    name: "service-dispatch",
    httpRoutes: defineRoute.group("/dispatch", [
      defineRoute.get("/services", {
        auth: "none",
        response: ServicesResponseSchema,
        handler: () => json({ services: service.listServices() }),
      }),
      defineRoute.get("/coverage", {
        auth: "none",
        query: CoverageQuerySchema,
        response: CoverageResponseSchema,
        rateLimit: { maxPerMinute: 60 },
        handler: ({ query }) => json(service.checkCoverage(query.postalCode)),
      }),
      defineRoute.post("/intakes", {
        auth: "visitor.optional",
        body: CreateIntakeSchema,
        response: IntakeResponseSchema,
        maxBodyBytes: 8_192,
        rateLimit: { maxPerMinute: 15 },
        handler: ({ body }) => routeResult(() => ({ intake: service.createIntake(body) }), 201),
      }),
      defineRoute.get("/availability", {
        auth: "none",
        query: AvailabilityQuerySchema,
        response: AvailabilityResponseSchema,
        rateLimit: { maxPerMinute: 60 },
        handler: ({ query }) => json({ slots: service.findSlots(query.serviceId) }),
      }),
      defineRoute.post("/appointments/hold", {
        auth: "visitor.required",
        body: HoldAppointmentSchema,
        response: AppointmentHoldResponseSchema,
        maxBodyBytes: 2_048,
        rateLimit: { maxPerMinute: 10 },
        handler: ({ auth, body }) =>
          routeResult(() => ({ hold: service.holdAppointment(routeActor(auth), body) }), 201),
      }),
      defineRoute.post("/appointments/:id/confirm", {
        auth: "visitor.required",
        params: AppointmentParamsSchema,
        response: AppointmentResponseSchema,
        rateLimit: { maxPerMinute: 10 },
        handler: ({ auth, params }) =>
          routeResult(() => ({ appointment: service.confirmAppointment(routeActor(auth), params.id) })),
      }),
    ]),
    tools: [
      defineTool({
        name: "dispatch_list_services",
        description: "List the home-service categories and current starting prices.",
        category: "dispatch",
        input: z.object({}),
        execute: async () => JSON.stringify({ services: service.listServices() }),
      }),
      defineTool({
        name: "dispatch_check_coverage",
        description: "Check whether a customer postal code is in the current service area.",
        category: "dispatch",
        input: CoverageQuerySchema,
        execute: async ({ postalCode }) => JSON.stringify(service.checkCoverage(postalCode)),
      }),
      defineTool({
        name: "dispatch_create_intake",
        description: "Create structured service intake after collecting the required customer and issue details.",
        category: "dispatch",
        input: CreateIntakeSchema,
        execute: async (input) => toolResult(() => ({ intake: service.createIntake(input) })),
      }),
      defineTool({
        name: "dispatch_find_slots",
        description: "Find deterministic appointment slots for a service category.",
        category: "dispatch",
        input: AvailabilityQuerySchema,
        execute: async ({ serviceId }) => JSON.stringify({ slots: service.findSlots(serviceId) }),
      }),
      defineTool({
        name: "dispatch_hold_appointment",
        description: "Hold an appointment slot for a runtime-verified visitor after an intake exists.",
        category: "dispatch",
        input: HoldAppointmentSchema,
        execute: async (input, context) =>
          toolResult(() => ({ hold: service.holdAppointment(toolActor(context), input) })),
      }),
      defineTool({
        name: "dispatch_confirm_appointment",
        description: "Confirm an unexpired appointment hold owned by the runtime-verified visitor.",
        category: "dispatch",
        input: z.object({ holdId: z.string().trim().min(1) }),
        execute: async ({ holdId }, context) =>
          toolResult(() => ({ appointment: service.confirmAppointment(toolActor(context), holdId) })),
      }),
    ],
  });
}

function routeActor(auth: RouteAuthContext): DispatchActor {
  if (auth.mode !== "visitor" || auth.state !== "recognized") {
    throw new DispatchError("hold_forbidden", "A verified visitor is required.");
  }
  return { key: `visitor:${auth.visitorId}`, id: auth.visitorId };
}

function toolActor(context: ToolExecuteContext | undefined): DispatchActor {
  const peer = context?.peer;
  if (peer?.trustLevel === "creator") return { key: `creator:${peer.id}`, id: peer.id };
  if (peer?.trustLevel === "public" && peer.publicSubstate === "recognized") {
    return { key: `visitor:${peer.id}`, id: peer.id };
  }
  throw new DispatchError("hold_forbidden", "A verified visitor is required before holding an appointment.");
}

function routeResult(run: () => unknown, status = 200): Response {
  try {
    return json(run(), status);
  } catch (error) {
    if (error instanceof DispatchError) {
      const statusCode = error.code.endsWith("not_found") ? 404 : 409;
      return json({ error: error.code, message: error.message }, statusCode);
    }
    throw error;
  }
}

function toolResult(run: () => unknown): string | ToolResult {
  try {
    const value = run() as { intake?: { escalationRecommended?: boolean; urgency?: string } };
    return JSON.stringify({
      ...value,
      ...(value.intake?.escalationRecommended
        ? {
            nextStep:
              'Call notify({to:"dispatcher", summary, reason, visitor}) with the intake ID and urgency.',
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof DispatchError) {
      return {
        content: JSON.stringify({ status: "error", code: error.code, message: error.message }),
        isError: true,
      };
    }
    throw error;
  }
}
