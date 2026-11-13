import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import {
  belowFloor,
  classifyUpgrade,
  hasLegacyServerAdvisory,
  migrateConsumerManifest,
  rebindLocalArtifactIntegrity,
} from "../../scripts/release-smoke/upgrade-consumer";

const fixture = resolve(import.meta.dir, "../fixtures/release-upgrade/retained-lock");
const read = (name: string) => readFileSync(resolve(fixture, name), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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
