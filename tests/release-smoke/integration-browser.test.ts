import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applicationHash } from "../../scripts/release-smoke/application-consumer";
import {
  assertProductionFixtureExclusion,
  inspectIntegrationBrowser,
  runIntegrationBrowser,
  withIntegrationChromium,
} from "../../scripts/release-smoke/integration-browser";
import { withIntegrationChild } from "../../scripts/release-smoke/integration-consumer";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Protocol/process fixture only: this is not Chromium or browser acceptance evidence.
const browserOwnerFixture = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.split("=")[1];
if (!profile) process.exit(1);
if (!process.argv.includes("--password-store=basic") || !process.argv.includes("--use-mock-keychain")) process.exit(74);
const path = "/devtools/browser/owned-process-fixture";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
 return Response.json({ Browser: "HeadlessChrome/fixture", webSocketDebuggerUrl: "ws://127.0.0.1:" + server.port + path });
} });
writeFileSync(join(profile, "DevToolsActivePort"), server.port + "\\n" + path + "\\n");
process.on("SIGTERM", async () => {
 await server.stop(true);
 if (process.env.M5_OWNER_JOURNAL) appendFileSync(process.env.M5_OWNER_JOURNAL, "browser-stopped\\n");
 process.exit(0);
});
`;

describe("browser preflight controls; not A05 browser execution", () => {
  test("retains a failed driver's sanitized diagnostics after confirmed browser cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-m5-driver-failure-"));
    paths.push(root);
    const app = join(root, "app"),
      repo = join(root, "repo");
    mkdirSync(repo, { mode: 0o700 });
    mkdirSync(app, { mode: 0o700 });
    mkdirSync(join(app, "node_modules/playwright"), { recursive: true });
    const manifest = JSON.stringify({ name: "playwright", version: "1.0.0", main: "index.js" });
    writeFileSync(join(app, "node_modules/playwright/package.json"), manifest);
    writeFileSync(join(app, "node_modules/playwright/index.js"), "module.exports = {};\n");
    const source = 'throw new Error("synthetic-driver-failure token-to-redact");\n';
    writeFileSync(join(app, "driver.ts"), source);
    const executable = join(root, "chromium-protocol-fixture");
    writeFileSync(executable, browserOwnerFixture, { mode: 0o700 });
    const result = await runIntegrationBrowser({
      repoRoot: repo,
      appDirectory: app,
      driver: { path: "driver.ts", sha256: applicationHash(source) },
      playwright: { version: "1.0.0", manifestSHA256: applicationHash(manifest) },
      chromium: { path: executable, sha256: applicationHash(browserOwnerFixture) },
      env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      secrets: ["token-to-redact"],
      timeoutMs: 3000,
    });
    expect(result.status).toBe("failed");
    expect(result.driver?.process.stderr).toContain("synthetic-driver-failure");
    expect(result.driver?.process.stderr).not.toContain("token-to-redact");
    expect(result.driver?.process.cleanupConfirmed).toBe(true);
    expect(result.process.cleanupConfirmed).toBe(true);
    expect(result.profileCleanup).toBe("complete");
  });

  test("direct browser owner stops its own real process and removes private profile on oracle failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-m5-browser-owner-"));
    paths.push(root);
    const executable = join(root, "chromium-protocol-fixture");
    writeFileSync(executable, browserOwnerFixture, { mode: 0o700 });
    chmodSync(executable, 0o700);
    let reached = false;
    const result = await withIntegrationChromium(
      {
        executable: { path: executable, sha256: applicationHash(browserOwnerFixture) },
        profileParent: root,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
        secrets: [],
        timeoutMs: 2000,
      },
      async ({ endpoint }) => {
        reached = true;
        expect(endpoint).toStartWith("http://127.0.0.1:");
        throw new Error("synthetic browser oracle failed");
      },
    );
    expect(reached).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.process.cleanupConfirmed).toBe(true);
    expect(result.profileCleanup).toBe("complete");
    expect(readdirSync(root).some((path) => path.startsWith(".m5-browser-"))).toBe(false);
  });
  test("source mismatch and missing isolated browser dependency stop before driver execution", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-m5-browser-controls-"));
    paths.push(root);
    for (const path of ["checkout", "app", "app/tests"]) mkdirSync(join(root, path));
    const driver = 'throw new Error("This preflight fixture must never execute");\n';
    writeFileSync(join(root, "app/tests/browser.ts"), driver);
    const input = {
      repoRoot: join(root, "checkout"),
      appDirectory: join(root, "app"),
      driver: { path: "tests/browser.ts", sha256: "0".repeat(64) },
      playwright: { version: "1.0.0", manifestSHA256: "1".repeat(64) },
    };
    expect(() => inspectIntegrationBrowser(input)).toThrow("source hash");
    input.driver.sha256 = applicationHash(driver);
    expect(() => inspectIntegrationBrowser(input)).toThrow();
    symlinkSync(join(root, "checkout"), join(root, "app/node_modules"));
    expect(() => inspectIntegrationBrowser(input)).toThrow("escaped");
  });

  test("parent interruption reaps the driver before stopping the separately owned browser", async () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-m5-browser-order-"));
    paths.push(root);
    const executable = join(root, "chromium-protocol-fixture");
    writeFileSync(executable, browserOwnerFixture, { mode: 0o700 });
    const journal = join(root, "ownership-journal");
    const parent = new AbortController();
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      M5_OWNER_JOURNAL: journal,
    };
    const result = await withIntegrationChromium(
      {
        executable: { path: executable, sha256: applicationHash(browserOwnerFixture) },
        profileParent: root,
        env,
        secrets: [],
        timeoutMs: 3000,
        signal: parent.signal,
      },
      async ({ budget }) => {
        const driver = await withIntegrationChild(
          {
            label: "browser-driver-control",
            command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
            cwd: root,
            env,
            secrets: [],
            timeoutMs: budget.remainingMs(),
            signal: budget.signal,
          },
          async ({ child }) => {
            parent.abort();
            await child.finish();
          },
        );
        expect(driver.process.cleanupConfirmed).toBe(true);
        appendFileSync(journal, "driver-reaped\n");
      },
    );
    expect(result.status).toBe("failed");
    expect(result.process.cleanupConfirmed).toBe(true);
    expect(readFileSync(journal, "utf8")).toBe("driver-reaped\nbrowser-stopped\n");
  });

  test("production fixture marker and linked bundle controls fail against actual files", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-m5-bundle-controls-"));
    paths.push(root);
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build/server.js"), "export const status = 503;\n");
    const options = {
      appDirectory: root,
      builtFiles: ["build/server.js"],
      forbiddenMarkers: ["M5_FIXTURE_AUTH_REGISTRY"],
    };
    expect(assertProductionFixtureExclusion(options).files).toBe(1);
    writeFileSync(join(root, "build/server.js"), "const M5_FIXTURE_AUTH_REGISTRY = {};\n");
    expect(() => assertProductionFixtureExclusion(options)).toThrow("fixture authentication");
    rmSync(join(root, "build/server.js"));
    writeFileSync(join(root, "outside.js"), "safe");
    symlinkSync(join(root, "outside.js"), join(root, "build/server.js"));
    expect(() => assertProductionFixtureExclusion(options)).toThrow("symbolic links");
    expect(() => assertProductionFixtureExclusion({ ...options, forbiddenMarkers: [] })).toThrow(
      "markers",
    );
  });
});
