import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateSourceIndex } from "../../scripts/generate-source-index";
import { BUILTIN_TYPE_NAMES } from "../../src/cli/builtin-types";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import { readInstalledSourceIndex } from "../../src/cli/authoring/inspection-index";
import { fixtureIndex, inspectionFixture, writeFixture } from "../cli/inspect-fixtures";

const repository = resolve(import.meta.dir, "../..");
let fixture: ReturnType<typeof inspectionFixture>;
beforeEach(() => {
  fixture = inspectionFixture();
});
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));
function index(value: unknown) {
  writeFileSync(fixture.indexPath, JSON.stringify(value));
}

describe("installed source index", () => {
  test("accepts the full source-index document bound", () => {
    const bytes = JSON.stringify(fixtureIndex);
    writeFileSync(
      fixture.indexPath,
      bytes + " ".repeat(AUTHORING_LIMITS.documentBytes - Buffer.byteLength(bytes)),
    );
    expect(readInstalledSourceIndex(fixture.runtime).status).toBe("available");
    writeFileSync(
      fixture.indexPath,
      bytes + " ".repeat(AUTHORING_LIMITS.documentBytes + 1 - Buffer.byteLength(bytes)),
    );
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow(/byte limit/);
  });

  test("generated index covers real resolver dispatch and bundled source paths", () => {
    const generated = generateSourceIndex(repository, { check: true });
    const resolver = readFileSync(join(repository, "src/cli/augment-resolver.ts"), "utf8");
    const dispatched = [...resolver.matchAll(/^\s+case "([A-Za-z]+)":/gm)]
      .map((match) => match[1]!)
      .filter((name) => name !== "custom");
    expect([...new Set(dispatched)].sort()).toEqual([...BUILTIN_TYPE_NAMES].sort());
    expect(generated.augments.map((entry) => entry.type).sort()).toEqual(
      [...new Set(dispatched)].sort(),
    );
    expect(generated.augments).toHaveLength(17);
    for (const entry of generated.augments) {
      const resolverPath = entry.entrypoint
        .replace(/^src\//, "../")
        .replace(/\/index\.ts$/, "")
        .replace(/\.ts$/, "");
      expect(resolver).toContain(`"${resolverPath}"`);
    }
    expect(generated.augments.find((item) => item.type === "webTransport")?.entrypoint).toBe(
      "src/transports/web-transport.ts",
    );
    expect(generated.augments.some((item) => item.type === "skills")).toBe(true);
    expect(generated.augments.some((item) => item.type === "supabaseMemory")).toBe(true);
    expect(readInstalledSourceIndex(repository).status).toBe("available");
  });
  test("check CLI succeeds for the tracked index", () => {
    const result = Bun.spawnSync(
      [process.execPath, "scripts/generate-source-index.ts", "--check"],
      { cwd: repository },
    );
    expect(result.exitCode).toBe(0);
  });
  test.each([undefined, 0, 99])("missing or unsupported schema %s is unavailable", (version) => {
    if (version === undefined) rmSync(fixture.indexPath);
    else index({ schemaVersion: version });
    expect(readInstalledSourceIndex(fixture.runtime).status).toBe("unavailable");
  });
  test.each(
    [
      null,
      [],
      {},
      { schemaVersion: "1" },
      { schemaVersion: 1 },
      { ...fixtureIndex, extra: true },
      { ...fixtureIndex, runtime: { ...fixtureIndex.runtime, turn: 3 } },
      { ...fixtureIndex, augments: [...fixtureIndex.augments, fixtureIndex.augments[0]] },
      {
        ...fixtureIndex,
        augments: [
          {
            type: "fileMemory",
            entrypoint: "src/augments/fileMemory/index.ts",
            options: { secret: "never" },
          },
        ],
      },
    ].map((value) => ({ value })),
  )("corrupt known-schema metadata fails closed (%#)", ({ value }) => {
    index(value);
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow();
  });
  test.each([
    "../outside.ts",
    "/absolute.ts",
    "C:\\escape.ts",
    "src/../outside.ts",
    "src//double.ts",
    "./src/file.ts",
    "https://user:secret@example.test/index.ts",
    "${SOURCE}/index.ts",
  ])("rejects unsafe path %s", (path) => {
    index({ ...fixtureIndex, augments: [{ type: "fileMemory", entrypoint: path }] });
    try {
      readInstalledSourceIndex(fixture.runtime);
      throw new Error("expected invalid index");
    } catch (error) {
      expect(String(error)).not.toContain(path);
    }
  });
  test("source and index symlink escapes are invalid, including missing leaves", () => {
    const outside = join(fixture.root, "outside.ts");
    writeFileSync(outside, 'throw new Error("never");');
    const entrypoint = join(fixture.runtime, "src/augments/fileMemory/index.ts");
    rmSync(entrypoint);
    symlinkSync(outside, entrypoint);
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("escapes");
    rmSync(outside);
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("escapes");
    rmSync(entrypoint);
    writeFileSync(entrypoint, "");
    const externalIndex = join(fixture.root, "outside-index.json");
    cpSync(fixture.indexPath, externalIndex);
    rmSync(fixture.indexPath);
    symlinkSync(externalIndex, fixture.indexPath);
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("escapes");
  });
  test("internal file links remain contained and indexed directories have the right kind", () => {
    const entrypoint = join(fixture.runtime, "src/augments/fileMemory/index.ts");
    writeFixture(join(fixture.runtime, "src/shared.ts"), "");
    rmSync(entrypoint);
    symlinkSync(join(fixture.runtime, "src/shared.ts"), entrypoint);
    expect(readInstalledSourceIndex(fixture.runtime).status).toBe("available");
    index({
      ...fixtureIndex,
      augments: [{ type: "fileMemory", entrypoint: "src/shared.ts", directory: "src/shared.ts" }],
    });
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("ordinary source");
  });
  test("stale files, FIFOs, excessive bytes and excessive JSON depth fail boundedly", () => {
    rmSync(join(fixture.runtime, fixtureIndex.runtime.turn));
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("stale source metadata");
    writeFixture(join(fixture.runtime, fixtureIndex.runtime.turn), "");
    writeFileSync(fixture.indexPath, "x".repeat(AUTHORING_LIMITS.documentBytes + 1));
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("byte limit");
    writeFileSync(
      fixture.indexPath,
      `{"schemaVersion":2,"extra":${"[".repeat(65)}0${"]".repeat(65)}}`,
    );
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("corrupt");
    rmSync(fixture.indexPath);
    expect(Bun.spawnSync(["mkfifo", fixture.indexPath]).exitCode).toBe(0);
    const started = performance.now();
    expect(() => readInstalledSourceIndex(fixture.runtime)).toThrow("ordinary source");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
