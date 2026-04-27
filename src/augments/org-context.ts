/**
 * Org-context augment — connects an Auggy agent to an organization's
 * knowledge and escalation infrastructure.
 *
 * Pattern-setting: this is the first org augment. Other orgs follow
 * the same pattern — deploy an API with a /manifest endpoint, mount
 * this augment with the org's URL. The agent gets org identity in
 * context and on-demand access to org knowledge via tools.
 *
 * Three levels of progressive disclosure:
 *   1. Manifest (always in context, ~200 tokens) — org identity + endpoint list
 *   2. Endpoint content (on demand via org_fetch) — full docs, fetched when relevant
 *   3. Deep references (links within content) — agent follows via web_fetch
 *
 * Boot is graceful: if the org API is unreachable, the agent starts
 * without org context and logs a warning. Tools will fail with clear
 * errors until the API is reachable.
 */

import { z } from "zod";
import type { Augment, ContextBlock, PeerIdentity, TurnState, ToolExecuteContext } from "../types";
import { defineTool } from "../helpers";
import { createHttpClient } from "../http";
import type { HttpClient } from "../http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationLimits {
  enabled?: boolean;
  cooldownMs?: number;
  globalMaxPerHour?: number;
  dedupWindowMs?: number;
  dedupThreshold?: number;
}

export interface OrgContextOptions {
  /** Base URL of the org's API (e.g. "http://localhost:3000"). */
  baseUrl: string;
  /** Optional auth token for the org API. */
  token?: string;
  /** Manifest cache TTL in milliseconds. Default 1 hour. */
  cacheTtlMs?: number;
  /** Optional pre-built HTTP client (for sharing across augments or testing). */
  client?: HttpClient;
  /** Escalation rate limiting config. Enabled by default with sensible thresholds. */
  escalation?: EscalationLimits;
}

interface ManifestEndpoint {
  path: string;
  description: string;
  method?: string;
}

interface OrgManifest {
  org: string;
  purpose: string;
  operator?: string;
  phase?: string;
  endpoints: ManifestEndpoint[];
}

// ---------------------------------------------------------------------------
// Augment factory
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export function orgContext(opts: OrgContextOptions): Augment {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const client = opts.client ?? createHttpClient({
    timeoutMs: 10_000,
    userAgent: "auggy-org-context/0.1",
    defaultHeaders: opts.token
      ? { authorization: `Bearer ${opts.token}` }
      : {},
  });
  const cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL;

  let cachedManifest: OrgManifest | null = null;
  let cacheExpiresAt = 0;

  // ---------------------------------------------------------------------------
  // Escalation rate limiting
  // ---------------------------------------------------------------------------

  const esc = opts.escalation ?? {};
  const escalationEnabled = esc.enabled !== false;
  const cooldownMs = esc.cooldownMs ?? 120_000;
  const globalMaxPerHour = esc.globalMaxPerHour ?? 5;
  const dedupWindowMs = esc.dedupWindowMs ?? 300_000;
  const dedupThreshold = esc.dedupThreshold ?? 0.6;

  const peerLastEscalation = new Map<string, number>();
  const recentSummaries: Array<{ summary: string; timestamp: number }> = [];
  let globalCountThisHour = 0;
  let globalHourStart = Date.now();

  function checkCooldown(peerId: string): string | null {
    const last = peerLastEscalation.get(peerId);
    if (!last) return null;
    const elapsed = Date.now() - last;
    if (elapsed < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
      return `Escalation suppressed — cooldown active. Next escalation available in ${remainingSec} seconds.`;
    }
    return null;
  }

  function checkGlobalLimit(): string | null {
    const now = Date.now();
    if (now - globalHourStart > 3_600_000) {
      globalCountThisHour = 0;
      globalHourStart = now;
    }
    if (globalCountThisHour >= globalMaxPerHour) {
      return `Escalation suppressed — global limit reached (${globalMaxPerHour} per hour). The operator has been notified of prior escalations.`;
    }
    return null;
  }

  function checkDedup(summary: string): string | null {
    if (dedupThreshold <= 0) return null;
    const now = Date.now();
    while (recentSummaries.length > 0 && now - recentSummaries[0]!.timestamp > dedupWindowMs) {
      recentSummaries.shift();
    }
    for (const recent of recentSummaries) {
      if (wordOverlap(summary, recent.summary) >= dedupThreshold) {
        return "Escalation suppressed — a similar escalation was already sent recently.";
      }
    }
    return null;
  }

  function wordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const smaller = wordsA.size <= wordsB.size ? wordsA : wordsB;
    const larger = wordsA.size > wordsB.size ? wordsA : wordsB;
    let matches = 0;
    for (const word of smaller) {
      if (larger.has(word)) matches++;
    }
    return matches / smaller.size;
  }

  function recordEscalation(peerId: string, summary: string): void {
    peerLastEscalation.set(peerId, Date.now());
    recentSummaries.push({ summary, timestamp: Date.now() });
    globalCountThisHour++;
  }

  // ---------------------------------------------------------------------------
  // Manifest fetching
  // ---------------------------------------------------------------------------

  async function fetchManifest(force = false): Promise<OrgManifest | null> {
    if (!force && cachedManifest && Date.now() < cacheExpiresAt) {
      return cachedManifest;
    }

    try {
      const res = await client.get(`${baseUrl}/manifest`);
      if (res.status !== 200) {
        console.warn(`[org-context] manifest returned ${res.status}: ${res.body.slice(0, 200)}`);
        return cachedManifest; // return stale if available
      }
      cachedManifest = JSON.parse(res.body) as OrgManifest;
      cacheExpiresAt = Date.now() + cacheTtl;
      return cachedManifest;
    } catch (err) {
      console.warn(`[org-context] failed to fetch manifest: ${(err as Error).message}`);
      return cachedManifest; // return stale if available
    }
  }

  // ---------------------------------------------------------------------------
  // Context block
  // ---------------------------------------------------------------------------

  function buildContextBlock(manifest: OrgManifest): string {
    const lines = [
      `# ${manifest.org} — Organization Context`,
      "",
      manifest.purpose,
      "",
    ];

    if (manifest.operator) {
      lines.push(`**Operator:** ${manifest.operator}`);
    }
    if (manifest.phase) {
      lines.push(`**Current phase:** ${manifest.phase}`);
    }

    lines.push("");
    lines.push("## Available org knowledge");
    lines.push("");
    lines.push("Use `org_fetch` to retrieve any of these when relevant to the conversation:");
    lines.push("");

    for (const ep of manifest.endpoints) {
      if (ep.method === "POST") {
        lines.push(`- **${ep.path}** (action) — ${ep.description}`);
      } else {
        lines.push(`- **${ep.path}** — ${ep.description}`);
      }
    }

    lines.push("");
    lines.push("Use `org_escalate` to alert the operator when a situation requires human judgment.");

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  const orgFetchTool = defineTool({
    name: "org_fetch",
    description:
      "Fetch knowledge from the organization's API. Use the endpoint paths from the org context manifest.",
    category: "search",
    input: z.object({
      endpoint: z
        .string()
        .describe("The endpoint path (e.g. '/vision', '/initiatives', '/solutions/architecture')"),
      prompt: z
        .string()
        .optional()
        .describe("Optional: what you want to know from the content"),
    }),
    execute: async ({ endpoint, prompt }) => {
      const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

      try {
        const res = await client.get(`${baseUrl}${path}`);
        if (res.status !== 200) {
          return JSON.stringify({
            error: `Org API returned ${res.status} for ${path}`,
          });
        }

        // Try to parse as JSON and extract file contents if it's the standard format.
        try {
          const data = JSON.parse(res.body) as { files?: Array<{ name: string; content: string }> };
          if (data.files && Array.isArray(data.files)) {
            const content = data.files
              .map((f) => `## ${f.name}\n\n${f.content}`)
              .join("\n\n---\n\n");

            // Truncate if very large.
            const maxChars = 20_000;
            const truncated = content.length > maxChars
              ? content.slice(0, maxChars) + `\n\n[truncated — ${content.length} total chars]`
              : content;

            return JSON.stringify({
              endpoint: path,
              fileCount: data.files.length,
              content: truncated,
              ...(prompt ? { prompt } : {}),
            });
          }
        } catch {
          // Not JSON or not the expected format — return raw body.
        }

        return JSON.stringify({
          endpoint: path,
          content: res.body.slice(0, 20_000),
        });
      } catch (err) {
        return JSON.stringify({
          error: `Failed to fetch ${path}: ${(err as Error).message}`,
          hint: "The org API may be temporarily unreachable.",
        });
      }
    },
  });

  const orgEscalateTool = defineTool({
    name: "org_escalate",
    description:
      "Alert the operator to a situation requiring human judgment. Use when a visitor's request is outside your scope, when you're uncertain, or when explicit human approval is needed.",
    category: "communication",
    input: z.object({
      summary: z.string().describe("Brief description of what needs attention"),
      reason: z
        .string()
        .optional()
        .describe("Why this requires escalation"),
      visitor: z
        .string()
        .optional()
        .describe("Visitor name or identifier if known"),
    }),
    execute: async ({ summary, reason, visitor }, context?: ToolExecuteContext) => {
      if (!context) {
        return JSON.stringify({
          error: "org_escalate requires turn context — cannot determine peer identity.",
        });
      }
      const trustLevel = context.peer?.trustLevel ?? "creator";
      if (escalationEnabled && trustLevel !== "creator") {
        const peerId = context.peer!.id;

        const cooldownMsg = checkCooldown(peerId);
        if (cooldownMsg) {
          return JSON.stringify({
            status: "rate_limited",
            message: cooldownMsg,
            hint: "Inform the visitor that you've already notified the operator and are waiting for a response.",
          });
        }

        const globalMsg = checkGlobalLimit();
        if (globalMsg) {
          return JSON.stringify({
            status: "rate_limited",
            message: globalMsg,
            hint: "Inform the visitor that the operator is aware of the situation.",
          });
        }

        const dedupMsg = checkDedup(summary);
        if (dedupMsg) {
          return JSON.stringify({
            status: "rate_limited",
            message: dedupMsg,
            hint: "Inform the visitor that the operator has been notified about this topic.",
          });
        }
      }

      try {
        const res = await client.post(`${baseUrl}/notify`, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary,
            reason,
            visitor,
            channel: "chat-widget",
          }),
        });

        if (res.status !== 200) {
          return JSON.stringify({
            error: `Escalation failed: ${res.status}`,
            detail: res.body.slice(0, 500),
          });
        }

        if (trustLevel !== "creator") {
          recordEscalation(context.peer?.id ?? "unknown", summary);
        }

        const result = JSON.parse(res.body) as { status: string };
        return JSON.stringify({
          status: result.status,
          message: "Operator has been notified.",
        });
      } catch (err) {
        return JSON.stringify({
          error: `Escalation failed: ${(err as Error).message}`,
          hint: "The notification service may be temporarily unreachable. Inform the visitor that you'll follow up.",
        });
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Augment
  // ---------------------------------------------------------------------------

  return {
    name: "org-context",
    capabilities: ["context", "tools"],
    tools: [orgFetchTool, orgEscalateTool],

    context: async () => {
      const manifest = await fetchManifest();
      if (!manifest) return [];

      const block: ContextBlock = {
        source: "org-context",
        content: buildContextBlock(manifest),
        placement: "system",
        priority: "required",
        eviction: "never",
        origin: "operator",
        provenance: "augment",
        ttl: "persistent",
      };

      return [block];
    },

    onBoot: async () => {
      // Retry up to 3 times with backoff.
      const delays = [0, 2000, 5000];
      let manifest: OrgManifest | null = null;

      for (let i = 0; i < delays.length; i++) {
        if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
        manifest = await fetchManifest(true);
        if (manifest) break;
        if (i < delays.length - 1) {
          console.warn(`[org-context] manifest fetch failed, retrying in ${delays[i + 1]! / 1000}s...`);
        }
      }

      if (manifest) {
        console.log(`[org-context] loaded manifest for ${manifest.org} (${manifest.endpoints.length} endpoints)`);
      } else {
        console.warn("[org-context] org API unreachable — running without org context. Will retry on first org_fetch call.");
      }
    },
  };
}
