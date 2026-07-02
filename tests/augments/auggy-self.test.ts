import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { auggySelf } from "@/cli/auggy-self-augment";
import { defineTool } from "@/helpers";
import { createCapabilityTable } from "@/kernel/capability-table";
import type { Augment, PeerIdentity, ToolExecuteContext, TurnState } from "@/types";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `auggy-self-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
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
    capabilities: ["tools"],
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
      augments: Array<{ type: string; hasSkill: boolean; skillMissing: boolean }>;
      skills: Array<{ folder: string; frontmatterValid: boolean }>;
      available: { stable: Array<{ type: string }>; preview: Array<{ type: string }> };
    };

    expect(parsed.status).toBe("ok");
    expect(parsed.agent.name).toBe("demo");
    expect(parsed.agent.creatorDisplayName).toBe("Alex");
    expect(parsed.agent.engine.provider).toBe("anthropic");
    expect(parsed.augments).toContainEqual(
      expect.objectContaining({ type: "webFetch", hasSkill: true, skillMissing: false }),
    );
    expect(parsed.skills).toContainEqual(
      expect.objectContaining({ folder: "auggy", frontmatterValid: true }),
    );
    expect(parsed.available.stable.map((entry) => entry.type)).toContain("knowledge");
    expect(parsed.available.preview.map((entry) => entry.type)).toContain("budgets");
    expect(JSON.stringify(parsed)).not.toContain("do-not-return");
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
});
