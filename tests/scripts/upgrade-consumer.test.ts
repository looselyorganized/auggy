import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import {
  belowFloor,
  candidateLinkRange,
  classifyUpgrade,
  hasLegacyServerAdvisory,
  installedPackage,
  migrateConsumerManifest,
  rebindLocalArtifactIntegrity,
  validateLinkArtifact,
} from "../../scripts/release-smoke/upgrade-consumer";

const fixture = resolve(import.meta.dir, "../fixtures/release-upgrade/retained-lock");
const read = (name: string) => readFileSync(resolve(fixture, name), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("candidate Link selection comes from the catalog and rejects a stale or implicit floor", () => {
  const catalog = (range: string) => [{ type: "link", packageDeps: { "@auggy/link": range } }];
  expect(candidateLinkRange(catalog("^0.2.0"))).toBe("^0.2.0");
  expect(candidateLinkRange(catalog("^0.3.0"))).toBe("^0.3.0");
  expect(() => candidateLinkRange(catalog("^0.1.2"))).toThrow("reviewed 0.2.0");
  expect(() => candidateLinkRange(catalog("latest"))).toThrow("explicit dependency floor");
  expect(() => candidateLinkRange([])).toThrow("explicit dependency floor");
});

test("explicit artifact experiments cannot bypass the candidate Link name or version floor", () => {
  expect(validateLinkArtifact({ name: "@auggy/link", version: "0.2.0" }, "^0.2.0")).toBe("0.2.0");
  expect(() => validateLinkArtifact({ name: "other", version: "0.2.0" }, "^0.2.0")).toThrow();
  expect(() => validateLinkArtifact({ name: "@auggy/link", version: "0.1.2" }, "^0.2.0")).toThrow();
  expect(() => validateLinkArtifact({ name: "@auggy/link", version: "0.3.0" }, "^0.2.0")).toThrow();
});

test("metadata lookup follows the owning package's nested dependency without requiring a root export", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-upgrade-metadata-"));
  try {
    const owner = join(root, "node_modules/auggy");
    const nested = join(owner, "node_modules/@modelcontextprotocol/sdk");
    const outer = join(root, "node_modules/@modelcontextprotocol/sdk");
    for (const folder of [root, owner, nested, outer]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"consumer"}');
    writeFileSync(join(owner, "package.json"), '{"name":"auggy","version":"0.5.0"}');
    for (const [folder, version] of [
      [nested, "1.32.2"],
      [outer, "1.29.0"],
    ])
      writeFileSync(
        join(folder!, "package.json"),
        JSON.stringify({
          name: "@modelcontextprotocol/sdk",
          version,
          exports: { ".": "./missing-root.js", "./client": "./client.js" },
        }),
      );
    const result = installedPackage(owner, "@modelcontextprotocol/sdk");
    expect(result.root).toBe(realpathSync(nested));
    expect(result.manifest.version).toBe("1.32.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata lookup inspects installed ws despite Bun's builtin resolution alias", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-upgrade-builtin-"));
  try {
    const owner = join(root, "node_modules/agentmail"),
      ws = join(root, "node_modules/ws");
    mkdirSync(owner, { recursive: true });
    mkdirSync(ws);
    writeFileSync(join(root, "package.json"), '{"name":"consumer"}');
    writeFileSync(join(owner, "package.json"), '{"name":"agentmail","version":"0.5.19"}');
    writeFileSync(join(ws, "package.json"), '{"name":"ws","version":"8.20.0"}');
    expect(installedPackage(owner, "ws").root).toBe(realpathSync(ws));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata lookup rejects unrelated ancestor installations before parsing their metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-upgrade-ancestor-"));
  try {
    const consumer = join(root, "consumer"),
      unrelated = join(root, "node_modules/hono");
    mkdirSync(consumer);
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(consumer, "package.json"), '{"name":"consumer"}');
    writeFileSync(join(unrelated, "package.json"), "not valid JSON");
    expect(() => installedPackage(consumer, "hono")).toThrow("escaped the isolated consumer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata lookup rejects an escaping package.json symlink before parsing its target", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-upgrade-manifest-symlink-"));
  try {
    const consumer = join(root, "consumer");
    const dependency = join(consumer, "node_modules/hono");
    const outside = join(root, "outside.json");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(consumer, "package.json"), '{"name":"consumer"}');
    writeFileSync(outside, "not valid JSON");
    symlinkSync(outside, join(dependency, "package.json"));
    expect(() => installedPackage(consumer, "hono")).toThrow("escaped the isolated consumer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade accepts both same-version replacement and future releases without accepting downgrades", () => {
  expect(classifyUpgrade("0.5.0", "0.5.0")).toBe("same-version-content-change");
  expect(classifyUpgrade("0.5.0", "0.6.0")).toBe("versioned-upgrade");
  expect(classifyUpgrade("0.5.0", "0.6.0-rc.1")).toBe("versioned-upgrade");
  expect(() => classifyUpgrade("0.5.0", "0.4.9")).toThrow("must not downgrade");
  expect(() => classifyUpgrade("0.5.0", "0.5.0-rc.1")).toThrow("must not downgrade");
  expect(() => classifyUpgrade("0.5.0", "latest")).toThrow("valid package versions");
});

test("retained fixture is an actual baseline consumer lock with historical vulnerable versions", () => {
  const provenance = JSON.parse(read("provenance.json"));
  expect(provenance.baselineRevision).toBe("29147dfc7af0de59c3631c34a164ed3f3f6f4d5c");
  expect(provenance.bunVersion).toBe("1.3.14");
  for (const name of ["package.json", "bun.lock"])
    expect(hash(read(name))).toBe(provenance.fixtureFiles[name]);
  const manifest = JSON.parse(read("package.json"));
  expect(Object.keys(manifest.dependencies).sort()).toEqual(["@auggy/anthropic", "auggy"]);
  expect(manifest.overrides).toEqual({ "@hono/node-server": "2.0.11" });
  const lock = parseConfigFileTextToJson("bun.lock", read("bun.lock")).config;
  for (const [name, version] of Object.entries(provenance.historicalVersions))
    expect(lock.packages[name][0]).toBe(`${name}@${version}`);
});

test("artifact rebinding changes only the two local artifact integrity values", () => {
  const original = parseConfigFileTextToJson("bun.lock", read("bun.lock")).config;
  const bound = JSON.parse(
    rebindLocalArtifactIntegrity(read("bun.lock"), {
      auggy: Buffer.from("alternate npm tar encoding"),
      "@auggy/anthropic": Buffer.from("alternate provider tar encoding"),
    }),
  );
  for (const name of ["auggy", "@auggy/anthropic"]) {
    expect(bound.packages[name].at(-1)).not.toBe(original.packages[name].at(-1));
    bound.packages[name][bound.packages[name].length - 1] = original.packages[name].at(-1);
  }
  expect(bound).toEqual(original);
});

test("artifact rebinding refuses to change a registry package's integrity", () => {
  expect(() =>
    rebindLocalArtifactIntegrity(read("bun.lock"), { zod: Buffer.from("replacement") }),
  ).toThrow("Unexpected local artifact entry");
});

test("dependency migration preserves application metadata and unrelated overrides", () => {
  const before = {
    name: "owned-app",
    scripts: { start: "bun src/index.ts" },
    dependencies: { auggy: "file:./candidate.tgz" },
    overrides: { "@hono/node-server": "2.0.11", "application-only": "1.2.3" },
  };
  const migrated = migrateConsumerManifest(before, {
    "@hono/node-server": "2.1.6",
    hono: "4.13.16",
  });
  expect(migrated).toEqual({
    ...before,
    overrides: { "@hono/node-server": "2.1.6", "application-only": "1.2.3", hono: "4.13.16" },
  });
  expect(before.overrides["@hono/node-server"]).toBe("2.0.11");
  expect(() => migrateConsumerManifest(before, { zod: "^4.6.6" })).toThrow(
    "exact dependency versions",
  );
});

test("floor checks compare numeric versions and reject unsupported ranges", () => {
  expect(belowFloor("1.29.0", "^1.32.0")).toBe(true);
  expect(belowFloor("4.6.7", "^4.6.6")).toBe(false);
  expect(belowFloor("2.10.0", "2.9.0")).toBe(false);
  expect(() => belowFloor("3.25.76", "^3 || ^4")).toThrow("Unsupported version format");
});

test("negative control requires a known legacy Hono server advisory", () => {
  expect(hasLegacyServerAdvisory([null, "GHSA-mrhx-c7xc-m3w5"])).toBe(false);
  expect(hasLegacyServerAdvisory(["GHSA-qv5m-9pm6-hqp3"])).toBe(true);
});
