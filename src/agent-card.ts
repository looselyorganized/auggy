import type { AgentConfig, AgentCard } from "./types";

/**
 * Generate Auggy's legacy runtime metadata from an agent's configuration.
 * This internal shape predates current A2A and is not an interoperable Agent Card.
 *
 * For v1, the card is generated but not signed. The web transport
 * serves it from /.well-known/agent-card.json for legacy Auggy discovery.
 * The card is accessible to any transport augment via
 * TransportKernel.getAgentCard().
 */
export function generateAgentCard(config: AgentConfig): AgentCard {
  const skills = config.augments.flatMap((aug) =>
    (aug.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
    })),
  );

  const hasMemory = config.augments.some((a) => a.memory !== undefined);
  const hasTransport = config.augments.some((a) => a.transport !== undefined);

  return {
    provider: {
      name: config.name,
      displayName: config.displayName,
    },
    purpose: config.purpose,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      memory: hasMemory,
      transport: hasTransport,
    },
    skills,
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
}
