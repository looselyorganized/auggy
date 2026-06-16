/**
 * Mirror of the admin server contract. Kept hand-typed (not generated) so the
 * SPA stays decoupled from the server source tree at build time. The shape
 * must match `src/types.ts` (`AdminInfoBlock` and friends) and the JSON
 * envelope produced by `/console/api/dashboard`.
 */

export interface KeyValueRow {
  label: string;
  value: string;
  source?: string;
  resetAction?: { id: string; label: string };
}

export type AdminSection =
  | { kind: "keyValue"; rows: KeyValueRow[] }
  | {
      kind: "table";
      columns: string[];
      rows: string[][];
      rowActions?: AdminRowAction[];
      caption?: string;
    }
  | { kind: "status"; level: "ok" | "warn" | "error"; message: string }
  | {
      kind: "eventStream";
      events: Array<{ timestamp: string; type: string; summary: string }>;
      caption?: string;
    };

export interface AdminActionInput {
  name: string;
  label: string;
  type: "text" | "number" | "boolean";
  required: boolean;
  default?: string;
  helpText?: string;
}

export interface AdminAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  inputs?: AdminActionInput[];
}

export interface AdminRowAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  rowKeyColumn: number;
}

export interface AdminInfoBlock {
  augmentName: string;
  title: string;
  sections: AdminSection[];
  actions?: AdminAction[];
}

export interface CsrfToken {
  actionId: string;
  rowKey?: string;
  token: string;
}

export interface AgentCardLite {
  provider: { name: string; displayName?: string; description?: string };
  purpose?: string;
  capabilities?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; category?: string }>;
}

/**
 * Operator-facing grouping for the Augments tab. Mirrors `AugmentCategory`
 * in `src/types.ts`.
 */
export type AugmentCategory = "transports" | "capabilities" | "memory" | "guardrails";

/** Top-level identity fields read from `agent.yaml`. */
export interface AgentMeta {
  id?: string;
  name?: string;
  displayName?: string;
  creator?: {
    displayName?: string;
  };
  purpose?: string;
  engine?: {
    provider?: string;
    model?: string;
  };
  identityPath?: string;
}

/**
 * Summary of one mounted augment. Mirrors `AugmentSummary` in
 * `src/transports/admin/admin-collector.ts`. Used by the Augments tab to
 * list every augment — settings-bearing or not.
 */
export interface AugmentSummary {
  /** Canonical type name from the create-flow catalog (primary row label). */
  type: string;
  /** Runtime instance name — often equals type, differs for namespaced augments. */
  name: string;
  version?: string;
  required: boolean;
  category: AugmentCategory;
  capabilities: string[];
  hasTools: boolean;
  toolCount: number;
  isTransport: boolean;
  isMemoryProvider: boolean;
  httpRouteCount: number;
  hasAdminInfo: boolean;
}

/** Skill installed under `<agentDir>/skills/<folder>/SKILL.md`. */
export interface InstalledSkillInfo {
  folder: string;
  name: string | null;
  description: string | null;
  source: "bundled" | "modified" | "manual";
  frontmatterValid: boolean;
  contentBytes: number;
}

/** Skill shipped by an augment but not yet installed. */
export interface AvailableSkillInfo {
  folder: string;
  name: string | null;
  description: string | null;
  fromAugmentType: string;
}

export interface SkillsInfo {
  installed: InstalledSkillInfo[];
  available: AvailableSkillInfo[];
  skillsDir: string | null;
}

export interface DashboardData {
  card: AgentCardLite;
  /** Auggy package/runtime version from package.json. */
  auggyVersion: string;
  /** Top-level identity read from agent.yaml; null when unavailable. */
  agentMeta: AgentMeta | null;
  augments: AugmentSummary[];
  blocks: AdminInfoBlock[];
  csrfTokens: CsrfToken[];
  /** Skills snapshot — installed + bundled-but-not-installed. */
  skills: SkillsInfo;
}
