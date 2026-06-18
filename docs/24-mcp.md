# 24 — MCP

**Status:** stable v1.0 add-on. Local stdio MCP is supported for local
development; cloud agents should use remote HTTPS MCP servers.

Auggy can call tools from MCP servers. Add the MCP augment, then define servers
in `.mcp.json` at the agent root.

```bash
auggy augment add mcp
auggy mcp doctor
```

`auggy augment add mcp` creates `.mcp.json` if needed. Use `auggy mcp init`
only when you want to create or repair the MCP config file manually.

`agent.yaml` only enables the augment:

```yaml
augments:
  - mcp
```

`.mcp.json` is the source of truth for server definitions.

This keeps MCP in one place. You do not copy server command strings into
`agent.yaml`; `agent.yaml` says "this agent uses MCP,"
`augments/mcp/augment.yaml` says "use the built-in MCP augment," and
`.mcp.json` says "these are the servers."

Supported connection classes:

- `stdio` for local development. Auggy starts the server as a child process.
- Remote `streamable-http`, `sse`, or `http` servers. Cloud deploys require
  `https://` URLs.

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
      "args": ["../auggy/examples/mcp-stdio-server/server.ts"]
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

The release smoke for this path uses the real `examples/mcp-stdio-server/server.ts`
server and verifies discovery plus a live `mcp_smoke_pickleball_score` tool
call over stdio.

Local `stdio` servers are not deploy-safe by default because Railway cannot run
arbitrary local development commands unless they are intentionally packaged and
operated as part of the cloud service. Keep them local, or replace them with
remote HTTPS MCP servers before deploy.

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
auggy doctor --cloud
```

## Cloud Deploy Rules

Railway deploy preflight checks MCP config. `auggy deploy` runs the same cloud
checks before it touches Railway.

Passes:

- HTTPS `streamable-http`
- HTTPS `sse` legacy servers
- HTTPS `http` servers
- `stdio` servers marked `cloud: "disabled"` or `cloud: "localOnly"`

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
        "cloud": "disabled"
      }
    }
  }
}
```

Use `cloud: "disabled"` when a local server should remain available during
local development but be ignored by cloud deploy preflight and cloud runtime.
`cloud: "localOnly"` is accepted as an alias.

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

You can also tune runtime caps per server:

```json
{
  "auggy": {
    "servers": {
      "ops": {
        "timeoutMs": 10000,
        "maxConcurrentCalls": 2,
        "maxTools": 25,
        "maxToolPages": 5,
        "maxResultBytes": 65536,
        "maxSchemaBytes": 8192,
        "includeToolDescriptions": true
      }
    }
  }
}
```

Defaults are conservative: 30s timeout, four concurrent calls per server,
64 tools, 20 discovery pages, 128 KiB max result, and 16 KiB max input schema.

## Security Notes

- Treat remote MCP tool descriptions and results as untrusted external content.
- Auggy bounds MCP tool result size before returning it to the model.
- Auggy bounds tool discovery pages/tool count so a broken or hostile server
  cannot make boot loop forever.
- Missing `${ENV_VAR}` references fail that server closed; the server exposes
  no tools until the secret is present.
- Servers marked `cloud: "disabled"` or `cloud: "localOnly"` still work
  locally, but are skipped when the agent is running on Railway/Fly-style
  cloud runtimes.
- Remote tool descriptions and input-schema text are normalized/truncated
  before becoming model-facing metadata.
- Duplicate exposed tool names fail the server closed instead of leaking
  partial tools.
- MCP connection failures do not crash the agent; failed servers show in console
  admin info and expose no tools.
- Stdio server stderr is not inherited into Auggy logs by default.
  This avoids accidental secret leakage from noisy local tools.
