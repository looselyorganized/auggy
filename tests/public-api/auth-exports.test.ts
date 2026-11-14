import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the application auth entrypoint bundles and executes under Node without the Bun runtime", async () => {
  const root = resolve(import.meta.dir, "../..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(manifest.exports["./auth"]).toBe("./src/auth/index.ts");
  const directory = mkdtempSync(join(tmpdir(), "auggy-node-auth-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(root, "src/auth/index.ts")],
      target: "node",
      format: "esm",
    });
    expect(built.success).toBe(true);
    const source = await built.outputs[0]!.text();
    expect(source).not.toContain("bun:");
    writeFileSync(join(directory, "auth.mjs"), source);
    writeFileSync(
      join(directory, "check.mjs"),
      `
import { createExternalAuthAssertion, verifyExternalAuthAssertion } from "./auth.mjs";
if (typeof globalThis.Bun !== "undefined") throw new Error("Expected Node");
const options = { secret: "synthetic-secret", audience: "fixture", provider: "app", subject: "person", jti: "one-use", now: 1000, ttlSeconds: 60 };
const assertion = createExternalAuthAssertion(options);
const valid = verifyExternalAuthAssertion(assertion, { secret: options.secret, audience: "fixture", now: 1001 });
const invalid = verifyExternalAuthAssertion(assertion, { secret: "wrong-secret", audience: "fixture", now: 1001 });
if (!valid.ok || valid.claims.jti !== "one-use" || invalid.ok) throw new Error("Verification contract failed");
console.log("verified-in-node");
`,
    );
    const child = Bun.spawnSync(["node", join(directory, "check.mjs")], {
      cwd: directory,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe("verified-in-node");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
