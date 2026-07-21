import { describe, expect, it } from "bun:test";
import { buildCapabilityModel } from "./capability-model";
import type {
  AugmentSummary,
  DashboardData,
  RouteManifestEntry,
  ToolSummary,
} from "./types";

describe("buildCapabilityModel", () => {
  it("treats visitorAuth HTML and JSON contracts as complete and auth:none as neutral", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("visitorAuth")],
        routes: [
          route("GET", "/visitor-auth/verify/:token", {
            responseMediaTypes: ["text/html"],
          }),
          route("POST", "/visitor-auth/verify", {
            requestMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
            responseMediaTypes: ["text/html"],
            requestJsonSchema: { body: { type: "object" } },
          }),
          route("POST", "/visitor-auth/app/request", {
            requestMediaTypes: ["application/json"],
            responseMediaTypes: ["application/json"],
            requestJsonSchema: { body: { type: "object" } },
            responseJsonSchema: { type: "object" },
          }),
        ],
      }),
    );

    expect(model.findings).toEqual([]);
    expect(model.summary.issueCount).toBe(0);
    expect(model.summary.noteCount).toBe(0);
    expect(model.scope.routes[0]?.contract.expectsJsonResponse).toBe(false);
    expect(model.scope.routes[0]?.badges.find((badge) => badge.kind === "auth")).toMatchObject({
      label: "no route auth",
      tone: "neutral",
    });
  });

  it("only notes missing schemas when an explicit media contract expects JSON", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("contracts")],
        routes: [
          route("POST", "/unspecified"),
          route("GET", "/page", { responseMediaTypes: ["text/html"] }),
          route("POST", "/json", {
            requestMediaTypes: ["Application/Problem+JSON; charset=utf-8"],
            responseMediaTypes: ["application/json"],
          }),
        ],
      }),
    );

    expect(model.findings.map((finding) => finding.code)).toEqual([
      "route.request-json-schema-missing",
      "route.response-json-schema-missing",
    ]);
    expect(model.findings.every((finding) => finding.severity === "note")).toBe(true);
    expect(model.summary).toMatchObject({ issueCount: 0, noteCount: 2 });
  });

  it("accepts external auth as a complete alternative for visitor-required routes", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        routes: [route("POST", "/orders", { auth: "visitor.required", public: false })],
        web: { visitorTokensEnabled: false, externalAuthEnabled: true },
      }),
    );

    expect(model.findings).toEqual([]);
    expect(model.scope.routes[0]?.badges.find((badge) => badge.kind === "auth")?.tone).toBe(
      "info",
    );
  });

  it("distinguishes required visitor failures from optional anonymous operation", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        routes: [
          route("GET", "/orders", {
            augmentName: "orders",
            auth: "visitor.required",
            public: false,
          }),
          route("GET", "/catalog", { augmentName: "orders", auth: "visitor.optional" }),
        ],
      }),
    );

    expect(model.findings.map(({ code, severity }) => ({ code, severity }))).toEqual([
      {
        code: "route.visitor-identity-required-unavailable",
        severity: "error",
      },
      {
        code: "route.visitor-identity-optional-unavailable",
        severity: "note",
      },
    ]);
    expect(model.summary).toMatchObject({ issueCount: 1, noteCount: 1 });
    expect(model.augmentNodes[0]?.summary).toMatchObject({ issueCount: 1, noteCount: 1 });
  });

  it("errors when agent-required routes have no configured access entries", () => {
    const unavailable = buildCapabilityModel(
      dashboard({
        augments: [augment("agentApi")],
        routes: [route("POST", "/agent-api", { auth: "agent.required", public: false })],
        web: { agentAccessEntries: "0" },
      }),
    );
    const available = buildCapabilityModel(
      dashboard({
        augments: [augment("agentApi")],
        routes: [route("POST", "/agent-api", { auth: "agent.required", public: false })],
        web: { agentAccessEntries: "2" },
      }),
    );

    expect(unavailable.findings).toHaveLength(1);
    expect(unavailable.findings[0]).toMatchObject({
      code: "route.agent-access-unavailable",
        severity: "error",
    });
    expect(unavailable.summary.issueCount).toBe(1);
    expect(available.findings).toEqual([]);
  });

  it("models tool restrictions as safeguards rather than findings", () => {
    const restrictedTool = {
      ...tool(
        "delete_order",
        {
          neverExpose: true,
          requiresHumanApproval: true,
          hiddenFromTrustLevels: ["public"],
          approvalRequiredForTrustLevels: ["agent"],
        },
        false,
      ),
      requires: { grant: "orders:delete" },
    };
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        tools: [restrictedTool],
      }),
    );

    expect(model.findings).toEqual([]);
    expect(model.scope.tools[0]?.safeguards).toEqual({
      globallyHidden: true,
      requiresHumanApproval: true,
      hiddenFromTrustLevels: ["public"],
      approvalRequiredForTrustLevels: ["agent"],
    });
    expect(model.scope.tools[0]?.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "visibility-safeguard", tone: "info" }),
        expect.objectContaining({ kind: "approval-safeguard", tone: "info" }),
      ]),
    );
  });

  it("keeps tool schema notes out of the actionable issue count", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        tools: [tool("lookup_order", {}, false)],
      }),
    );

    expect(model.findings[0]).toMatchObject({
      code: "tool.input-json-schema-missing",
      severity: "note",
    });
    expect(model.summary).toMatchObject({ issueCount: 0, noteCount: 1 });
  });

  it("reports unreachable delegated authorization without treating safeguards as failures", () => {
    const delegatedTool = { ...tool("refund_order"), requires: { grant: "orders:refund" } };
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        routes: [
          route("POST", "/visitor-order", {
            augmentName: "orders",
            auth: "visitor.required",
            public: false,
            requires: { grant: "orders:write" },
          }),
          route("POST", "/creator-order", {
            augmentName: "orders",
            auth: "creator",
            public: false,
            requires: { grant: "orders:write" },
            policy: { kind: "webhook.signature" },
          }),
        ],
        tools: [delegatedTool],
        web: { visitorTokensEnabled: true, externalAuthEnabled: false },
      }),
    );

    expect(model.findings.map(({ code, severity }) => ({ code, severity }))).toEqual([
      { code: "route.delegated-auth-unreachable", severity: "error" },
      { code: "route.delegated-auth-unreachable", severity: "error" },
      { code: "tool.delegated-auth-unavailable", severity: "warning" },
    ]);
    expect(
      model.scope.routes[1]?.badges.find((badge) => badge.kind === "webhook-safeguard"),
    ).toMatchObject({ tone: "info" });
  });

  it("does not present delegated visitor-optional routes as anonymous", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        routes: [
          route("POST", "/orders", {
            augmentName: "orders",
            auth: "visitor.optional",
            requires: { scope: "orders:write" },
          }),
        ],
        web: { externalAuthEnabled: true },
      }),
    );

    expect(model.findings).toEqual([]);
    expect(model.scope.routes[0]).toMatchObject({
      detail: "External identity with delegated authorization claims required.",
      badges: expect.arrayContaining([
        expect.objectContaining({ kind: "exposure", label: "delegated access" }),
      ]),
    });
  });

  it("flags a JSON schema paired exclusively with non-JSON response media", () => {
    const model = buildCapabilityModel(
      dashboard({
        routes: [
          route("GET", "/contradictory", {
            responseJsonSchema: { type: "object" },
            responseMediaTypes: ["text/html"],
          }),
        ],
      }),
    );

    expect(model.findings).toHaveLength(1);
    expect(model.findings[0]).toMatchObject({
      code: "route.response-media-schema-conflict",
      severity: "warning",
    });
  });

  it("normalizes stale selections while keeping augment nodes global and scope name-based", () => {
    const memoryUser = { ...augment("memory-user"), usesSharedMemoryTools: true };
    const data = dashboard({
      augments: [augment("orders"), memoryUser],
      routes: [route("GET", "/orders", { augmentName: "orders" })],
      tools: [tool("memory_read")],
    });
    data.tools.entries[0] = { ...data.tools.entries[0]!, augmentName: "memory-user" };

    const selected = buildCapabilityModel(data, { selectedAugmentName: "memory-user" });
    const stale = buildCapabilityModel(data, { selectedAugmentName: "removed" });

    expect(selected.augmentNodes).toHaveLength(2);
    expect(selected.scope).toMatchObject({
      selectedAugmentName: "memory-user",
      normalizedToAll: false,
    });
    expect(selected.scope.routes).toEqual([]);
    expect(selected.scope.tools).toHaveLength(1);
    expect(selected.scope.memoryAugments.map((entry) => entry.name)).toEqual(["memory-user"]);
    expect(selected.scope.summary).toEqual({
      routeCount: 0,
      toolCount: 1,
      skillCount: 0,
      memoryAugmentCount: 1,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
      noteCount: 0,
    });
    expect(selected.summary.memoryAugmentCount).toBe(1);
    expect(stale.scope).toMatchObject({ selectedAugmentName: null, normalizedToAll: true });
    expect(stale.scope.routes).toHaveLength(1);
  });

  it("derives counts from visible entries instead of duplicated payload totals", () => {
    const data = dashboard({
      augments: [augment("orders")],
      routes: [route("GET", "/orders", { augmentName: "orders" })],
      tools: [tool("lookup_order")],
    });
    data.routes.summary.totalRoutes = 99;
    data.tools.totalTools = 99;
    data.augments[0] = { ...data.augments[0]!, httpRouteCount: 99, toolCount: 99 };

    const model = buildCapabilityModel(data);

    expect(model.summary).toMatchObject({ routeCount: 1, toolCount: 1 });
    expect(model.scope.summary).toMatchObject({ routeCount: 1, toolCount: 1 });
    expect(model.augmentNodes[0]?.summary).toMatchObject({ routeCount: 1, toolCount: 1 });
  });

  it("turns admin warn and error statuses into actionable findings", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        blocks: [
          {
            augmentName: "orders",
            title: "Order connector",
            sections: [
              { kind: "status", level: "ok", message: "Ready" },
              { kind: "status", level: "warn", message: "Retries elevated" },
              { kind: "status", level: "error", message: "Credentials rejected" },
            ],
          },
        ],
      }),
    );

    expect(model.issues.map(({ code, severity }) => ({ code, severity }))).toEqual([
      { code: "admin.status-warning", severity: "warning" },
      { code: "admin.status-error", severity: "error" },
    ]);
    expect(model.notes).toEqual([]);
    expect(model.augmentNodes[0]?.summary.issueCount).toBe(2);
    expect(JSON.stringify(model.findings)).not.toContain("Credentials rejected");
    expect(JSON.stringify(model.findings)).not.toContain("Retries elevated");
  });

  it("keeps missing auth telemetry unknown instead of reporting it as disabled", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("webTransport")],
        routes: [
          route("GET", "/visitor", { auth: "visitor.required", public: false }),
          route("GET", "/agent", { auth: "agent.required", public: false }),
        ],
        web: {
          allowAnonymous: { value: null },
          visitorTokensEnabled: null,
          externalAuthEnabled: null,
          agentAccessEntries: undefined,
        },
      }),
    );

    expect(model.findings).toEqual([]);
    expect(model.scope.routes.map((routeView) =>
      routeView.badges.find((entry) => entry.kind === "auth")?.tone
    )).toEqual(["neutral", "neutral"]);
    const posture = model.safeguards.find((entry) => entry.kind === "web-auth-posture");
    expect(posture?.detail).toContain("not reported");
    expect(posture?.badges.map((entry) => entry.label)).toEqual([
      "chat auth not reported",
      "visitor tokens not reported",
      "external auth not reported",
    ]);
  });

  it("scopes owned skills by augment type while keeping manual skills in All", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [augment("orders")],
        skills: {
          installed: [
            ({
              folder: "orders",
              name: "Order support",
              description: "Manage orders",
              source: "bundled",
              frontmatterValid: true,
              contentBytes: 120,
              fromAugmentType: "orders",
            } as DashboardData["skills"]["installed"][number] & {
              fromAugmentType: string;
            }),
            {
              folder: "custom",
              name: "Custom",
              description: null,
              source: "manual",
              frontmatterValid: false,
              contentBytes: 40,
            },
          ],
          available: [
            {
              folder: "returns",
              name: "Returns",
              description: "Handle returns",
              fromAugmentType: "orders",
            },
          ],
          skillsDir: "/agent/skills",
        },
      }),
      { selectedAugmentName: "orders" },
    );

    expect(model.scope.skills.map((skill) => skill.title)).toEqual(["Order support", "Returns"]);
    expect(model.scope.notes.map((finding) => finding.code)).toEqual([
      "skill.available-not-installed",
    ]);
    expect(model.notes.map((finding) => finding.code)).toEqual([
      "skill.frontmatter-invalid",
      "skill.available-not-installed",
    ]);
    expect(model.scope.summary).toMatchObject({ skillCount: 1, issueCount: 0, noteCount: 1 });
    expect(model.summary).toMatchObject({ skillCount: 2, issueCount: 0, noteCount: 2 });
  });

  it("shares type-owned skill notes across instances without inflating global counts", () => {
    const first = { ...augment("orders-east"), type: "orders" };
    const second = { ...augment("orders-west"), type: "orders" };
    const data = dashboard({
      augments: [first, second],
      skills: {
        installed: [],
        available: [
          {
            folder: "orders",
            name: "Order support",
            description: "Manage orders",
            fromAugmentType: "orders",
          },
        ],
        skillsDir: "/agent/skills",
      },
    });

    const global = buildCapabilityModel(data);
    const selected = buildCapabilityModel(data, { selectedAugmentName: "orders-west" });

    expect(global.notes).toHaveLength(1);
    expect(global.summary).toMatchObject({ skillCount: 0, noteCount: 1 });
    expect(global.augmentNodes.map((node) => node.summary.noteCount)).toEqual([1, 1]);
    expect(selected.scope.skills).toHaveLength(1);
    expect(selected.scope.notes).toHaveLength(1);
  });

  it("models sanitized route, tool, augment, and web safeguards", () => {
    const model = buildCapabilityModel(
      dashboard({
        augments: [
          {
            ...augment("web"),
            type: "webTransport",
            hasTurnGate: true,
            handlesInternalTurns: true,
            lifecycleHooks: ["onBoot", "onShutdown"],
          },
          augment("orders"),
        ],
        routes: [
          route("POST", "/webhook", {
            augmentName: "orders",
            auth: "visitor.required",
            public: false,
            requires: { grants: ["secret:grant"] },
            policy: {
              kind: "webhook.signature",
              provider: "stripe",
              secretEnv: "DO_NOT_EXPOSE",
            },
          }),
        ],
        tools: [
          tool("change_order", {
            hiddenFromTrustLevels: ["public"],
            approvalRequiredForTrustLevels: ["agent"],
            maxToolCallsPerTurn: 2,
            toolTimeoutMs: 5000,
          }),
        ],
        web: { externalAuthEnabled: true },
      }),
    );

    expect(model.safeguards.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "route-auth",
        "route-requirements",
        "webhook-signature",
        "tool-visibility",
        "tool-approval",
        "turn-gate",
        "web-auth-posture",
      ]),
    );
    expect(JSON.stringify(model.safeguards)).not.toContain("DO_NOT_EXPOSE");
    expect(JSON.stringify(model.safeguards)).not.toContain("secret:grant");
    expect(model.safeguards.map((entry) => entry.kind)).not.toContain("lifecycle");
    expect(model.safeguards.map((entry) => entry.kind)).not.toContain("internal-turns");
    expect(model.scope.tools[0]?.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "call-limit", label: "2/turn" }),
        expect.objectContaining({ kind: "timeout", label: "5000ms timeout" }),
      ]),
    );
    expect(
      model.safeguards.find((entry) => entry.kind === "web-auth-posture"),
    ).toMatchObject({ configurationHref: "/integrations" });
  });
});

function dashboard({
  augments = [],
  routes = [],
  tools = [],
  web = {},
  blocks = [],
  skills = { installed: [], available: [], skillsDir: null },
}: {
  augments?: AugmentSummary[];
  routes?: RouteManifestEntry[];
  tools?: ToolSummary[];
  web?: Partial<DashboardData["web"]>;
  blocks?: DashboardData["blocks"];
  skills?: DashboardData["skills"];
} = {}): DashboardData {
  return {
    card: { provider: { name: "test" } },
    auggyVersion: "0.5.0",
    agentMeta: null,
    augments,
    tools: { totalTools: tools.length, entries: tools },
    routes: {
      summary: {
        totalRoutes: routes.length,
        publicRoutes: routes.filter((entry) => entry.public).length,
        privateRoutes: routes.filter((entry) => !entry.public).length,
        publicRoutePaths: routes.filter((entry) => entry.public).map((entry) => entry.path),
      },
      entries: routes,
    },
    web: {
      allowAnonymous: { value: false },
      publicIntegration: { value: false },
      trustedProxies: [],
      corsOrigins: [],
      visitorTokensEnabled: false,
      externalAuthEnabled: false,
      agentAccessEntries: "0",
      ...web,
    },
    blocks,
    csrfTokens: [],
    skills,
  };
}

function augment(name: string): AugmentSummary {
  return {
    type: name,
    name,
    required: false,
    category: "capabilities",
    hasContext: false,
    usesSharedMemoryTools: false,
    toolCount: 0,
    isTransport: false,
    isMemoryProvider: false,
    httpRouteCount: 0,
    hasAdminInfo: false,
    lifecycleHooks: [],
    handlesInternalTurns: false,
    hasTurnGate: false,
  };
}

function route(
  method: RouteManifestEntry["method"],
  path: string,
  overrides: Partial<RouteManifestEntry> = {},
): RouteManifestEntry {
  return {
    method,
    path,
    augmentName: "visitorAuth",
    auth: "none",
    params: [],
    public: true,
    security: "public",
    ...overrides,
  };
}

function tool(
  name: string,
  constraints: Partial<ToolSummary["constraints"]> = {},
  hasInputSchema = true,
): ToolSummary {
  return {
    name,
    description: "Test tool",
    category: "meta",
    augmentName: "orders",
    augmentType: "orders",
    hasInputSchema,
    constraints: {
      neverExpose: false,
      requiresHumanApproval: false,
      hiddenFromTrustLevels: [],
      approvalRequiredForTrustLevels: [],
      ...constraints,
    },
  };
}
