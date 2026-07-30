import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { auggySelf } from "@/cli/auggy-self-augment";
import { defineTool } from "@/helpers";
import { createCapabilityTable } from "@/kernel/capability-table";
import type { Augment, PeerIdentity, ToolExecuteContext, TurnState } from "@/types";
import pkg from "../../package.json" with { type: "json" };

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-self-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeSkill(folder: string, description = "Test skill."): void {
  const dir = join(tempDir, "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${folder}`, `description: ${description}`, "---", "", `# ${folder}`, ""].join(
      "\n",
    ),
  );
}

function makeContext(peer: PeerIdentity | null): ToolExecuteContext {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    peer,
  };
}

function makeTurn(peer: PeerIdentity | null): TurnState {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    peer,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
    trigger: {
      type: "message",
      turnId: "turn-1",
      threadId: "thread-1",
      timestamp: Date.now(),
      payload: { parts: [] },
    },
  };
}

const creatorPeer: PeerIdentity = {
  id: "creator",
  kind: "human",
  trustLevel: "creator",
  sourceAugment: "webTransport",
};

const publicPeer: PeerIdentity = {
  id: "visitor-1",
  kind: "human",
  trustLevel: "public",
  publicSubstate: "anonymous",
  sourceAugment: "webTransport",
};

function parseToolResult(value: string | { content: string }): unknown {
  return JSON.parse(typeof value === "string" ? value : value.content);
}

function makeWebFetchAugment(): Augment {
  return {
    name: "webFetch",
    type: "webFetch",
    category: "capabilities",
    tools: [
      defineTool({
        name: "web_fetch",
        description: "Fetch a URL.",
        category: "search",
        input: z.object({ url: z.string() }),
        execute: async () => "ok",
      }),
    ],
  };
}

describe("auggySelf augment", () => {
  test("returns creator-visible sanitized runtime inventory", async () => {
    writeSkill("auggy", "Build out this agent.");
    writeSkill("webFetch", "Fetch URLs.");
    writeFileSync(join(tempDir, ".env"), "SECRET_TOKEN=do-not-return");

    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        displayName: "Demo",
        purpose: "help visitors",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
        creator: { displayName: "Alex" },
      },
      configs: [{ name: "webFetch", type: "webFetch", options: { timeoutMs: 15000 } }],
      augments: [makeWebFetchAugment()],
      version: "1.2.3",
    });

    const infoTool = aug.tools!.find((tool) => tool.name === "auggy_self_info")!;
    const parsed = parseToolResult(await infoTool.execute({}, makeContext(creatorPeer))) as {
      status: string;
      agent: { name: string; creatorDisplayName: string; engine: { provider: string } };
      augments: Array<{
        type: string;
        hasSkill: boolean;
        skillMissing: boolean;
        toolCount: number;
        hasContext: boolean;
        capabilities?: unknown;
      }>;
      skills: Array<{ folder: string; frontmatterValid: boolean }>;
      available: { stable: Array<{ type: string }>; preview: Array<{ type: string }> };
    };

    expect(parsed.status).toBe("ok");
    expect(parsed.agent.name).toBe("demo");
    expect(parsed.agent.creatorDisplayName).toBe("Alex");
    expect(parsed.agent.engine.provider).toBe("anthropic");
    expect(parsed.augments).toContainEqual(
      expect.objectContaining({
        type: "webFetch",
        hasSkill: true,
        skillMissing: false,
        toolCount: 1,
        hasContext: false,
      }),
    );
    expect(parsed.augments[0]).not.toHaveProperty("capabilities");
    expect(parsed.skills).toContainEqual(
      expect.objectContaining({ folder: "auggy", frontmatterValid: true }),
    );
    expect(parsed.available.stable.map((entry) => entry.type)).toContain("knowledge");
    expect(parsed.available.preview.map((entry) => entry.type)).toContain("budgets");
    expect(JSON.stringify(parsed)).not.toContain("do-not-return");
  });

  test("reports the running package version when no test override is supplied", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [],
      augments: [],
    });

    const infoTool = aug.tools!.find((tool) => tool.name === "auggy_self_info")!;
    const parsed = parseToolResult(await infoTool.execute({}, makeContext(creatorPeer))) as {
      agent: { runtimeVersion: string | null };
    };

    expect(parsed.agent.runtimeVersion).toBe(pkg.version);
  });

  test("catalog grounds custom-augment guidance even before the reference is read", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [],
      augments: [],
    });

    const catalogTool = aug.tools!.find((tool) => tool.name === "auggy_self_catalog")!;
    const parsed = parseToolResult(await catalogTool.execute({}, makeContext(creatorPeer))) as {
      customAugment: {
        command: string;
        runtimePath: string;
        optionalSkillPath: string;
        requiredReference: string;
        implementationApi: string[];
        authorizationDecisions: string[];
      };
    };

    expect(parsed.customAugment.command).toBe("auggy augment create <name>");
    expect(parsed.customAugment.runtimePath).toBe("augments/<name>/");
    expect(parsed.customAugment.optionalSkillPath).toBe("skills/<name>/SKILL.md");
    expect(parsed.customAugment.requiredReference).toBe(
      "skills/auggy/references/routes-tools-augments.md",
    );
    expect(parsed.customAugment.implementationApi).toEqual([
      "defineAugment",
      "defineTool",
      "defineRoute",
      "Zod schemas",
    ]);
    expect(parsed.customAugment.authorizationDecisions).toEqual([
      "route caller authentication (`auth`)",
      "delegated scopes or grants (`requires`)",
      "tool visibility by trust level (`constraints.perTrustLevel`)",
    ]);
  });

  test("is structurally hidden from non-creator peers and denies fabricated calls", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [],
      augments: [],
    });

    const capability = createCapabilityTable([aug]);
    expect(capability.canExpose("auggy_self_info", makeTurn(creatorPeer))).toBe(true);
    expect(capability.canExpose("auggy_self_info", makeTurn(publicPeer))).toBe(false);

    const infoTool = aug.tools!.find((tool) => tool.name === "auggy_self_info")!;
    const parsed = parseToolResult(await infoTool.execute({}, makeContext(publicPeer))) as {
      status: string;
      message: string;
    };
    expect(parsed.status).toBe("denied");
    expect(parsed.message).toContain("verified creator");
  });

  test("recommends the smallest extension point for common build-out goals", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [{ name: "knowledge", type: "knowledge", options: {} }],
      augments: [],
    });

    const recommendTool = aug.tools!.find((tool) => tool.name === "auggy_self_recommend")!;
    const parsed = parseToolResult(
      await recommendTool.execute(
        { goal: "I want you to answer questions from my product docs." },
        makeContext(creatorPeer),
      ),
    ) as {
      status: string;
      recommendation: { kind: string; alreadyInstalled: boolean; nextSteps: string[] };
    };

    expect(parsed.status).toBe("ok");
    expect(parsed.recommendation.kind).toBe("knowledge");
    expect(parsed.recommendation.alreadyInstalled).toBe(true);
    expect(parsed.recommendation.nextSteps.join("\n")).toContain("knowledge/local");
  });

  test("requires the canonical reference and authorization decisions for custom augments", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [],
      augments: [],
    });

    const recommendTool = aug.tools!.find((tool) => tool.name === "auggy_self_recommend")!;
    const parsed = parseToolResult(
      await recommendTool.execute(
        { goal: "Check what's installed and then talk to me about creating a new augment." },
        makeContext(creatorPeer),
      ),
    ) as {
      recommendation: {
        kind: string;
        requiredReference: string;
        nextSteps: string[];
        authorizationDecisions: string[];
      };
    };

    expect(parsed.recommendation.kind).toBe("custom-augment");
    expect(parsed.recommendation.requiredReference).toBe(
      "skills/auggy/references/routes-tools-augments.md",
    );
    expect(parsed.recommendation.nextSteps).toContain(
      "Read `skills/auggy/references/routes-tools-augments.md` with `fs_read` before giving implementation details.",
    );
    expect(parsed.recommendation.authorizationDecisions).toHaveLength(3);
    expect(parsed.recommendation.nextSteps.join("\n")).not.toContain("augments/<name>/SKILL.md");
  });

  test("describes layered memory as a stable add-on when it is not installed", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [{ name: "fileMemory", type: "fileMemory", options: {} }],
      augments: [],
    });

    const recommendTool = aug.tools!.find((tool) => tool.name === "auggy_self_recommend")!;
    const parsed = parseToolResult(
      await recommendTool.execute(
        { goal: "I want you to remember repeat visitors." },
        makeContext(creatorPeer),
      ),
    ) as {
      recommendation: {
        title: string;
        why: string;
        alreadyInstalled: boolean;
        nextSteps: string[];
      };
    };

    expect(parsed.recommendation.title).toBe(
      "Layered Memory — stable add-on, not installed in this agent",
    );
    expect(parsed.recommendation.why).toContain("automatic extraction is off by default");
    expect(parsed.recommendation.alreadyInstalled).toBe(false);
    expect(parsed.recommendation.nextSteps).toContain("Run `auggy augment add layeredMemory`.");
    expect(parsed.recommendation.nextSteps).toContain(
      "Use `auggy agentmail setup visitorAuth` for production magic-link email.",
    );
  });

  test("describes layered memory as installed without recommending reinstall", async () => {
    const aug = auggySelf({
      agentDir: tempDir,
      agent: {
        name: "demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      configs: [
        { name: "layeredMemory", type: "layeredMemory", options: {} },
        { name: "visitorAuth", type: "visitorAuth", options: {} },
      ],
      augments: [],
    });

    const recommendTool = aug.tools!.find((tool) => tool.name === "auggy_self_recommend")!;
    const parsed = parseToolResult(
      await recommendTool.execute(
        { goal: "How do you remember people?" },
        makeContext(creatorPeer),
      ),
    ) as {
      recommendation: {
        title: string;
        alreadyInstalled: boolean;
        nextSteps: string[];
      };
    };

    expect(parsed.recommendation.title).toBe("Layered Memory — installed in this agent");
    expect(parsed.recommendation.alreadyInstalled).toBe(true);
    expect(parsed.recommendation.nextSteps.join("\n")).not.toContain(
      "auggy augment add layeredMemory",
    );
    expect(parsed.recommendation.nextSteps.join("\n")).toContain(
      "memory_write({ topic, content })",
    );
  });
});
