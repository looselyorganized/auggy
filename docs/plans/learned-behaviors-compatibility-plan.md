# Learned Behaviors Compatibility Plan

Status: implemented for the 0.5 preview. New scaffolds, legacy fallback,
dual-file doctor diagnostics, creator-only default writes, and regression
coverage are in place. The logical `learned` label remains intentionally
compatible.

## Goal

Rename or reposition the scaffolded mutable agent-global note file from
`learned.md` to `learned-behaviors.md` without breaking existing agents or the
`memory_read("learned")` / `memory_write("learned")` mental model.

## Why

`learned.md` is too easy to confuse with user-specific memory. In the default
agent project it is not peer memory. It is agent-global learned operating
guidance. User facts such as "my favorite color is blue" belong in
`layeredMemory`; identity and security policy belong in `identity.md`.

## Compatibility Contract

- New agents scaffold `learned-behaviors.md`.
- Existing agents with only `learned.md` continue to work.
- The logical memory label can remain `learned` for compatibility, but docs and
  model guidance should call the file "learned behaviors".
- If both files exist, prefer `learned-behaviors.md` and surface a `doctor`
  warning or console note that `learned.md` is legacy.
- Do not silently delete or rewrite a user's existing `learned.md`.
- Any migration command should copy, not move, unless the user explicitly opts
  into removal.

## Implemented Phases

1. **Docs and prompt guidance**
   - Update README/docs/site wording from "learned notes" to "learned
     behaviors".
   - Teach the memory decision tree:
     user-specific facts -> `layeredMemory`; agent-global operating preferences
     -> learned behaviors; hard identity/security -> `identity.md`.

2. **Runtime compatibility**
   - Update `fileMemory` / scaffold wiring to resolve the learned-behavior file
     from `learned-behaviors.md` first, then `learned.md`.
   - Preserve the existing logical label used by memory tools unless a separate
     label migration is explicitly designed.

3. **Scaffold change**
   - Generate `learned-behaviors.md` for new projects.
   - Update project tree examples, docs, site, and agent-readable docs.

4. **Diagnostics**
   - Add a `doctor` warning when both files exist.
   - Add a clearer error when a user asks to save peer memory but no writable
     peer memory provider is installed.

5. **Tests**
   - New scaffold includes `learned-behaviors.md`.
   - Legacy `learned.md` still loads.
   - Dual-file case prefers `learned-behaviors.md`.
   - `memory_write` guidance distinguishes learned behaviors from peer memory.

## Non-Goals

- Do not make learned behaviors a substitute for `layeredMemory`.
- Do not let chat rewrite identity or security policy casually.
- Do not introduce a breaking label rename before the generated-project
  compatibility path is proven.
