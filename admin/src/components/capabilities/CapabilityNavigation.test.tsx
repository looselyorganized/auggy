import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { buildCapabilityModel } from "@/lib/capability-model";
import type { DashboardData } from "@/lib/types";
import {
  CAPABILITY_DETAIL_ID,
  CapabilityMobileSelector,
  CapabilityNavigation,
} from "./CapabilityNavigation";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
});

describe("CapabilityMobileSelector", () => {
  it("renders one labelled menu trigger instead of the desktop owner rail", () => {
    const model = buildCapabilityModel(dashboard());
    const html = renderToStaticMarkup(
      <CapabilityMobileSelector model={model} onSelect={() => undefined} />,
    );

    expect(html).toContain("lg:hidden");
    expect(html).toContain('aria-label="Capability owner: All capabilities"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("All capabilities");
  });

  it("names the selected runtime instance in its trigger", () => {
    const model = buildCapabilityModel(dashboard(), { selectedAugmentName: "web-runtime" });
    const html = renderToStaticMarkup(
      <CapabilityMobileSelector model={model} onSelect={() => undefined} />,
    );

    expect(html).toContain("Capability owner: web-runtime");
  });
});

describe("CapabilityNavigation", () => {
  it("uses pressed native buttons tied to the detail region and emits owner selection", async () => {
    const selections: Array<string | null> = [];
    const model = buildCapabilityModel(dashboard());
    await act(async () => {
      renderer = create(
        <CapabilityNavigation model={model} onSelect={(name) => selections.push(name)} />,
      );
    });

    const buttons = renderer!.root.findAllByType("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.props["aria-pressed"]).toBe(true);
    expect(buttons[1]?.props["aria-pressed"]).toBe(false);
    expect(buttons[1]?.props["aria-controls"]).toBe(CAPABILITY_DETAIL_ID);
    expect(buttons[1]?.props.className).toContain("focus-visible:ring-2");

    await act(async () => buttons[1]?.props.onClick());
    expect(selections).toEqual(["web-runtime"]);
  });

  it("lets a selected scope return to the complete runtime map", async () => {
    const selections: Array<string | null> = [];
    const model = buildCapabilityModel(dashboard(), { selectedAugmentName: "web-runtime" });
    await act(async () => {
      renderer = create(
        <CapabilityNavigation model={model} onSelect={(name) => selections.push(name)} />,
      );
    });

    const allButton = renderer!.root.findAllByType("button")[0];
    expect(allButton?.props["aria-pressed"]).toBe(false);
    await act(async () => allButton?.props.onClick());
    expect(selections).toEqual([null]);
  });

  it("distinguishes identity instructions from learned behavior memory", () => {
    const data = dashboard();
    data.augments = [identityMemory(), learnedMemory()];
    const html = renderToStaticMarkup(
      <CapabilityNavigation model={buildCapabilityModel(data)} onSelect={() => undefined} />,
    );

    expect(html).toContain("Agent identity");
    expect(html).toContain("fileMemory · self");
    expect(html).toContain("Learned behaviors");
    expect(html).toContain("fileMemory · learned");
  });

  it("keeps conventional memory roles clear against an older runtime payload", () => {
    const data = dashboard();
    data.augments = [identityMemory(), learnedMemory()].map(({ memory: _, ...augment }) => augment);
    const html = renderToStaticMarkup(
      <CapabilityNavigation model={buildCapabilityModel(data)} onSelect={() => undefined} />,
    );

    expect(html).toContain("Agent identity");
    expect(html).toContain("Learned behaviors");
  });
});

function identityMemory(): DashboardData["augments"][number] {
  return memoryAugment("identity", {
    ownership: { kind: "static", labels: ["self"] },
    mutable: false,
    origin: "operator",
    priority: "required",
    placement: "system",
    eviction: "never",
    ttl: "persistent",
  });
}

function learnedMemory(): DashboardData["augments"][number] {
  return memoryAugment("fileMemory", {
    ownership: { kind: "static", labels: ["learned"] },
    mutable: true,
    origin: "operator",
    priority: "high",
    placement: "preamble",
    eviction: "drop",
    ttl: "persistent",
    writeTrustLevels: ["creator"],
  });
}

function memoryAugment(
  name: string,
  memory: NonNullable<DashboardData["augments"][number]["memory"]>,
): DashboardData["augments"][number] {
  return {
    type: "fileMemory",
    name,
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
    memory,
  };
}

function dashboard(): DashboardData {
  return {
    card: { provider: { name: "test" } },
    auggyVersion: "0.5.0",
    agentMeta: null,
    augments: [
      {
        type: "webTransport",
        name: "web-runtime",
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
    skills: { installed: [], available: [], skillsDir: null },
  };
}
