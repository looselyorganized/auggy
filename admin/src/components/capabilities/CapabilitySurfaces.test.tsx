import { describe, expect, it } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { buildCapabilityModel } from "@/lib/capability-model";
import type { DashboardData } from "@/lib/types";
import { buildConversationSurfaceRows, CapabilityDetail } from "./CapabilitySurfaces";

describe("CapabilityDetail", () => {
  it("renders first-class skills, access controls, notes, and the integrations link", async () => {
    const data = dashboard();
    const model = buildCapabilityModel(data);
    let renderer: ReturnType<typeof create> | undefined;

    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <CapabilityDetail data={data} model={model} />
        </MemoryRouter>,
      );
    });

    const output = JSON.stringify(renderer?.toJSON());
    expect(output).toContain("Skills");
    expect(output).toContain("Access & controls");
    expect(output).toContain("Notes");
    expect(output).toContain("Web authentication posture");
    expect(output).toContain("Reported");
    expect(output).toContain("Installs to");
    expect(output).toContain("Change auth and integration settings");
    expect(renderer?.root.findAllByType("a")[0]?.props.href).toBe("/integrations");
  });

  it("renders unknown conversation auth as unreported", () => {
    const rows = buildConversationSurfaceRows({
      web: { allowAnonymous: { value: null } },
    });

    expect(rows[0]).toMatchObject({
      detail: "Primary AG-UI conversation endpoint.",
      health: "neutral",
      fields: [{ label: "Access", value: "Not reported" }],
    });
  });

  it("explains memory role, mutability, and context placement", async () => {
    const data = dashboard();
    data.augments = [
      {
        type: "fileMemory",
        name: "identity",
        required: false,
        category: "memory",
        hasContext: true,
        usesSharedMemoryTools: true,
        toolCount: 0,
        isTransport: false,
        isMemoryProvider: true,
        httpRouteCount: 0,
        hasAdminInfo: true,
        lifecycleHooks: ["onBoot"],
        handlesInternalTurns: false,
        hasTurnGate: false,
        memory: {
          ownership: { kind: "static", labels: ["self"] },
          mutable: false,
          origin: "operator",
          priority: "required",
          placement: "system",
          eviction: "never",
          ttl: "persistent",
        },
      },
    ];

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <CapabilityDetail data={data} model={buildCapabilityModel(data)} />
        </MemoryRouter>,
      );
    });

    const output = JSON.stringify(renderer?.toJSON());
    expect(output).toContain("Agent identity");
    expect(output).toContain("Required, read-only system instructions");
    expect(output).toContain("read-only");
    expect(output).toContain("system");
    expect(output).toContain("Persistent");
  });
});

function dashboard(): DashboardData {
  return {
    card: { provider: { name: "test" } },
    auggyVersion: "0.5.0",
    agentMeta: null,
    augments: [
      {
        type: "webTransport",
        name: "web",
        required: true,
        category: "transports",
        hasContext: false,
        usesSharedMemoryTools: false,
        toolCount: 0,
        isTransport: true,
        isMemoryProvider: false,
        httpRouteCount: 0,
        hasAdminInfo: true,
        lifecycleHooks: ["onBoot"],
        handlesInternalTurns: false,
        hasTurnGate: true,
      },
    ],
    tools: { totalTools: 0, entries: [] },
    routes: {
      summary: { totalRoutes: 0, publicRoutes: 0, privateRoutes: 0, publicRoutePaths: [] },
      entries: [],
    },
    web: {
      allowAnonymous: { value: false },
      publicIntegration: { value: false },
      trustedProxies: [],
      corsOrigins: [],
      visitorTokensEnabled: true,
      externalAuthEnabled: false,
      agentAccessEntries: "0",
    },
    blocks: [],
    csrfTokens: [],
    skills: {
      installed: [],
      available: [
        {
          folder: "browser-auth",
          name: "Browser auth",
          description: "Configure visitor identity",
          fromAugmentType: "webTransport",
        },
      ],
      skillsDir: "/agent/skills",
    },
  };
}
