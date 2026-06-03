# MCP Stdio Server Example

This is a tiny real MCP server for testing Auggy's MCP augment locally. It uses
the official MCP TypeScript SDK and exposes one read-only tool:

```text
pickleball_score
```

## Use It With An Agent

From an Auggy agent project:

```bash
auggy augment add mcp
```

Then add this server to `.mcp.json`:

```json
{
  "mcpServers": {
    "smoke": {
      "type": "stdio",
      "command": "bun",
      "args": ["../augment-1/examples/mcp-stdio-server/server.ts"]
    }
  }
}
```

Run:

```bash
auggy mcp doctor
auggy run
```

The discovered Auggy tool is:

```text
mcp_smoke_pickleball_score
```

Local `stdio` MCP servers are not deploy-safe by default. `auggy deploy` will
block this server for Railway unless you mark it local-only:

```json
{
  "mcpServers": {
    "smoke": {
      "type": "stdio",
      "command": "bun",
      "args": ["../augment-1/examples/mcp-stdio-server/server.ts"]
    }
  },
  "auggy": {
    "servers": {
      "smoke": {
        "cloud": "localOnly"
      }
    }
  }
}
```

For cloud agents, prefer remote HTTPS Streamable HTTP MCP servers.
