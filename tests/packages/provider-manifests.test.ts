import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const ADAPTERS = ["anthropic", "openai", "openrouter", "ollama"] as const;

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

describe("published provider package contracts", () => {
  const rootManifest = readManifest(join(ROOT, "package.json"));

  for (const adapter of ADAPTERS) {
    test(`@auggy/${adapter} declares its core runtime contract`, () => {
      const manifest = readManifest(join(ROOT, "packages", adapter, "package.json"));
      const expectedRange = `^${rootManifest.version}`;

      expect(manifest.version).toBe(rootManifest.version);
      expect(manifest.peerDependencies?.auggy).toBe(expectedRange);
      expect(manifest.peerDependenciesMeta?.auggy?.optional).toBe(true);
      expect(rootManifest.devDependencies?.[manifest.name]).toBe("workspace:*");
    });
  }

  test("@auggy/openrouter declares its local adapter dependency in lockstep", () => {
    const manifest = readManifest(join(ROOT, "packages/openrouter/package.json"));

    expect(manifest.dependencies?.["@auggy/openai"]).toBe(`^${rootManifest.version}`);
  });

  test("pins every audited transitive dependency to a reviewed fixed release", () => {
    expect(rootManifest.overrides).toEqual({
      "@hono/node-server": "2.0.11",
      "body-parser": "2.3.0",
      "fast-uri": "3.1.4",
      hono: "4.12.31",
    });
  });

  test("@hono/node-server v2 preserves the MCP SDK integration export", async () => {
    const nodeServer = await import("@hono/node-server");
    const { StreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    );

    expect(typeof nodeServer.getRequestListener).toBe("function");
    expect(new StreamableHTTPServerTransport()).toBeInstanceOf(StreamableHTTPServerTransport);
  });
});
