# Agent Project + Package Split Plan

## Goal

Move Auggy toward a repo-per-agent model:

```text
my-agent/
  agent.yaml
  identity.md
  package.json
  bun.lock
  .env
  augments/
  skills/
  data/
```

The global `auggy` install should be tooling: create, add, doctor, run, deploy.
The agent project should own the runtime version, engine adapter, selected
augment packages, custom augment source, skills, config, and deploy artifact.

## Principles

- `agent.yaml` in the current project is a first-class target.
- `~/.auggy/agents/<name>` stays as a legacy compatibility path during v1.
- Deploy uploads one agent project, not a multi-agent registry.
- Railway installs dependencies from the agent project's `package.json`.
- First-party augments become separately installable packages over time.
- `auggy add <augment>` installs only the selected augment's runtime package,
  skills, config, and env scaffolding.

## Execution Slices

1. Project-local resolution:
   - `agent.yaml` in cwd wins before `~/.auggy/agents/<name>`.
   - `run`, `doctor`, `add`, and `deploy` can operate from an agent project.
   - Cloud metadata can live beside project-local `agent.yaml`.

2. Standalone create mode:
   - `auggy create my-agent` can create `./my-agent`.
   - Keep registry create as compatibility until the new path is stable.

3. Deploy project root:
   - Stage from the resolved project directory.
   - Exclude `.env`, `data/`, local db files, and `node_modules/`.

4. Built package output:
   - Publish built `dist/` artifacts for the core `auggy` package.
   - Stop publishing raw runtime source as the primary package entry.

5. First augment package boundary:
   - Move one augment to package-shaped code.
   - Update the catalog and resolver to load it as a dependency.

6. Catalog-driven add:
   - Catalog owns npm dependency, YAML snippet, generated env vars, and skill
     install metadata.

7. Remaining augment migration:
   - Move first-party augments one by one.
   - Keep compatibility shims until v1 migration is complete.
