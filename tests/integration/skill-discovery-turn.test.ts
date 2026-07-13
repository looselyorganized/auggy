import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defineAgent, extractText } from "@/index";
import { resolveAugments } from "@/cli/augment-resolver";
import { copyBundledSkill, copyStarterSkills } from "@/cli/scaffold-skills";
import type { AgentHandle, PeerIdentity, TurnTrigger } from "@/types";
import { createMockModel, type MockModelClient } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

function peer(trustLevel: "creator" | "public"): PeerIdentity {
  return {
    id: `${trustLevel}-peer`,
    kind: "human",
    trustLevel,
    ...(trustLevel === "public" ? { publicSubstate: "anonymous" as const } : {}),
    sourceAugment: "test",
  };
}

function trigger(trustLevel: "creator" | "public"): TurnTrigger {
  const turnId = `${trustLevel}-skill-discovery`;
  const turnPeer = peer(trustLevel);
  return {
    type: "message",
    turnId,
    threadId: `${turnId}-thread`,
    timestamp: Date.now(),
    source: "test",
    peer: turnPeer,
    payload: {
      parts: [{ kind: "text", text: "How do I add a custom Auggy route?" }],
      sourceAugment: "test",
      peer: turnPeer,
      timestamp: Date.now(),
    },
  };
}

describe("scaffold-to-turn skill discovery", () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let agent: AgentHandle;
  let model: MockModelClient;

  beforeEach(async () => {
    temp = await createTempDir();
    expect(copyStarterSkills(temp.path)).toContain("auggy");
    expect(copyBundledSkill("filesystem", temp.path)).toBe(true);

    const augments = await resolveAugments(
      [
        {
          name: "filesystem",
          type: "filesystem",
          options: {
            mounts: [{ name: "skills", path: "./skills", writable: false }],
          },
        },
      ],
      temp.path,
    );

    model = createMockModel({ response: "ok" });
    agent = defineAgent(
      {
        name: "skill-discovery-test",
        model: "mock",
        augments,
      },
      model,
    );
    await agent.start();
  });

  afterEach(async () => {
    await agent.stop();
    await temp.cleanup();
  });

  it("makes the creator-only Auggy skill discoverable and actionable only for creators", async () => {
    model.pushResponse({
      content: "",
      toolCalls: [
        {
          name: "fs_read",
          arguments: { path: "skills/auggy/SKILL.md" },
        },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Use defineRoute inside a custom augment.",
      finishReason: "end_turn",
    });

    const creatorResult = await agent.inject(trigger("creator"));
    expect(creatorResult.success).toBe(true);
    expect(extractText(creatorResult.response?.parts ?? [])).toBe(
      "Use defineRoute inside a custom augment.",
    );

    const creatorPrompt = model.calls[0]!;
    const creatorSystem = creatorPrompt.systemBlocks.join("\n");
    expect(creatorSystem).toContain("- auggy —");
    expect(creatorSystem).toContain("skills/auggy/SKILL.md");
    expect(creatorPrompt.tools.map((tool) => tool.name)).toContain("fs_read");
    expect(creatorResult.toolCalls).toHaveLength(1);
    expect(creatorResult.toolCalls[0]).toMatchObject({
      name: "fs_read",
      input: { path: "skills/auggy/SKILL.md" },
    });
    expect(creatorResult.toolCalls[0]!.output).toContain("# Auggy Build-Out Coach");

    expect(model.calls).toHaveLength(2);
    const postReadPrompt = model.calls[1]!;
    const toolResultMessages = postReadPrompt.messages.filter(
      (message) => message.role === "tool_result",
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]!.content).toContain("# Auggy Build-Out Coach");

    const publicResult = await agent.inject(trigger("public"));
    expect(publicResult.success).toBe(true);

    const publicPrompt = model.calls[2]!;
    const publicSystem = publicPrompt.systemBlocks.join("\n");
    expect(publicSystem).not.toContain("- auggy —");
    expect(publicSystem).not.toContain("skills/auggy/SKILL.md");
  });
});
