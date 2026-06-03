import type { AdminInfoBlock, Augment } from "../../types";
import { createMcpManager, type McpManagerOptions } from "./manager";
import type { McpClientAdapter } from "./types";

export interface McpAugmentOptions extends Omit<McpManagerOptions, "client"> {
  client?: McpClientAdapter;
}

export type { McpClientAdapter, McpConnection, McpRemoteTool, McpServerStatus } from "./types";

export function mcp(opts: McpAugmentOptions = {}): Augment {
  const manager = createMcpManager(opts);
  const configPath = opts.config ?? ".mcp.json";

  const adminInfo = async (): Promise<AdminInfoBlock> => ({
    augmentName: "mcp",
    title: "MCP",
    sections: [
      {
        kind: "keyValue",
        rows: [
          { label: "Config", value: configPath, source: "agent" },
          { label: "Tools", value: String(manager.tools.length), source: "runtime" },
        ],
      },
      {
        kind: "table",
        columns: ["Server", "Transport", "State", "Tools", "Error"],
        rows: manager
          .statuses()
          .map((status) => [
            status.name,
            status.transport,
            status.state,
            String(status.tools),
            status.error ?? "",
          ]),
      },
    ],
  });

  return {
    name: "mcp",
    capabilities: ["tools", "lifecycle"],
    tools: manager.tools,
    constraints: {
      maxToolCallsPerTurn: 10,
    },
    adminInfo,
    onBoot: () => manager.boot(),
    onShutdown: () => manager.shutdown(),
  };
}
