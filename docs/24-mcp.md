# 24 — MCP

Auggy can call tools from MCP servers. Add the MCP augment, then define servers
in `.mcp.json` at the agent root.

```bash
auggy augment add mcp
auggy mcp init
auggy mcp doctor
```

`agent.yaml` only mounts the augment:

```yaml
augments:
  - name: mcp
    type: mcp
```

`.mcp.json` is the source of truth for server definitions.

## Local stdio MCP

Use `stdio` for local development. Auggy starts the MCP server as a child
process, discovers tools during boot, and exposes them as Auggy tools named:

```text
mcp_<server>_<tool>
```

Example:

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

The example server exposes:

```text
mcp_smoke_pickleball_score
```

Run:

```bash
auggy mcp doctor
auggy run
```

## Remote HTTPS MCP

Use remote Streamable HTTP MCP servers for cloud agents:

```json
{
  "mcpServers": {
    "github": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_MCP_TOKEN}"
      }
    }
  }
}
```

Put secrets in `.env`, not `.mcp.json`:

```env
GITHUB_MCP_TOKEN=...
```

Check cloud compatibility:

```bash
auggy mcp doctor --cloud
```

## Cloud Deploy Rules

Railway deploy preflight checks MCP config.

Passes:

- HTTPS `streamable-http`
- HTTPS `sse` legacy servers
- `stdio` servers marked `cloud: "localOnly"` or `cloud: "disabled"`

Fails:

- enabled `stdio` servers
- non-HTTPS remote MCP URLs
- literal secret-like values in `.mcp.json`
- missing `.env` references

Local-only example:

```json
{
  "mcpServers": {
    "localTools": {
      "type": "stdio",
      "command": "bun",
      "args": ["./tools/mcp-server.ts"]
    }
  },
  "auggy": {
    "servers": {
      "localTools": {
        "cloud": "localOnly"
      }
    }
  }
}
```

## Tool Policy

Use allowlists and blocklists to limit what Auggy exposes:

```json
{
  "mcpServers": {
    "ops": {
      "type": "streamable-http",
      "url": "https://mcp.example.com"
    }
  },
  "auggy": {
    "servers": {
      "ops": {
        "allowedTools": ["read_status", "create_ticket"],
        "blockedTools": ["delete_all"]
      }
    }
  }
}
```

If `allowedTools` is present, only listed tools are exposed. `blockedTools`
removes tools after discovery.

## Security Notes

- Treat remote MCP tool descriptions and results as untrusted external content.
- Auggy bounds MCP tool result size before returning it to the model.
- MCP connection failures do not crash the agent; failed servers show in console
  admin info and expose no tools.
- Stdio server stderr is not inherited into Auggy logs by default.
  This avoids accidental secret leakage from noisy local tools.
