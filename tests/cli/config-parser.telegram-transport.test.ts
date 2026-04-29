import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-tg-transport-test");

function writeYaml(content: string): string {
  const path = join(TMP, "agent.yaml");
  writeFileSync(path, content);
  return path;
}

const BASE = `
id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c
name: test-agent
engine:
  provider: anthropic
  model: claude-sonnet-4-6
augments:
`;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("telegramTransport config validation", () => {
  it("accepts polling mode with timeoutSec", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: polling
        polling:
          timeoutSec: 30
      auth:
        creatorUserIds: [123]
`,
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  it("accepts webhook mode with publicUrl + secretToken", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: webhook
        webhook:
          publicUrl: https://example.com/hook
          port: 8081
          secretToken: SECRET
      auth: {}
`,
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  it("rejects webhook mode missing publicUrl", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: webhook
        webhook:
          secretToken: SECRET
      auth: {}
`,
    );
    expect(() => parseConfig(path)).toThrow("publicUrl");
  });

  it("rejects webhook mode missing secretToken", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: webhook
        webhook:
          publicUrl: https://example.com/hook
      auth: {}
`,
    );
    expect(() => parseConfig(path)).toThrow("secretToken");
  });

  it("rejects unknown inbound.mode value", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: smtp
      auth: {}
`,
    );
    expect(() => parseConfig(path)).toThrow("mode");
  });

  it("rejects missing botToken", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      inbound:
        mode: polling
      auth: {}
`,
    );
    expect(() => parseConfig(path)).toThrow("botToken");
  });

  it("rejects invalid anonymousIdentityMode value", () => {
    const path = writeYaml(
      BASE +
        `  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: polling
      auth:
        anonymousIdentityMode: weird
`,
    );
    expect(() => parseConfig(path)).toThrow("anonymousIdentityMode");
  });
});
