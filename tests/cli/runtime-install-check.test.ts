import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkAgentRuntimeInstall } from "../../src/cli/runtime-install-check";
import { AUGGY_RUNTIME_PACKAGE_MARKER } from "../../src/cli/runtime-package-marker";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "auggy-runtime-install-"));
}

function writeAuggyPackage(agentDir: string, opts: { marker?: boolean } = {}): void {
  const auggyDir = join(agentDir, "node_modules", "auggy");
  mkdirSync(join(auggyDir, "src", "cli"), { recursive: true });
  writeFileSync(
    join(auggyDir, "package.json"),
    JSON.stringify({ name: "auggy", version: "0.4.4" }, null, 2),
  );
  if (opts.marker) {
    writeFileSync(
      join(auggyDir, "src", "cli", "runtime-package-marker.ts"),
      `export const AUGGY_RUNTIME_PACKAGE_MARKER = ${JSON.stringify(AUGGY_RUNTIME_PACKAGE_MARKER)};\n`,
    );
  }
}

describe("checkAgentRuntimeInstall", () => {
  test("passes when the agent-local auggy package has the runtime marker", () => {
    const agentDir = fixture();
    writeAuggyPackage(agentDir, { marker: true });

    expect(checkAgentRuntimeInstall(agentDir)).toEqual({ ok: true });
  });

  test("fails clearly when node_modules/auggy is missing", () => {
    const result = checkAgentRuntimeInstall(fixture());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("node_modules/auggy was not found");
    expect(result.fix).toContain("bun install");
  });

  test("fails clearly when a stale package with the same semver was installed", () => {
    const agentDir = fixture();
    writeAuggyPackage(agentDir);

    const result = checkAgentRuntimeInstall(agentDir);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match this CLI's runtime shape");
    expect(result.fix).toContain("AUGGY_SCAFFOLD_AUGGY_SPEC");
  });
});
