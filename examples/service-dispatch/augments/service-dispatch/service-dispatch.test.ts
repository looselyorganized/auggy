import { describe, expect, test } from "bun:test";
import type { PeerIdentity, RouteAuthContext, ToolExecuteContext, ToolResult } from "auggy";
import { ServiceDispatch } from "./domain";
import serviceDispatchAugment from "./index";

const VERIFIED_PEER: PeerIdentity = {
  id: "vis_dispatch",
  kind: "human",
  trustLevel: "public",
  publicSubstate: "recognized",
  sourceAugment: "webTransport",
};

const ANONYMOUS_PEER: PeerIdentity = {
  id: "anon_dispatch",
  kind: "human",
  trustLevel: "public",
  publicSubstate: "anonymous",
  sourceAugment: "webTransport",
};

const VISITOR_AUTH: RouteAuthContext = {
  mode: "visitor",
  state: "recognized",
  visitorId: "vis_dispatch",
  agentId: "service-dispatch",
  issuedAt: 1,
  expiresAt: 2,
  principal: {
    kind: "visitor",
    trustLevel: "public",
    publicSubstate: "recognized",
    visitorId: "vis_dispatch",
    agentId: "service-dispatch",
  },
};

function context(peer = VERIFIED_PEER): ToolExecuteContext {
  return { peer, threadId: "thread-dispatch", turnId: "turn-dispatch" };
}

function route(
  augment: ReturnType<typeof serviceDispatchAugment>,
  method: "GET" | "POST",
  path: string,
) {
  const match = augment.httpRoutes?.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!match) throw new Error(`Missing route ${method} ${path}`);
  return match;
}

function tool(augment: ReturnType<typeof serviceDispatchAugment>, name: string) {
  const match = augment.tools?.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing tool ${name}`);
  return match;
}

function parsed(result: string | ToolResult): Record<string, unknown> {
  return JSON.parse(typeof result === "string" ? result : result.content) as Record<string, unknown>;
}

describe("service-dispatch showcase", () => {
  test("declares six typed route and tool adapters", () => {
    const augment = serviceDispatchAugment();
    expect(augment.httpRoutes).toHaveLength(6);
    expect(augment.tools).toHaveLength(6);
    expect(augment.httpRoutes?.every((candidate) => candidate.responseJsonSchema)).toBe(true);
    expect(
      augment.httpRoutes
        ?.filter((candidate) => candidate.path.includes("appointments"))
        .map((candidate) => candidate.auth),
    ).toEqual(["visitor.required", "visitor.required"]);
  });

  test("route and tool coverage checks share normalization and service-area data", async () => {
    const augment = serviceDispatchAugment();
    const coverageRoute = route(augment, "GET", "/dispatch/coverage");
    const response = await coverageRoute.handler(
      new Request("http://localhost/dispatch/coverage?postalCode=v7l%202a1"),
      { signal: AbortSignal.timeout(1_000) },
    );
    const routeBody = (await response.json()) as Record<string, unknown>;
    const toolBody = parsed(
      await tool(augment, "dispatch_check_coverage").execute({ postalCode: "v7l 2a1" }),
    );

    expect(routeBody).toEqual({
      covered: true,
      normalizedPostalCode: "V7L2A1",
      area: "North Vancouver",
    });
    expect(toolBody).toEqual(routeBody);
  });

  test("intake deterministically classifies urgent work and asks the agent to escalate", async () => {
    const service = new ServiceDispatch(
      () => new Date("2026-07-21T18:00:00.000Z"),
      () => "urgent",
    );
    const augment = serviceDispatchAugment({ service });
    const result = parsed(
      await tool(augment, "dispatch_create_intake").execute({
        name: "Ada",
        email: "ada@example.com",
        postalCode: "V7L 2A1",
        issue: "There is an active leak under the kitchen sink.",
      }),
    ) as { intake: { id: string; serviceId: string; urgency: string }; nextStep: string };

    expect(result.intake).toMatchObject({
      id: "intake_urgent",
      serviceId: "plumbing-repair",
      urgency: "urgent",
    });
    expect(result.nextStep).toContain("notify");
    expect(result.nextStep).toContain("dispatcher");
  });

  test("anonymous peers cannot hold appointments", async () => {
    const augment = serviceDispatchAugment();
    const result = await tool(augment, "dispatch_hold_appointment").execute(
      { intakeId: "intake_unknown", slotId: "slot-heat-1" },
      context(ANONYMOUS_PEER),
    );
    expect(parsed(result)).toMatchObject({ status: "error", code: "hold_forbidden" });
    expect(typeof result === "object" && result.isError).toBe(true);
  });

  test("a route-created intake and hold can be confirmed by the same visitor through a tool", async () => {
    const ids = ["intake-1", "hold-1", "appointment-1"];
    const service = new ServiceDispatch(
      () => new Date("2026-07-21T18:00:00.000Z"),
      () => ids.shift() ?? "fallback",
    );
    const augment = serviceDispatchAugment({ service });
    const intakeRoute = route(augment, "POST", "/dispatch/intakes");
    const intakeResponse = await intakeRoute.handler(
      new Request("http://localhost/dispatch/intakes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Grace",
          postalCode: "V7L 2A1",
          issue: "The furnace is running but the house is not warming up.",
        }),
      }),
      { signal: AbortSignal.timeout(1_000) },
    );
    const { intake } = (await intakeResponse.json()) as { intake: { id: string } };

    const holdRoute = route(augment, "POST", "/dispatch/appointments/hold");
    const holdResponse = await holdRoute.handler(
      new Request("http://localhost/dispatch/appointments/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intakeId: intake.id, slotId: "slot-heat-1" }),
      }),
      { signal: AbortSignal.timeout(1_000), auth: VISITOR_AUTH },
    );
    const { hold } = (await holdResponse.json()) as { hold: { id: string } };

    const confirmed = parsed(
      await tool(augment, "dispatch_confirm_appointment").execute(
        { holdId: hold.id },
        context(),
      ),
    );

    expect(intakeResponse.status).toBe(201);
    expect(holdResponse.status).toBe(201);
    expect(confirmed).toMatchObject({
      appointment: {
        id: "appointment_appointment-1",
        intakeId: "intake_intake-1",
        status: "confirmed",
      },
    });
  });

  test("holds expire before confirmation", () => {
    let nowMs = Date.parse("2026-07-21T18:00:00.000Z");
    const ids = ["intake", "hold"];
    const service = new ServiceDispatch(
      () => new Date(nowMs),
      () => ids.shift() ?? "fallback",
      1_000,
    );
    const actor = { key: "visitor:vis_dispatch", id: "vis_dispatch" };
    const intake = service.createIntake({
      name: "Lin",
      postalCode: "V7L 2A1",
      issue: "The furnace is making a grinding sound when it starts.",
    });
    const hold = service.holdAppointment(actor, {
      intakeId: intake.id,
      slotId: "slot-heat-1",
    });
    nowMs += 1_000;
    expect(() => service.confirmAppointment(actor, hold.id)).toThrow("hold expired");
  });
});
