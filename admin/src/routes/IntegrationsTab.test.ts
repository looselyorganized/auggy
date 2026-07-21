import { describe, expect, it } from "bun:test";
import type { DashboardData } from "@/lib/types";
import { patchPublicIntegration, shouldShowLegacyDiscoveryAlert } from "./IntegrationsTab";

function dashboard(): DashboardData {
  return {
    card: { provider: { name: "demo" } },
    auggyVersion: "0.5.0",
    agentMeta: null,
    augments: [],
    tools: { totalTools: 0, entries: [] },
    routes: {
      summary: { totalRoutes: 0, publicRoutes: 0, privateRoutes: 0, publicRoutePaths: [] },
      entries: [],
    },
    web: {
      allowAnonymous: { value: false },
      publicIntegration: { value: true, source: "yaml" },
      trustedProxies: [],
      corsOrigins: [],
      visitorTokensEnabled: false,
      externalAuthEnabled: false,
    },
    blocks: [
      {
        augmentName: "web",
        title: "Posture",
        sections: [
          {
            kind: "keyValue",
            rows: [
              { label: "publicIntegration", value: "true", source: "yaml" },
              { label: "allowAnonymous", value: "false", source: "yaml" },
            ],
          },
        ],
      },
      { augmentName: "orders", title: "Status", sections: [] },
    ],
    csrfTokens: [],
    skills: { installed: [], available: [], skillsDir: null },
  };
}

describe("patchPublicIntegration", () => {
  it("patches only the persisted legacy-discovery posture after a successful action", () => {
    const before = dashboard();
    const after = patchPublicIntegration(before, false);

    expect(after.web.publicIntegration).toEqual({
      value: false,
      source: "/console override",
    });
    expect(after.blocks[0]?.sections[0]).toEqual({
      kind: "keyValue",
      rows: [
        { label: "publicIntegration", value: "false", source: "/console override" },
        { label: "allowAnonymous", value: "false", source: "yaml" },
      ],
    });
    expect(after.blocks[1]).toBe(before.blocks[1]);
    expect(before.web.publicIntegration.value).toBeTrue();
  });
});

describe("shouldShowLegacyDiscoveryAlert", () => {
  it("keeps public legacy discovery visible until the user reviews its panel", () => {
    expect(shouldShowLegacyDiscoveryAlert(true, "browser")).toBeTrue();
    expect(shouldShowLegacyDiscoveryAlert(true, "server")).toBeTrue();
    expect(shouldShowLegacyDiscoveryAlert(true, "agent")).toBeFalse();
    expect(shouldShowLegacyDiscoveryAlert(false, "browser")).toBeFalse();
  });
});
