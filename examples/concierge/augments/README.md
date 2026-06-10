# Augments

Installed augment metadata and custom local augments for this agent live here.

Built-in augments have an `augment.yaml` metadata file only. Their runtime
implementation comes from the installed `auggy` package, which you can inspect
at `node_modules/auggy/src` after `bun install`.

Auggy keeps the runtime as a package instead of copying its TypeScript source
into every agent so agents can receive runtime and security updates through the
normal package manager path. Custom augments are different: they include local
source such as `index.ts` inside this directory because they belong to this agent.
