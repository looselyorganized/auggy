import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertApplicationBrowserObservation,
  productionBundleFiles,
  assertPreparedCompanyApp,
  applicationEffectCounts,
  assertExpectedApplicationCrash,
} from "../../scripts/release-smoke/integration-application";
import { withIntegrationChild } from "../../scripts/release-smoke/integration-consumer";
import { createApplicationModelFixture } from "../../scripts/release-smoke/integration-fixtures/application/model-fixture";
import { COMPANY_APP_SOURCE_FILES } from "../../scripts/release-smoke/integration-fixtures/application/contracts";
import { applicationHash } from "../../scripts/release-smoke/application-consumer";
import { PROVIDER_FIXTURE_API_KEY } from "../../scripts/release-smoke/provider-fixture";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("only the observed deliberate crash passes; an actual timed-out child never does", async () => {
  const root = mkdtempSync(join(tmpdir(), "m5-crash-oracle-"));
  paths.push(root);
  const options = {
    label: "crash-oracle",
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    secrets: [],
  };
  const timedOut = await withIntegrationChild(
    { ...options, timeoutMs: 150 },
    async () => new Promise<never>(() => {}),
  );
  expect(timedOut.process.cleanupConfirmed).toBe(true);
  expect(() => assertExpectedApplicationCrash(timedOut, false)).toThrow("did not complete");
  // Even a mistaken completion marker cannot hide the supervisor failure.
  expect(() => assertExpectedApplicationCrash(timedOut, true)).toThrow("did not complete");
  let observed = false;
  const deliberate = await withIntegrationChild(
    { ...options, timeoutMs: 2000 },
    async ({ child }) => {
      await Bun.sleep(50);
      child.signal("SIGKILL");
      await child.finish();
      observed = true;
    },
  );
  expect(() => assertExpectedApplicationCrash(deliberate, observed)).not.toThrow();
  expect(() => assertExpectedApplicationCrash(deliberate, false)).toThrow("did not complete");
});
const layout = (innerWidth: number, clientWidth = innerWidth) => ({
  innerWidth,
  clientWidth,
  scrollWidth: clientWidth,
  app: { left: 0, right: clientWidth, width: clientWidth },
  conversation: { left: 16, right: clientWidth - 16, width: clientWidth - 32 },
});
const observation = () => ({
  version: 1,
  firstChunkBeforeTerminal: true,
  directAgentRequests: 3,
  freshAssertionCount: 3,
  stableRetryKey: true,
  applicationCookiesSentToAgent: false,
  creatorCredentialSentToAgent: false,
  interruptedThenCompleted: true,
  mobileOverflow: false,
  desktopOverflow: false,
  layout: {
    desktop: { before: layout(1365, 1350), after: layout(1365) },
    mobile: { before: layout(390, 375), after: layout(390) },
  },
  keyboardFocusVisible: true,
  checks: ["real-browser", "real-stream", "private-cookie", "same-operation", "one-effect"],
});

test("browser geometry oracle detects scrollbar-width overflow and clipped outer gutters", () => {
  const overflow = observation();
  overflow.layout.mobile.before.scrollWidth = 390;
  expect(() => assertApplicationBrowserObservation(overflow)).toThrow("client-width");
  const clipping = observation();
  clipping.layout.mobile.after.conversation = { left: 16, right: 390, width: 374 };
  expect(() => assertApplicationBrowserObservation(clipping)).toThrow("outer-gutter");
  const invalidBounds = observation();
  invalidBounds.layout.desktop.after.app.right = Number.NaN;
  expect(() => assertApplicationBrowserObservation(invalidBounds)).toThrow("region-bounds");
  expect(() => assertApplicationBrowserObservation({ ...observation(), layout: {} })).toThrow(
    "client-width",
  );
});

test("browser observation oracle rejects buffered output, credential leakage, changed retry keys and viewport failures", () => {
  expect(() => assertApplicationBrowserObservation(observation())).not.toThrow();
  for (const [key, value] of Object.entries({
    firstChunkBeforeTerminal: false,
    freshAssertionCount: 2,
    directAgentRequests: 0,
    stableRetryKey: false,
    applicationCookiesSentToAgent: true,
    creatorCredentialSentToAgent: true,
    interruptedThenCompleted: false,
    mobileOverflow: true,
    desktopOverflow: true,
    keyboardFocusVisible: false,
  }))
    expect(() => assertApplicationBrowserObservation({ ...observation(), [key]: value })).toThrow(
      "oracle",
    );
});

test("production bundle inventory covers emitted server and browser JavaScript and refuses symlinks", () => {
  const path = mkdtempSync(join(tmpdir(), "m5-application-bundles-"));
  paths.push(path);
  mkdirSync(join(path, ".next/server/chunks"), { recursive: true });
  mkdirSync(join(path, ".next/static/chunks"), { recursive: true });
  writeFileSync(join(path, ".next/server/chunks/server.js"), "export {};");
  writeFileSync(join(path, ".next/static/chunks/browser.js"), "export {};");
  writeFileSync(join(path, ".next/static/chunks/style.css"), "body{}");
  expect(productionBundleFiles(path)).toEqual([
    ".next/server/chunks/server.js",
    ".next/static/chunks/browser.js",
  ]);
  symlinkSync(join(path, ".next/server/chunks/server.js"), join(path, ".next/static/leak.js"));
  expect(() => productionBundleFiles(path)).toThrow("symbolic");
});

test("real provider fixture transports a paired tool exchange and physically separates text from terminal frames", async () => {
  const model = createApplicationModelFixture();
  try {
    await model.configure({
      tool: { name: "read_order", input: { orderId: "order-a" }, invalidInput: { orderId: 1 } },
      sentinel: "customer-a-private-marker",
      terminalDelayMs: 100,
    });
    const call = (messages: unknown[]) =>
      fetch(`${model.origin}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": PROVIDER_FIXTURE_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture-model",
          stream: true,
          tools: [{ name: "read_order" }],
          messages,
        }),
        signal: AbortSignal.timeout(3000),
      });
    const first = await call([{ role: "user", content: "read order" }]);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"type":"tool_use"');
    const final = await call([
      { role: "user", content: "read order" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "owned-call", name: "read_order", input: { orderId: "order-a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "owned-call", content: "customer-a-private-marker" },
        ],
      },
    ]);
    const reader = final.body!.getReader();
    const early = await reader.read();
    const earlyText = new TextDecoder().decode(early.value);
    expect(earlyText).toContain('"type":"text_delta"');
    expect(earlyText).not.toContain("event: message_stop");
    await expect(
      model.configure({
        tool: { name: "read_order", input: {}, invalidInput: { x: 1 } },
        sentinel: "x",
      }),
    ).rejects.toThrow("active");
    const late = await reader.read();
    expect(new TextDecoder().decode(late.value)).toContain("event: message_stop");
    await reader.cancel();
    expect(model.snapshot().provider?.validatedToolResults).toBe(1);
    expect(model.snapshot().requests.at(-1)?.containsA).toBe(true);
    expect(model.snapshot().requests.at(-1)?.containsB).toBe(false);
  } finally {
    await model.stop();
  }
});

test("prepared app source hashes refuse an unrecorded identity adapter or broken edit chain", () => {
  const path = mkdtempSync(join(tmpdir(), "m5-application-source-"));
  paths.push(path);
  const baselineFiles = COMPANY_APP_SOURCE_FILES.map((file) => {
    const pieces = file.split("/");
    pieces.pop();
    mkdirSync(join(path, ...pieces), { recursive: true });
    writeFileSync(join(path, file), "baseline");
    return { path: file, sha256: applicationHash("baseline") };
  });
  const app = {
    directory: path,
    baselineFiles,
    changes: [],
    installedFiles: [],
    lockfile: { path: "bun.lock", sha256: applicationHash("baseline") },
  };
  expect(() => assertPreparedCompanyApp(app)).not.toThrow();
  writeFileSync(join(path, "src/server/session-adapter.ts"), "unrecorded-identity-adapter");
  expect(() => assertPreparedCompanyApp(app)).toThrow("outside");
  expect(() =>
    assertPreparedCompanyApp({
      ...app,
      changes: [
        {
          path: "src/server/session-adapter.ts",
          kind: "fixture-overlay",
          beforeSHA256: applicationHash("baseline"),
          afterSHA256: applicationHash("unrecorded-identity-adapter"),
        },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    assertPreparedCompanyApp({
      ...app,
      changes: [
        {
          path: "src/server/session-adapter.ts",
          kind: "fixture-overlay",
          beforeSHA256: null,
          afterSHA256: applicationHash("unrecorded-identity-adapter"),
        },
      ],
    }),
  ).toThrow("chain");
});

test("evidence counts preserve committed effects on partial runs and distinguish duplicate and unauthorized rows", () => {
  const effect = {
    subject: "support-agent",
    receipt: { orderId: "order-a", amountCents: 1250, simulated: true },
  };
  expect(
    applicationEffectCounts([effect], [{ kind: "http", expectedRefund: true, start: 0, end: 1 }])
      .http,
  ).toEqual({ effects: 1, duplicates: 0, unauthorized: 0 });
  expect(
    applicationEffectCounts(
      [effect, effect],
      [{ kind: "browser", expectedRefund: true, start: 0, end: 2 }],
    ).browser,
  ).toEqual({ effects: 2, duplicates: 1, unauthorized: 0 });
  expect(
    applicationEffectCounts(
      [{ ...effect, subject: "customer-a" }],
      [{ kind: "browser", expectedRefund: true, start: 0, end: 1 }],
    ).browser,
  ).toEqual({ effects: 1, duplicates: 0, unauthorized: 1 });
  expect(
    applicationEffectCounts(
      [effect],
      [{ kind: "production", expectedRefund: false, start: 0, end: 1 }],
    ).production,
  ).toEqual({ effects: 1, duplicates: 0, unauthorized: 1 });
  expect(() => applicationEffectCounts([effect], [])).toThrow("unaccounted");
});
