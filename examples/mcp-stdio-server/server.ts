import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "auggy-example-stdio",
  version: "1.0.0",
});

server.registerTool(
  "pickleball_score",
  {
    title: "Pickleball Score",
    description: "Returns a deterministic pickleball score summary.",
    inputSchema: {
      player: z.string().describe("Player name"),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async ({ player }) => ({
    content: [
      {
        type: "text",
        text: `${player} wins 11-7`,
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
