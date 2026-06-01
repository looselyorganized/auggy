import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { defineAgent } from "@/index";
import { notify } from "@/augments/notify";
import { fileMemory } from "@/augments/fileMemory";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

// ──────────────────────────────────────────────────────────────────────────────
// notify integration tests
//
// AgentHandle has no listTools() — tool registration lives on the Augment.tools
// field. The integration checks:
//   1. notify augment mounts cleanly and exposes a "notify" tool.
//   2. Without notify mounted, no "notify" tool appears in augments.
// ──────────────────────────────────────────────────────────────────────────────

describe("notify integration", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("notify augment mounts cleanly; tool surface visible", async () => {
    writeFileSync(join(tmp.path, "id.md"), "# Test agent");

    const notifyAugment = notify({
      destinations: [{ name: "creator", transport: "webhook", url: "https://example.com/notify" }],
    });

    const model = createMockModel({ response: "ok" });

    // defineAgent must not throw — augment mounts cleanly
    expect(() =>
      defineAgent(
        {
          name: "test-notify-agent",
          purpose: "test",
          model: "mock",
          augments: [
            fileMemory({
              label: "id",
              source: join(tmp.path, "id.md"),
              mutable: false,
              origin: "operator",
              priority: "required",
              placement: "system",
              eviction: "never",
            }),
            notifyAugment,
          ],
        },
        model,
      ),
    ).not.toThrow();

    // Augment exposes a "notify" tool
    const notifyTool = notifyAugment.tools?.find((t) => t.name === "notify");
    expect(notifyTool).toBeDefined();
  });

  it("without notify mounted; no notify tool in augments", async () => {
    writeFileSync(join(tmp.path, "id.md"), "# Test agent");

    const idAugment = fileMemory({
      label: "id",
      source: join(tmp.path, "id.md"),
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });

    const model = createMockModel({ response: "ok" });

    // defineAgent must not throw
    expect(() =>
      defineAgent(
        {
          name: "test-no-notify-agent",
          purpose: "test",
          model: "mock",
          augments: [idAugment],
        },
        model,
      ),
    ).not.toThrow();

    // No notify tool present in augments
    const notifyTool = idAugment.tools?.find((t) => t.name === "notify");
    expect(notifyTool).toBeUndefined();
  });
});
