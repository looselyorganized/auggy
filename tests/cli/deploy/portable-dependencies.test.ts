import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPortableDependencies,
  parseDependencyJSON,
} from "../../../src/cli/deploy/portable-dependencies";
import { DEPLOYMENT_LIMITS } from "../../../src/cli/deploy/contracts";
import { exportDocker } from "../../../src/cli/commands/export";
import { fixture, packageArchive, tarball } from "./portable-fixtures";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-dependencies-"));
  fixture(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function inspect(files = ["vendor/auggy.tgz"], pkg?: unknown, lock?: unknown) {
  return inspectPortableDependencies(
    root,
    pkg === undefined ? readFileSync(join(root, "package.json")) : Buffer.from(JSON.stringify(pkg)),
    lock === undefined ? readFileSync(join(root, "bun.lock")) : Buffer.from(JSON.stringify(lock)),
    new Set(files),
  );
}
function lockValue() {
  return JSON.parse(readFileSync(join(root, "bun.lock"), "utf8"));
}
const metadata = () => ({ name: "fixture", dependencies: { auggy: "file:./vendor/auggy.tgz" } });

describe("contained dependency closure", () => {
  test("understands Bun trailing commas without evaluating syntax or accepting duplicate keys", () => {
    expect(parseDependencyJSON('{"lockfileVersion":1,"packages":{},}', true)).toEqual({
      lockfileVersion: 1,
      packages: {},
    });
    for (const text of [
      '{"a":1,"a":2}',
      '{"a":(()=>42)()}',
      '{"a":1}//comment',
      '{"a":1,}',
      "[1,,2]",
    ])
      expect(() => parseDependencyJSON(text)).toThrow();
  });
  test("rejects URLs, credentials, Git, absolute/directory/workspace sources in every dependency-bearing field", async () => {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "overrides",
      "resolutions",
    ]) {
      for (const spec of [
        "https://user:SECRET_TOKEN@example.invalid/package.tgz",
        "git+ssh://host/project",
        "github:org/repo",
        "org/repo",
        "workspace:*",
        "link:./dir",
        "file:/absolute.tgz",
        "file:../escape.tgz",
        "file:./folder",
        "file:./%2e%2e/escape.tgz",
      ]) {
        const pkg = {
          ...metadata(),
          [field]: { ...(field === "dependencies" ? metadata().dependencies : {}), unsafe: spec },
        };
        try {
          await inspect(undefined, pkg);
          throw new Error("should have refused");
        } catch (error) {
          expect(String(error)).not.toContain("SECRET_TOKEN");
          expect(String(error)).not.toContain("should have refused");
        }
      }
    }
  });
  test("inspects root-relative nested archives once, including a cyclic closure", async () => {
    writeFileSync(
      join(root, "vendor", "auggy.tgz"),
      packageArchive("auggy", { child: "file:./vendor/child.tgz" }),
    );
    writeFileSync(
      join(root, "vendor", "child.tgz"),
      packageArchive("child", { auggy: "file:./vendor/auggy.tgz" }),
    );
    const lock = lockValue();
    lock.packages.auggy[1] = { dependencies: { child: "file:./vendor/child.tgz" } };
    lock.packages.child = [
      "child@./vendor/child.tgz",
      { dependencies: { auggy: "file:./vendor/auggy.tgz" } },
      "sha512-fixture",
    ];
    expect(await inspect(["vendor/auggy.tgz", "vendor/child.tgz"], undefined, lock)).toEqual([
      "vendor/auggy.tgz",
      "vendor/child.tgz",
    ]);
  });
  test("rejects unsupported or contradictory local lock graphs without rewriting", async () => {
    const unknown = lockValue();
    unknown.lockfileVersion = 999;
    await expect(inspect(undefined, undefined, unknown)).rejects.toThrow("Unsupported Bun lock");
    const extra = lockValue();
    extra.packages.child = ["child@./vendor/child.tgz", {}, "sha512-fixture"];
    await expect(inspect(undefined, undefined, extra)).rejects.toThrow("outside the inspected");
    writeFileSync(
      join(root, "vendor", "auggy.tgz"),
      packageArchive("auggy", { child: "file:./vendor/child.tgz" }),
    );
    writeFileSync(join(root, "vendor", "child.tgz"), packageArchive("child"));
    await expect(inspect(["vendor/auggy.tgz", "vendor/child.tgz"])).rejects.toThrow(
      "absent from the text lock",
    );
  });
  test("rejects archive links, escaping paths, ambiguous manifests and corrupt headers", async () => {
    const packageJson = {
      name: "package/package.json",
      bytes: Buffer.from('{"name":"auggy","version":"1.0.0"}'),
    };
    for (const entries of [
      [packageJson, { name: "package/../../escape", bytes: Buffer.from("evil") }],
      [packageJson, { name: "/absolute", bytes: Buffer.from("evil") }],
      [packageJson, { name: "package/link", type: "2" }],
      [packageJson, { name: "package/hardlink", type: "1" }],
      [packageJson, packageJson],
      [{ name: "other/package.json", bytes: packageJson.bytes }],
      [{ ...packageJson, size: DEPLOYMENT_LIMITS.archiveManifestBytes + 1 }],
      [packageJson, { name: "package/huge", size: DEPLOYMENT_LIMITS.archiveExpandedBytes + 1 }],
    ]) {
      writeFileSync(join(root, "vendor", "auggy.tgz"), tarball(entries));
      await expect(inspect()).rejects.toThrow();
    }
    writeFileSync(join(root, "vendor", "auggy.tgz"), Buffer.from("not gzip"));
    await expect(inspect()).rejects.toThrow("archive is invalid");
  });
  test("caps archive entry counts cumulatively", async () => {
    const entries = [
      { name: "package/package.json", bytes: Buffer.from('{"name":"auggy"}') },
      ...Array.from({ length: DEPLOYMENT_LIMITS.archiveEntries }, (_, i) => ({
        name: `package/entry-${i}`,
        bytes: Buffer.alloc(0),
      })),
    ];
    writeFileSync(join(root, "vendor", "auggy.tgz"), tarball(entries));
    await expect(inspect()).rejects.toThrow("cumulative entry limit");
  });
  test("proves Bun 1.3.14 root-relative closure with a real offline frozen install after export", async () => {
    expect(Bun.version).toBe("1.3.14");
    writeFileSync(
      join(root, "vendor", "auggy.tgz"),
      tarball([
        {
          name: "package/package.json",
          bytes: Buffer.from(
            JSON.stringify({
              name: "auggy",
              version: "1.0.0",
              dependencies: { child: "file:./vendor/child.tgz" },
              devDependencies: { ignored: "workspace:*" },
              workspaces: ["packages/*"],
            }),
          ),
        },
      ]),
    );
    writeFileSync(join(root, "vendor", "child.tgz"), packageArchive("child"));
    unlinkSync(join(root, "bun.lock"));
    const env = {
      ...process.env,
      npm_config_registry: "http://127.0.0.1:1",
      BUN_INSTALL_CACHE_DIR: join(root, "isolated-cache"),
    };
    // Actual package-manager work belongs to this explicit fixture, never exportDocker.
    const installed = Bun.spawnSync([process.execPath, "install", "--ignore-scripts"], {
      cwd: root,
      env,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(installed.exitCode).toBe(0);
    const lockBytes = readFileSync(join(root, "bun.lock"));
    const parent = mkdtempSync(join(tmpdir(), "auggy-frozen-output-"));
    try {
      const exported = await exportDocker({
        cwd: root,
        out: join(parent, "context"),
        ingress: "auto",
      });
      expect(readFileSync(join(root, "bun.lock"))).toEqual(lockBytes);
      expect(readFileSync(join(exported.outputDir, "bun.lock"))).toEqual(lockBytes);
      const frozen = Bun.spawnSync(
        [process.execPath, "install", "--ignore-scripts", "--frozen-lockfile"],
        {
          cwd: exported.outputDir,
          env: { ...env, BUN_INSTALL_CACHE_DIR: join(parent, "fresh-cache") },
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(frozen.exitCode).toBe(0);
      expect(
        JSON.parse(
          readFileSync(join(exported.outputDir, "node_modules", "child", "package.json"), "utf8"),
        ).name,
      ).toBe("child");
      expect(readFileSync(join(exported.outputDir, "bun.lock"))).toEqual(lockBytes);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
