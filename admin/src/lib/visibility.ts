/**
 * Tab visibility derived from installed augments, per docs/21-admin.md
 * "Tab visibility" section.
 *
 * The Sidebar filters its nav by these flags; the App router renders a
 * "not installed" placeholder when an operator navigates directly to a
 * hidden tab's URL.
 *
 * Visibility is a function only of which augment TYPES are installed —
 * not their instance count or configuration. A second `webTransport`
 * instance doesn't make the Chat tab "more visible".
 */

import type { AugmentSummary } from "./types";

export type TabKey =
  | "chat"
  | "identity"
  | "skills"
  | "credentials"
  | "budget"
  | "security"
  | "augments";

export type TabVisibility = Record<TabKey, boolean>;

export function getTabVisibility(augments: AugmentSummary[]): TabVisibility {
  const types = new Set(augments.map((a) => a.type));
  const hasWebTransport = types.has("webTransport");
  const hasBudgets = types.has("budgets");
  const hasVisitorAuth = types.has("visitorAuth");

  return {
    // Always-on tabs — runtime infrastructure / cross-cutting concerns
    // that exist for every agent.
    identity: true,
    skills: true,
    credentials: true,
    augments: true,

    // Augment-conditional tabs.
    chat: hasWebTransport,
    budget: hasBudgets,
    security: hasWebTransport || hasVisitorAuth,
  };
}

/** Tab to deep-link the operator to when their target tab is hidden. */
export const HIDDEN_TAB_FALLBACK: TabKey = "augments";
