import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MigrationReport } from "../../src/cli/authoring/migration";
import {
  assertAuthoringMigrationReport,
  createAuthoringInferenceGate,
  authoringPrivateMetadataDigest,
  runInstalledAuthoringMigration,
} from "../../scripts/release-smoke/authoring-migration";

const planned: MigrationReport = {
  schemaVersion: 1,
  mode: "config",
  status: "planned",
  project: { directory: "/fixture", configPath: "/fixture/agent.yaml", format: "referenced" },
  fingerprint: "planned-fingerprint",
  operationId: null,
  activation: null,
  changes: [],
  declarations: [],
  preserved: [],
  manualActions: [],
  diagnostics: [],
};

test("installed migration oracle distinguishes plan, mutation, activation and redacted output", () => {
  assertAuthoringMigrationReport(planned, "config", "planned");
  expect(() => assertAuthoringMigrationReport(planned, "application", "planned")).toThrow(
    "disagrees",
  );
  expect(() =>
    assertAuthoringMigrationReport(
      { ...planned, operationId: "unexpected-write" },
      "config",
      "planned",
    ),
  ).toThrow("no operation");
  expect(() =>
    assertAuthoringMigrationReport({ ...planned, status: "complete" }, "config", "complete"),
  ).toThrow("activation evidence");
  expect(() =>
    assertAuthoringMigrationReport(
      { ...planned, manualActions: ["migration-private-canary"] },
      "config",
      "planned",
    ),
  ).toThrow("private option");
  expect(typeof runInstalledAuthoringMigration).toBe("function");
});

test("private inventory detects receipt creation and refuses links without reading preimages", () => {
  const root = mkdtempSync(join(tmpdir(), "authoring-private-metadata-"));
  try {
    const before = authoringPrivateMetadataDigest(root);
    mkdirSync(join(root, ".auggy"));
    writeFileSync(join(root, ".auggy/receipt"), "private-canary");
    const after = authoringPrivateMetadataDigest(root);
    expect(after).not.toBe(before);
    expect(after).not.toContain("private-canary");
    symlinkSync(join(root, ".auggy/receipt"), join(root, ".auggy/link"));
    expect(() => authoringPrivateMetadataDigest(root)).toThrow("nonregular");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inference gate holds a real request, excludes concurrent holds and settles on forced cleanup", async () => {
  let calls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return new Response("forwarded");
    },
  });
  const gate = createAuthoringInferenceGate(`http://127.0.0.1:${provider.port}`);
  try {
    expect(() => createAuthoringInferenceGate("https://example.com/")).toThrow("loopback");
    const held = gate.hold();
    const response = fetch(`${gate.baseURL}/v1/messages`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    await held.entered();
    expect(calls).toBe(0);
    expect(() => gate.hold()).toThrow("one inference");
    held.release();
    expect(await (await response).text()).toBe("forwarded");
    expect(calls).toBe(1);
    const abandoned = gate.hold();
    const stopped = fetch(`${gate.baseURL}/v1/messages`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    }).then(
      (value) => value.status,
      () => null,
    );
    await abandoned.entered();
    await gate.stop();
    expect(await stopped).not.toBe(200);
    expect(calls).toBe(1);
  } finally {
    await gate.stop();
    await provider.stop(true);
  }
});
