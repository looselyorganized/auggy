# Knowledge

This directory is the agent's private knowledge base. It is mounted by `agent.yaml`:

```yaml
- name: knowledge
  type: knowledge
  options:
    root: ./knowledge
```

## Files

- `sources.json` lists the knowledge sources the agent can use.
- `local/manifest` describes the local endpoints the agent is allowed to fetch.
- `local/mission.md` and `local/context.md` are starter endpoint files.

## Add Local Knowledge

1. Add a markdown file under `local/`, for example `local/pricing.md`.
2. Add a matching endpoint to `local/manifest`:

```json
{
  "path": "/pricing",
  "description": "Pricing, plans, and billing policy"
}
```

3. Restart the agent. The model will see `/pricing` in context and can fetch it with:

```
knowledge_fetch({ source: "local", endpoint: "/pricing" })
```

## Add A Remote Knowledge API

Add another entry to `sources.json`:

```json
{
  "name": "docs",
  "description": "Published product documentation",
  "baseUrl": "https://docs.example.com/knowledge"
}
```

The remote API must expose `GET /manifest` and every endpoint listed in that manifest. For example, if its manifest lists `/quickstart`, the agent may call:

```
knowledge_fetch({ source: "docs", endpoint: "/quickstart" })
```

Use short source names like `local`, `docs`, `api`, or `handbook`. Use endpoint descriptions that tell the model when to fetch that endpoint.
