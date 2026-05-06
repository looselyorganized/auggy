import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-lm-validator-test");

const BASE = `
id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c
name: test-agent
engine:
  provider: anthropic
  model: claude-sonnet-4-6
augments:
`;

function writeYaml(content: string): string {
  const path = join(TMP, "agent.yaml");
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("validateLayeredMemoryOptions", () => {
  it("accepts valid nested autoSave shape", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave:
        enabled: true
        extractionFrequency:
          creator: every-turn
          agent: every-N-turns
          public:
            recognized: every-turn
            anonymous: session-end-only
        everyNTurns: 3
        confidenceThreshold: 0.5
`,
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  it("rejects flat key 'public.recognized'", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave:
        extractionFrequency:
          "public.recognized": every-turn
`,
    );
    expect(() => parseConfig(path)).toThrow(/nested|public\.recognized/);
  });

  it("rejects unknown frequency value for creator", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave:
        extractionFrequency:
          creator: every-second-turn
`,
    );
    expect(() => parseConfig(path)).toThrow(/frequency/);
  });

  it("rejects unknown frequency value for public.anonymous", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave:
        extractionFrequency:
          public:
            anonymous: maybe-someday
`,
    );
    expect(() => parseConfig(path)).toThrow(/frequency/);
  });

  it("autoSave is optional", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
`,
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  it("rejects autoSave that is not an object", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave: "yes please"
`,
    );
    expect(() => parseConfig(path)).toThrow(/autoSave/);
  });

  it("rejects autoSave.enabled that is not a boolean", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave:
        enabled: "yes"
`,
    );
    expect(() => parseConfig(path)).toThrow(/enabled/);
  });

  it("rejects autoSave.everyNTurns that is not a number", () => {
    const path = writeYaml(
      `${BASE}  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: test
      dbPath: ./memory.sqlite
      autoSave:
        everyNTurns: "three"
`,
    );
    expect(() => parseConfig(path)).toThrow(/everyNTurns/);
  });
});
