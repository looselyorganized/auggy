/**
 * Marker used by the CLI to verify that an agent-local `node_modules/auggy`
 * belongs to the current standalone-agent runtime generation.
 *
 * This intentionally lives under `src/` so it is included in published
 * tarballs and local `npm pack` artifacts.
 */
export const AUGGY_RUNTIME_PACKAGE_MARKER = "agent-project-runtime-v1";
