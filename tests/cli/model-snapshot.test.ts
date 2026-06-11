import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelSnapshot,
  modelSnapshotPath,
  readModelSnapshot,
  writeModelSnapshot,
} from "../../src/cli/model-snapshot";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "model-snapshot-test-"));
  roots.push(root);
  return root;
}

describe("model snapshot", () => {
  test("writes and reads the selected model metadata", () => {
    const root = tempRoot();
    const snapshot = createModelSnapshot({
      provider: "anthropic",
      refreshRequested: true,
      warnings: [],
      now: new Date("2026-06-10T12:00:00.000Z"),
      selected: {
        provider: "anthropic",
        model: "claude-fable-5",
        source: "provider",
        status: "live",
        pricingKnown: true,
        pricing: { inputUsdPerMtok: 2, outputUsdPerMtok: 10 },
      },
    });

    writeModelSnapshot(root, snapshot);

    expect(readModelSnapshot(root)).toEqual({ kind: "ok", snapshot });
  });

  test("returns missing when no snapshot exists", () => {
    expect(readModelSnapshot(tempRoot())).toEqual({ kind: "missing" });
  });

  test("returns invalid for malformed snapshots", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".auggy"), { recursive: true });
    writeFileSync(modelSnapshotPath(root), "{");

    const result = readModelSnapshot(root);

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.error).toContain("JSON");
  });
});
