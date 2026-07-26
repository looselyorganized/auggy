import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRestartTarget } from "../../src/cli/commands/restart";
import type { PidManifest } from "../../src/cli/types";

const roots: string[] = [];
const AGENT_A = "aug1_11111111-1111-4111-8111-111111111111";
const AGENT_B = "aug1_22222222-2222-4222-8222-222222222222";

function configYaml(id: string, name: string): string {
  return `id: ${id}\nname: ${name}\nengine:\n  provider: anthropic\n  model: claude-sonnet-4-6\naugments:\n  - type: webFetch\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(id: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), "restart-target-"));
  roots.push(root);
  const path = join(root, "agent.yaml");
  writeFileSync(path, configYaml(id, name));
  return path;
}

function manifest(configPath: string): PidManifest {
  return {
    pid: process.pid,
    name: "agent-b",
    agentId: AGENT_B,
    claimNonce: "22222222-2222-4222-8222-222222222222",
    processIdentity: "test-process:agent-b",
    resourceClaims: [],
    resourceClaimStore: "sqlite-v1",
    port: null,
    configPath,
    agentDir: resolve(configPath, ".."),
    startedAt: new Date().toISOString(),
    mode: "dev",
  };
}

describe("restart target validation", () => {
  test("rejects another agent's config path before restart side effects", () => {
    const configB = config(AGENT_B, "agent-b");
    const configA = config(AGENT_A, "agent-a");
    expect(() => assertRestartTarget(manifest(configB), configA)).toThrow(
      /config path does not match/i,
    );
  });

  test("rejects an identity change at the exact running config path", () => {
    const configB = config(AGENT_B, "agent-b");
    const running = manifest(configB);
    writeFileSync(configB, configYaml(AGENT_A, "agent-a"));
    expect(() => assertRestartTarget(running, configB)).toThrow(/identity does not match/i);
  });

  test("admits the exact path and immutable identity", () => {
    const configB = config(AGENT_B, "agent-b");
    expect(assertRestartTarget(manifest(configB), configB)).toBe(resolve(configB));
  });
});
