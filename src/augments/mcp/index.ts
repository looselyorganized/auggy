import type { AdminInfoBlock, Augment } from "../../types";

export interface McpAugmentOptions {
  config?: string;
}

/**
 * MCP client augment placeholder.
 *
 * v1 DX slice owns config, CLI management, doctor, and cloud preflight.
 * The next slice will connect to configured MCP servers and expose their
 * tools. Until then this augment boots cleanly and surfaces status honestly.
 */
export function mcp(opts: McpAugmentOptions = {}): Augment {
  const configPath = opts.config ?? ".mcp.json";

  const adminInfo = async (): Promise<AdminInfoBlock> => ({
    augmentName: "mcp",
    title: "MCP",
    sections: [
      {
        kind: "keyValue",
        rows: [
          { label: "Config", value: configPath, source: "agent" },
          { label: "Tool bridge", value: "pending implementation", source: "preview" },
        ],
      },
    ],
  });

  return {
    name: "mcp",
    capabilities: ["lifecycle"],
    adminInfo,
  };
}
