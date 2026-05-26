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

// ---------------------------------------------------------------------------
// Per-augment promotion — derived from the spec's augment→home mapping
// table. See docs/21-admin.md §"Augment → home mapping".
// ---------------------------------------------------------------------------

export type PromotionInfo =
  | {
      kind: "promoted";
      /** The dedicated tab that owns this augment's operator config. */
      tab: Exclude<TabKey, "augments">;
      /** Display label used in the "Configured in X ↗" link. */
      tabLabel: string;
    }
  | { kind: "unpromoted" }
  | {
      kind: "hidden";
      /** Why the row is hidden from the Augments tab. */
      reason: string;
    };

interface AugmentLite {
  type: string;
  name: string;
}

/**
 * Promotion classification for a single augment. Drives how the Augments tab
 * renders the row:
 *
 *   - "promoted" rows show a `Configured in [Tab] ↗` link — no inline edit.
 *   - "unpromoted" rows expand inline to the augment's adminInfo() block.
 *   - "hidden" rows are filtered out of the visible list entirely.
 */
export function getAugmentPromotion(augment: AugmentLite): PromotionInfo {
  // Hidden — these augments don't surface tunable operator state.
  if (augment.type === "supabaseMemory") {
    return { kind: "hidden", reason: "Frozen legacy provider — no operator state to surface." };
  }
  if (augment.type === "turnControl") {
    return { kind: "hidden", reason: "Model-driven; no operator configuration." };
  }
  if (augment.type === "memoryBus") {
    return { kind: "hidden", reason: "Kernel-injected memory tools — not user-mounted." };
  }

  // Promoted — each has a dedicated operator-question tab.
  if (augment.type === "budgets") {
    return { kind: "promoted", tab: "budget", tabLabel: "Budget" };
  }
  if (augment.type === "visitorAuth") {
    return { kind: "promoted", tab: "security", tabLabel: "Security" };
  }
  if (augment.type === "webTransport") {
    return { kind: "promoted", tab: "security", tabLabel: "Security" };
  }
  if (augment.type === "skills") {
    return { kind: "promoted", tab: "skills", tabLabel: "Skills" };
  }
  // The identity-shorthand fileMemory uses label "self" → runtime name
  // "file-memory-self". Other fileMemory mounts (e.g. "learned") stay
  // unpromoted as their own Augments row.
  if (augment.type === "fileMemory" && augment.name === "file-memory-self") {
    return { kind: "promoted", tab: "identity", tabLabel: "Identity" };
  }

  // Everything else — inline editable on the Augments tab.
  return { kind: "unpromoted" };
}

