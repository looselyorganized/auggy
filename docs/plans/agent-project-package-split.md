# Agent Project + Package Split Plan

## Goal

Ship Auggy OSS v1.0 as a global CLI that creates one self-contained agent
project per folder. The agent project owns behavior, selected augment metadata,
skills, custom code, data, secrets, deploy metadata, and package dependencies.
The Auggy npm package owns the runtime/kernel and built-in augment
implementations.

```text
my-agent/
  agent.yaml
  package.json
  bun.lock
  identity.md
  .env
  .env.example
  .gitignore
  .auggy-cloud.json        # only after deploy
  augments/
    webFetch/
      augment.yaml
      README.md
    filesystem/
      augment.yaml
      README.md
    weather/
      augment.yaml
      index.ts             # custom only
      SKILL.md             # custom only, if applicable
  skills/
    webFetch/
      SKILL.md
    filesystem/
      SKILL.md
  data/
```

The global `auggy` install is tooling: `create`, `init`, `add`, `skill`,
`doctor`, `run`, `deploy`, and `logs`.

Each agent gets its own `package.json`:

```json
{
  "name": "my-agent",
  "private": true,
  "type": "module",
  "dependencies": {
    "auggy": "^1.0.0",
    "@auggy/anthropic": "^1.0.0"
  },
  "scripts": {
    "dev": "auggy run",
    "doctor": "auggy doctor",
    "deploy": "auggy deploy"
  }
}
```

Built-in runtime code is installed through dependencies, not copied into the
agent project. Custom augment code lives under `augments/<name>/`.

## Principles

- `agent.yaml` is the runtime source of truth.
- `package.json` is the dependency/runtime version source of truth.
- No default `~/.auggy/agents/<name>` registry for v1. No central agent index.
- Deploy uploads one agent project, not a multi-agent registry.
- Railway installs dependencies from the agent project's `package.json`.
- First-party augments become separately installable packages over time.
- `auggy add <augment>` installs only the selected augment's config, package
  dependency, augment metadata, skill files, and env scaffolding.
- `augments/` is the installed augment workspace. Built-ins get metadata only;
  custom augments get metadata plus implementation source.
- `skills/` is user-owned and expandable. Users can add skills without adding
  runtime code.

## Command Contract

```bash
auggy create my-agent
```

Creates `./my-agent/` as a new agent project directory.

```bash
mkdir my-agent
cd my-agent
auggy init
```

Initializes the current directory as an agent project.

```bash
auggy add visitorAuth
```

Adds an augment to the current agent project. It mutates `agent.yaml`, updates
`package.json` when needed, creates `augments/<name>/augment.yaml`, installs
bundled skill files into `skills/<name>/`, updates `.env.example`, and runs
install unless skipped.

## Augment Metadata

For built-in augments:

```yaml
name: webFetch
kind: builtin
runtime: auggy
skill: ../../skills/webFetch/SKILL.md
```

For custom augments:

```yaml
name: weather
kind: custom
runtime: local
entry: ./index.ts
skill: ./SKILL.md
```

`runtime` declares where the implementation comes from. Built-in implementation
files are not copied into agent projects; they live in `node_modules/auggy/src`
after install. The corresponding `agent.yaml` type is the installed augment's
`name`.

## Skill Commands

Use a `skill` namespace for both bundled augment skills and user-authored
skills:

```bash
auggy skill add <augment>
auggy skill create <name>
auggy skill list
auggy skill remove <name>
```

- `auggy skill add webFetch` installs or restores the bundled skill for an
  installed augment.
- `auggy skill create sales-playbook` creates a user-authored skill at
  `skills/sales-playbook/SKILL.md`.
- `auggy skill list` shows bundled and user-authored skills.
- `auggy skill remove <name>` removes a user-authored skill, and should require
  confirmation when removing bundled augment skills.

The old top-level `auggy add-skill` command is replaced by the namespace
command before v1.

## Deploy Contract

`auggy deploy` uploads one agent project folder. The bundle includes
`agent.yaml`, `package.json`, `bun.lock`, `identity.md`, `skills/`, `augments/`,
and required project files.

The bundle excludes `.env`, `data/`, local database files, `node_modules/`, and
unrelated sibling agents.

Railway runs:

```bash
bun install
bunx auggy dev --config /app/agent.yaml --internal-mode railway
```

## Execution Slices

1. Remove registry-default assumptions:
   - `agent.yaml` in cwd is the primary target.
   - `run`, `doctor`, `add`, `skill`, and `deploy` can operate from an agent
     project without a name.
   - Cloud metadata can live beside project-local `agent.yaml`.
   - Stop creating or documenting `~/.auggy/agents/<name>` as the default path.

2. Add current-directory init:
   - `auggy create my-agent` creates `./my-agent`.
   - `auggy init` scaffolds the current directory.
   - Both produce the same project layout and use the same scaffold path.

3. Populate installed augment metadata:
   - `auggy create` and `auggy add` create `augments/<name>/augment.yaml`.
   - Built-ins create metadata + README only.
   - Custom augment creation creates metadata + implementation source.

4. Skill command namespace:
   - Add `auggy skill add/create/list/remove`.
   - Replace top-level `auggy skill add`.
   - Keep bundled-skill repair separate from user-authored skill creation.

5. Deploy project root:
   - Stage from the resolved project directory.
   - Exclude `.env`, `data/`, local db files, and `node_modules/`.
   - Preserve `augments/` metadata and custom augment source.

6. Built package output:
   - Publish built `dist/` artifacts for the core `auggy` package.
   - Stop publishing raw runtime source as the primary package entry.

7. First augment package boundary:
   - Move one augment to package-shaped code.
   - Update the catalog and resolver to load it as a dependency.

8. Catalog-driven add:
   - Catalog owns npm dependency, YAML snippet, generated env vars, and skill
     install metadata.
   - Catalog also owns augment metadata generation.

9. Remaining augment migration:
   - Move first-party augments one by one.
   - Keep compatibility shims until v1 migration is complete.

10. Docs cleanup:
    - README, storage layout, deploy docs, and quickstart all describe the
      project-folder model.
    - `~/.auggy` remains only for local process state if still needed, not as
      the agent project registry.
