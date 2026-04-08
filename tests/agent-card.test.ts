import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { generateAgentCard } from "@/agent-card";
import type { AgentConfig, MemoryDefaults } from "@/types";

const memoryDefaults: MemoryDefaults = {
  mutable: false,
  origin: "operator",
  priority: "required",
  placement: "system",
  eviction: "never",
};

describe("generateAgentCard", () => {
  it("produces a card with provider name from config", () => {
    const config: AgentConfig = {
      name: "test-agent",
      model: "mock",
      augments: [],
    };
    const card = generateAgentCard(config);
    expect(card.provider.name).toBe("test-agent");
  });

  it("includes purpose when provided", () => {
    const config: AgentConfig = {
      name: "researcher",
      purpose: "Multi-agent coordination research",
      model: "mock",
      augments: [],
    };
    const card = generateAgentCard(config);
    expect(card.purpose).toBe("Multi-agent coordination research");
  });

  it("collects skills from augments with tools", () => {
    const config: AgentConfig = {
      name: "agent",
      model: "mock",
      augments: [
        {
          name: "facility",
          tools: [
            {
              name: "query_facility",
              description: "Query facility status",
              category: "search",
              input: z.object({ q: z.string() }),
              execute: async () => "",
            },
          ],
        },
      ],
    };
    const card = generateAgentCard(config);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]!.name).toBe("query_facility");
    expect(card.skills[0]!.category).toBe("search");
  });

  it("detects memory capability when any augment has memory", () => {
    const config: AgentConfig = {
      name: "agent",
      model: "mock",
      augments: [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults: memoryDefaults,
            read: async () => null,
          },
        },
      ],
    };
    const card = generateAgentCard(config);
    expect(card.capabilities.memory).toBe(true);
  });

  it("detects transport capability when any augment has a transport", () => {
    const config: AgentConfig = {
      name: "agent",
      model: "mock",
      augments: [
        {
          name: "web",
          transport: {
            register: async () => {},
            identify: () => null,
          },
        },
      ],
    };
    const card = generateAgentCard(config);
    expect(card.capabilities.transport).toBe(true);
  });

  it("defaults streaming and push notifications to false for v1", () => {
    const config: AgentConfig = {
      name: "agent",
      model: "mock",
      augments: [],
    };
    const card = generateAgentCard(config);
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it("lists HTTP as the only interface for v1", () => {
    const config: AgentConfig = {
      name: "agent",
      model: "mock",
      augments: [],
    };
    const card = generateAgentCard(config);
    expect(card.interfaces).toEqual(["HTTP+JSON"]);
  });
});
