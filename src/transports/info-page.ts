import type { AgentCard } from "../types";

/**
 * Escape a string for safe inclusion in HTML text content or attribute values.
 * Order matters: `&` must be replaced first so subsequent replacements don't
 * double-encode their introduced ampersands.
 *
 * Covers the five HTML metacharacters that matter for both element content and
 * double-quoted attribute values: `&`, `<`, `>`, `"`, `'`.
 */
function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render the unauthenticated info page served at `GET /` when no
 * `publicFrontendUrl` is configured. Pure function — no I/O, no kernel deps,
 * deterministic output for a given AgentCard.
 *
 * Task 2 expands this to the full template; Task 1 only needs the escaping
 * primitive proven.
 */
export function renderInfoPage(card: AgentCard): string {
  return `<title>${escape(card.provider.name)}</title>`;
}
