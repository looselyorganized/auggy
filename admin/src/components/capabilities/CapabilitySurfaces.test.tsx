import { describe, expect, it } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router";
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
    expect(output).toContain("Provenance");
    expect(output).toContain("Auggy-provided");
    expect(output).not.toContain("bundled");
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

  it("opens the matching AgentMail instance from its capability identity", async () => {
    const data = dashboard();
    data.augments = [
      {
        type: "agentMail",
        name: "support",
        required: false,
        category: "capabilities",
        hasContext: true,
        usesSharedMemoryTools: false,
        toolCount: 3,
        isTransport: false,
        isMemoryProvider: false,
        httpRouteCount: 2,
        hasAdminInfo: true,
        lifecycleHooks: ["onBoot", "onShutdown"],
        handlesInternalTurns: true,
        hasTurnGate: false,
      },
    ];
    data.blocks = [
      {
        augmentName: "support",
        title: "AgentMail",
        sections: [],
        projection: {
          kind: "mail",
          augmentName: "support",
          inboxId: "inb_support",
          inboxEmail: "support@agentmail.to",
          externalConsoleUrl: "https://console.agentmail.to",
          status: { level: "ok", message: "Inbound websocket ready" },
          inbound: {
            mode: "websocket",
            state: "ready",
            senderPolicy: "any",
            allowedSenderCount: 0,
            globalMaxPerHour: 100,
            perSenderMaxPerHour: 5,
          },
          replies: { mode: "review", allowReplyAll: false },
          drafts: [],
        },
      },
    ];

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <CapabilityDetail
            data={data}
            model={buildCapabilityModel(data, { selectedAugmentName: "support" })}
          />
        </MemoryRouter>,
      );
    });

    const externalLink = renderer?.root.findByType("a");
    expect(externalLink?.props.href).toBe("https://console.agentmail.to");
    expect(externalLink?.props.target).toBe("_blank");
    expect(externalLink?.props.rel).toBe("noopener noreferrer");
    expect(externalLink?.props["aria-label"]).toBe(
      "Open support@agentmail.to in AgentMail (opens in a new tab)",
    );
  });

  it("renders semantic provenance for every installed skill state", async () => {
    const data = dashboard();
    data.skills = {
      installed: [
        {
          folder: "filesystem",
          name: "Filesystem",
          description: "Use files",
          provenance: "auggy-provided",
          fromAugmentType: "filesystem",
          frontmatterValid: true,
          contentBytes: 100,
        },
        {
          folder: "layeredMemory",
          name: "Memory",
          description: "Use memory",
          provenance: "customized-auggy-skill",
          fromAugmentType: "layeredMemory",
          frontmatterValid: true,
          contentBytes: 110,
        },
        {
          folder: "order-support",
          name: "Order support",
          description: "Handle orders",
          provenance: "user-created",
          frontmatterValid: true,
          contentBytes: 120,
        },
      ],
      available: [
        {
          folder: "auggy",
          name: "Auggy",
          description: "Build and extend this agent",
          provenance: "auggy-provided",
        },
      ],
      skillsDir: "/agent/skills",
    };

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <CapabilityDetail data={data} model={buildCapabilityModel(data)} />
        </MemoryRouter>,
      );
    });

    const output = JSON.stringify(renderer?.toJSON());
    expect(output).toContain("Auggy-provided");
    expect(output).toContain("Customized Auggy skill");
    expect(output).toContain("User-created");
    expect(output).toContain("available from Auggy");
    expect(output).not.toContain("available from undefined");
    expect(output).not.toMatch(/bundled|scaffold/i);
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
          provenance: "auggy-provided",
          fromAugmentType: "webTransport",
        },
      ],
      skillsDir: "/agent/skills",
    },
  };
}
