/**
 * Drift guard: every transport listed in `NOTIFY_TRANSPORTS` (the augment's
 * source of truth) MUST be accepted by the config-parser destination
 * validator. The class of bug this catches: adding a new adapter to the
 * augment + types + factory but forgetting to update the parser's
 * if/else chain (which previously hardcoded "webhook"|"telegram"|"agentmail").
 *
 * If you add a new transport, you'll need:
 *   1. Push the name into NOTIFY_TRANSPORTS (src/augments/notify/index.ts)
 *   2. Add the destination interface + union member in src/types.ts
 *   3. Add a per-transport branch in src/cli/config-parser.ts validator
 *   4. Add a minimal-valid options shape in MINIMAL_VALID below
 *   5. Wire the adapter factory in src/augments/notify/index.ts defaults
 *
 * (4) is enforced by `Record<(typeof NOTIFY_TRANSPORTS)[number], ...>` —
 * if you skip it, TypeScript fails this file at type-check time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@/cli/config-parser";
import { NOTIFY_TRANSPORTS } from "@/augments/notify";

const MINIMAL_VALID: Record<(typeof NOTIFY_TRANSPORTS)[number], Record<string, unknown>> = {
  webhook: { url: "http://example.test" },
  telegram: { botToken: "x", chatId: 1 },
  agentmail: { apiKey: "x", inboxId: "x", to: "a@b.test" },
  "log-to-file": { path: "./n.jsonl" },
};

function buildYaml(transport: string, extra: Record<string, unknown>): string {
  const extraLines = Object.entries(extra)
    .map(([k, v]) => `          ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `id: aug1_00000000-0000-0000-0000-000000000000
name: t
operators: [op]
engine:
  provider: anthropic
  model: claude-sonnet-4-6
augments:
  - name: notify
    type: notify
    options:
      destinations:
        - name: x
          transport: ${transport}
${extraLines}
`;
}

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "notify-drift-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("notify transport whitelist drift", () => {
  for (const transport of NOTIFY_TRANSPORTS) {
    it(`parser accepts transport=${transport}`, () => {
      const yamlPath = join(tempDir, "agent.yaml");
      writeFileSync(yamlPath, buildYaml(transport, MINIMAL_VALID[transport]));
      // parseConfig throws on validation errors. The failure mode this test
      // guards against is the `transport: must be ...` message specifically.
      // We don't expect-no-throw outright (other env-var validation may also
      // fail), but we assert the throw message — if any — does NOT contain
      // the whitelist-drift error.
      try {
        parseConfig(yamlPath);
      } catch (err) {
        expect((err as Error).message).not.toMatch(/transport: must be/);
      }
    });
  }
});
