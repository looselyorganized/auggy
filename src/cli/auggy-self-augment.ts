import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineAugment, defineTool } from "../helpers";
import { inspectAugment, type AugmentRuntimeShape } from "../augment-inspector";
import type { Augment, AugmentCategory, CreatorConfig, ToolExecuteContext } from "../types";
import { AUGMENT_CATALOG, type CatalogEntry } from "./augment-catalog";
import { augmentFolderForType } from "./scaffold-skills";
import { readSkillFrontmatter } from "./skill-frontmatter";
import type { AugmentConfig, EngineConfig } from "./types";

const TOOL_NAMES = ["auggy_self_info", "auggy_self_catalog", "auggy_self_recommend"] as const;

export interface AuggySelfAgentMetadata {
  name: string;
  displayName?: string;
  purpose?: string;
  engine: Pick<EngineConfig, "provider" | "model">;
  creator?: CreatorConfig;
}

export interface AuggySelfOptions {
  agentDir: string;
  agent: AuggySelfAgentMetadata;
  configs: AugmentConfig[];
  augments: Augment[];
  version?: string;
}

interface SkillSummary {
  folder: string;
  name: string | null;
  description: string | null;
  frontmatterValid: boolean;
}

interface AugmentSummary extends AugmentRuntimeShape {
  name: string;
  type: string;
  category: AugmentCategory | "unknown";
  required: boolean;
  hasSkill: boolean;
  skillMissing: boolean;
}

function trustLevel(context: ToolExecuteContext | undefined): string {
  return context?.peer?.trustLevel ?? "creator";
}

function creatorOnly(context: ToolExecuteContext | undefined): string | null {
  const level = trustLevel(context);
  if (level === "creator") return null;
  return JSON.stringify({
    status: "denied",
    message: "Auggy self-inspection is available only to the verified creator.",
  });
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function listSkills(agentDir: string): SkillSummary[] {
  const skillsDir = join(agentDir, "skills");
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  const out: SkillSummary[] = [];
  for (const folder of entries) {
    const dir = join(skillsDir, folder);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const fm = readSkillFrontmatter(join(dir, "SKILL.md"));
    out.push({
      folder,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      frontmatterValid: fm !== null,
    });
  }
  out.sort((a, b) => a.folder.localeCompare(b.folder));
  return out;
}

function hasSkill(agentDir: string, type: string | undefined): boolean {
  if (!type) return false;
  const folder = augmentFolderForType(type);
  if (!folder) return false;
  return existsSync(join(agentDir, "skills", folder, "SKILL.md"));
}

function summarizeAugments(opts: AuggySelfOptions): AugmentSummary[] {
  return opts.augments
    .filter((augment) => augment.name !== "auggySelf" && !augment.synthetic)
    .map((augment) => {
      const type = augment.type ?? augment.name;
      const runtime = inspectAugment(augment);
      const category: AugmentSummary["category"] = augment.category ?? "unknown";
      return {
        name: augment.name,
        type,
        category,
        required: augment.required ?? false,
        ...runtime,
        hasSkill: hasSkill(opts.agentDir, type),
        skillMissing: runtime.toolCount > 0 && !hasSkill(opts.agentDir, type),
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}

function installedTypes(configs: AugmentConfig[]): Set<string> {
  return new Set(configs.map((config) => config.type));
}

function catalogEntry(entry: CatalogEntry, installed: Set<string>) {
  return {
    type: entry.type,
    label: entry.label,
    tagline: entry.tagline,
    description: entry.description,
    stability: entry.stability,
    installed: installed.has(entry.type),
    hasSkill: entry.hasSkill,
  };
}

function buildInfo(opts: AuggySelfOptions, context: ToolExecuteContext | undefined) {
  const skills = listSkills(opts.agentDir);
  const augments = summarizeAugments(opts);
  const installed = installedTypes(opts.configs);
  return {
    status: "ok",
    trustLevel: trustLevel(context),
    agent: {
      name: opts.agent.name,
      displayName: opts.agent.displayName ?? opts.agent.name,
      purpose: opts.agent.purpose ?? null,
      engine: opts.agent.engine,
      creatorDisplayName: opts.agent.creator?.displayName ?? null,
      runtimeVersion: opts.version ?? null,
    },
    augments,
    skills,
    available: {
      stable: AUGMENT_CATALOG.filter(
        (entry) => entry.stability === "stable" && !installed.has(entry.type),
      ).map((entry) => catalogEntry(entry, installed)),
      preview: AUGMENT_CATALOG.filter(
        (entry) => entry.stability === "preview" && !installed.has(entry.type),
      ).map((entry) => catalogEntry(entry, installed)),
    },
    warnings: [
      ...augments
        .filter((augment) => augment.skillMissing)
        .map(
          (augment) =>
            `${augment.type} exposes tools but skills/${augment.type}/SKILL.md is missing.`,
        ),
    ],
  };
}

function recommend(goal: string, installed: Set<string>) {
  const normalized = goal.toLowerCase();
  const has = (type: string) => installed.has(type);
  const rec = (
    kind: string,
    title: string,
    why: string,
    nextSteps: string[],
    opts: { preview?: boolean; alreadyInstalledType?: string } = {},
  ) => ({
    kind,
    title,
    why,
    nextSteps,
    preview: opts.preview ?? false,
    alreadyInstalled:
      opts.alreadyInstalledType === undefined ? false : has(opts.alreadyInstalledType),
  });

  if (
    /\b(doc|docs|documentation|faq|policy|policies|pricing|knowledge|reference)\b/.test(normalized)
  ) {
    return rec(
      "knowledge",
      "Add the knowledge augment",
      "Reference material should be fetched on demand instead of pasted into identity.",
      [
        "Run `auggy augment add knowledge`.",
        "Add markdown files under `knowledge/local/`.",
        "List each endpoint in `knowledge/local/manifest` with clear descriptions.",
        "Run `auggy doctor` and restart the agent.",
      ],
      { alreadyInstalledType: "knowledge" },
    );
  }

  if (
    /\b(remember|memory|preference|visitor|profile|personalization|continuity)\b/.test(normalized)
  ) {
    const layeredMemoryInstalled = has("layeredMemory");
    const visitorAuthInstalled = has("visitorAuth");
    const nextSteps = [
      ...(layeredMemoryInstalled ? [] : ["Run `auggy augment add layeredMemory`."]),
      ...(visitorAuthInstalled
        ? []
        : [
            "Run `auggy augment add visitorAuth` if browser visitors should be recognized across sessions.",
            "Use `auggy agentmail setup visitorAuth` for production magic-link email.",
          ]),
      ...(layeredMemoryInstalled
        ? [
            "Use `memory_write({ topic, content })` for stable peer facts; the runtime derives the peer-bound label.",
          ]
        : []),
      ...(!layeredMemoryInstalled || !visitorAuthInstalled
        ? ["Run `auggy doctor` and restart the agent after changing augments."]
        : []),
    ];

    return rec(
      "memory",
      layeredMemoryInstalled
        ? "Layered Memory — installed in this agent"
        : "Layered Memory — stable add-on, not installed in this agent",
      layeredMemoryInstalled
        ? "This agent has peer-scoped episodic memory. Cross-session continuity still depends on a stable peer identity, normally visitorAuth or an external app-auth assertion."
        : "Adds peer-scoped episodic memory backed by SQLite. Explicit topic-based writes work after installation; automatic extraction is off by default.",
      nextSteps,
      { alreadyInstalledType: "layeredMemory" },
    );
  }

  if (/\b(alert|notify|notification|escalate|page|ping|webhook)\b/.test(normalized)) {
    return rec(
      "notification",
      "Add notify",
      "Operator alerts are outbound notifications with destination authority and rate limits.",
      [
        "Run `auggy augment add notify`.",
        "Use the default log-to-file destination locally.",
        "Edit `augments/notify/augment.yaml` for webhook, Telegram, or AgentMail delivery.",
        "Put delivery secrets in `.env`, then run `auggy doctor`.",
      ],
      { alreadyInstalledType: "notify" },
    );
  }

  if (/\b(email|mail|inbox|reply|forward)\b/.test(normalized)) {
    return rec(
      "email",
      "Choose AgentMail or visitorAuth mail setup",
      "Magic-link email and model-callable outbound email are separate paths.",
      [
        "Use `auggy augment setup visitorAuth` only for visitor verification emails.",
        "Run `auggy augment add agentMail` when the agent itself should send or reply to email.",
        "Configure recipient policy before production use.",
      ],
      { alreadyInstalledType: "agentMail" },
    );
  }

  if (/\b(mcp|github|linear|notion|slack|tool server|external tool)\b/.test(normalized)) {
    return rec(
      "mcp",
      "Add MCP",
      "MCP is the standard path for external tool servers when one exists.",
      [
        "Run `auggy augment add mcp`.",
        "Configure `.mcp.json`.",
        "Prefer remote HTTPS MCP servers for cloud deploys.",
        "Run `auggy mcp doctor` and `auggy doctor --cloud`.",
      ],
      { alreadyInstalledType: "mcp" },
    );
  }

  if (/\b(api|route|endpoint|integration|custom|tool call|function)\b/.test(normalized)) {
    return rec(
      "custom-augment",
      "Create a custom augment",
      "Agent-specific APIs, tools, and HTTP routes require runtime code.",
      [
        "Run `auggy augment create <name>`.",
        "Implement narrow typed tools or routes in `augments/<name>/index.ts`.",
        "Run `auggy augment test ./augments/<name>`.",
        "Install it with `auggy augment install <agent> ./<agent>/augments/<name>`.",
      ],
    );
  }

  if (/\b(identity|persona|voice|tone|policy|refuse|boundary|purpose)\b/.test(normalized)) {
    return rec(
      "identity",
      "Edit identity.md",
      "Durable persona, policy, and behavior belong in identity, not a skill or custom code.",
      [
        "Edit `identity.md`.",
        "Keep guidance concrete and avoid secrets.",
        "Run `auggy doctor` and restart the agent.",
      ],
    );
  }

  if (/\b(workflow|playbook|style|instructions|process|rubric)\b/.test(normalized)) {
    return rec(
      "skill",
      "Create a skill",
      "Workflow teaching and examples belong in a skill when no new runtime capability is needed.",
      [
        "Run `auggy skill create <name>`.",
        "Edit `skills/<name>/SKILL.md` with when-to-use guidance and examples.",
        "Restart the agent so the skill manifest refreshes.",
      ],
    );
  }

  if (/\b(deploy|railway|cloud|publish|production)\b/.test(normalized)) {
    return rec(
      "deploy",
      "Run deploy readiness checks",
      "Deployment readiness is mostly config, env, and cloud-safe augment posture.",
      [
        "Run `auggy doctor --cloud`.",
        "Fix failed env, dependency, MCP, and visitorAuth checks.",
        "Run `auggy deploy`.",
      ],
    );
  }

  if (/\b(shell|bash|command|terminal|process)\b/.test(normalized)) {
    return rec(
      "preview-augment",
      "Bash is preview; use only with explicit creator approval",
      "Shell execution is host process execution, not sandboxing.",
      [
        "Run `auggy augment add bash` only if shell execution is truly needed.",
        "Keep the allowlist narrow.",
        "Do not expose bash to public or agent trust.",
      ],
      { preview: true, alreadyInstalledType: "bash" },
    );
  }

  if (/\b(budget|spend|cost|usd|cap|limit)\b/.test(normalized)) {
    return rec(
      "preview-augment",
      "Budgets is preview; pair it with provider hard caps",
      "Budgets is runtime soft guardrails, not billing control.",
      [
        "Run `auggy augment add budgets` if runtime spend guardrails are useful.",
        "Set provider-side hard caps outside Auggy.",
        "Run `auggy doctor` to verify model pricing.",
      ],
      { preview: true, alreadyInstalledType: "budgets" },
    );
  }

  if (/\b(a2a|mesh|peer|agent to agent|agent-to-agent|link)\b/.test(normalized)) {
    return rec(
      "preview-augment",
      "Link is preview",
      "Agent mesh needs careful peer trust and is not a default v1 path.",
      [
        "Run `auggy augment add link` only for an explicit mesh experiment.",
        "Configure peers and bearer handling deliberately.",
        "Wait for granular trust tiers before broad production use.",
      ],
      { preview: true, alreadyInstalledType: "link" },
    );
  }

  return rec(
    "triage",
    "Start with the smallest extension point",
    "The goal is ambiguous; decide whether it needs behavior, reference material, workflow teaching, or runtime side effects.",
    [
      "Use `identity.md` for durable persona or policy.",
      "Use a skill for repeatable workflow instructions.",
      "Use knowledge for reference docs.",
      "Use an augment or MCP only when a new runtime capability is needed.",
    ],
  );
}

export function auggySelf(opts: AuggySelfOptions): Augment {
  const selfInfo = defineTool({
    name: "auggy_self_info",
    description:
      "Creator-only. Inspect this Auggy agent's sanitized runtime inventory: identity metadata, installed augments, mounted skills, available stable/preview augments, and missing-skill warnings. Does not reveal secrets.",
    category: "meta",
    input: z.object({}),
    execute: async (_input, context) => creatorOnly(context) ?? safeJson(buildInfo(opts, context)),
  });

  const selfCatalog = defineTool({
    name: "auggy_self_catalog",
    description:
      "Creator-only. List Auggy's built-in augment catalog with installed state and stable/preview status. Use before recommending an augment.",
    category: "meta",
    input: z.object({}),
    execute: async (_input, context) => {
      const denied = creatorOnly(context);
      if (denied) return denied;
      const installed = installedTypes(opts.configs);
      return safeJson({
        status: "ok",
        stable: AUGMENT_CATALOG.filter((entry) => entry.stability === "stable").map((entry) =>
          catalogEntry(entry, installed),
        ),
        preview: AUGMENT_CATALOG.filter((entry) => entry.stability === "preview").map((entry) =>
          catalogEntry(entry, installed),
        ),
      });
    },
  });

  const selfRecommend = defineTool({
    name: "auggy_self_recommend",
    description:
      "Creator-only. Recommend the smallest Auggy extension point for a creator's build-out goal, using installed-state awareness.",
    category: "meta",
    input: z.object({
      goal: z.string().min(1).max(2000).describe("Creator's desired build-out goal."),
    }),
    execute: async ({ goal }, context) => {
      const denied = creatorOnly(context);
      if (denied) return denied;
      return safeJson({
        status: "ok",
        goal,
        recommendation: recommend(goal, installedTypes(opts.configs)),
      });
    },
  });

  return defineAugment({
    name: "auggySelf",
    type: "auggySelf",
    category: "guardrails",
    synthetic: true,
    capabilities: ["tools"],
    tools: [selfInfo, selfCatalog, selfRecommend],
    constraints: {
      perTrustLevel: {
        public: { neverExpose: [...TOOL_NAMES] },
        agent: { neverExpose: [...TOOL_NAMES] },
      },
    },
  });
}
