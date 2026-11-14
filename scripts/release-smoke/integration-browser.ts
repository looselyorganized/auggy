/** Real browser drivers execute in a separately supervised process group, never in jsdom. */
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { applicationHash } from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";
import { INTEGRATION_LIMITS } from "./integration-contracts";
import {
  integrationRelativePath,
  createIntegrationBudget,
  readIntegrationFile,
  waitForIntegrationHttpReady,
  withIntegrationChild,
  type IntegrationChildOptions,
  type IntegrationBudget,
} from "./integration-consumer";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export interface IntegrationBrowserInput {
  repoRoot: string;
  appDirectory: string;
  driver: { path: string; sha256: string };
  playwright: { version: string; manifestSHA256: string };
}

/** Preserve safe native locations; privately copy only shared-writable toolcache executables. */
export function stageIntegrationBrowserRuntime(
  source: { path: string; sha256: string },
  privateDirectory: string,
): { path: string; sha256: string } {
  check(
    isAbsolute(source.path) && /^[a-f0-9]{64}$/.test(source.sha256),
    "Browser driver runtime needs an absolute path and exact hash",
  );
  const executable = realpathSync(source.path);
  // The descriptor read checks ordinary-file type, size and before/after identity.
  // Shared toolcache permissions are not inherited by the private copy.
  const snapshot = readBoundedRegularFile(executable, 256 * 1024 * 1024);
  check((snapshot.mode & 0o111) !== 0, "Browser driver runtime must be executable");
  check(applicationHash(snapshot.bytes) === source.sha256, "Browser driver runtime hash mismatch");
  // Native runtimes can resolve shared libraries relative to their executable.
  // An already-safe executable must retain that location rather than being relocated.
  if ((snapshot.mode & 0o022) === 0) return { path: executable, sha256: source.sha256 };
  const parent = realpathSync(privateDirectory);
  const parentStat = lstatSync(parent);
  check(
    parentStat.isDirectory() &&
      (parentStat.mode & 0o077) === 0 &&
      parentStat.uid === process.getuid?.(),
    "Browser runtime workspace must be private and owned",
  );
  const directory = mkdtempSync(join(parent, ".m5-browser-runtime-"));
  try {
    const path = join(directory, "node");
    writeFileSync(path, snapshot.bytes, { flag: "wx", mode: 0o700 });
    const copied = readBoundedRegularFile(path, 256 * 1024 * 1024);
    check(
      (copied.mode & 0o777) === 0o700 && applicationHash(copied.bytes) === source.sha256,
      "Private browser runtime does not match its executable identity",
    );
    return { path, sha256: source.sha256 };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** No dynamic package fallback: a missing isolated Playwright install is a missing prerequisite. */
export function inspectIntegrationBrowser(input: IntegrationBrowserInput) {
  const app = realpathSync(input.appDirectory);
  const repo = realpathSync(input.repoRoot);
  check(
    !inside(app, repo) && !inside(repo, app),
    "Browser app must be isolated outside the checkout",
  );
  integrationRelativePath(input.driver.path);
  check(
    input.driver.path.endsWith(".ts") ||
      input.driver.path.endsWith(".js") ||
      input.driver.path.endsWith(".mjs"),
    "Browser driver must be an explicit source module",
  );
  check(
    /^[a-f0-9]{64}$/.test(input.driver.sha256) &&
      /^[a-f0-9]{64}$/.test(input.playwright.manifestSHA256),
    "Browser inputs need exact SHA256 identities",
  );
  const driver = readIntegrationFile(app, input.driver.path, 2 * 1024 * 1024);
  check(applicationHash(driver) === input.driver.sha256, "Browser driver source hash mismatch");
  const dependencies = realpathSync(join(app, "node_modules"));
  check(inside(dependencies, app), "Browser dependencies escaped isolated app");
  const packageRoot = realpathSync(join(dependencies, "playwright"));
  check(inside(packageRoot, dependencies), "Browser API package escaped isolated dependencies");
  const manifestBytes = readIntegrationFile(packageRoot, "package.json", 64 * 1024);
  check(
    applicationHash(manifestBytes) === input.playwright.manifestSHA256,
    "Browser API manifest hash mismatch",
  );
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  check(
    manifest !== null && typeof manifest === "object" && !Array.isArray(manifest),
    "Invalid browser API manifest",
  );
  const metadata = manifest as Record<string, unknown>;
  check(
    metadata.name === "playwright" &&
      typeof input.playwright.version === "string" &&
      /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(input.playwright.version) &&
      metadata.version === input.playwright.version,
    "Browser API version does not match the selected dependency",
  );
  const entry = realpathSync(createRequire(join(app, input.driver.path)).resolve("playwright"));
  check(inside(entry, packageRoot), "Browser driver resolves a different Playwright package");
  return { app, driver: join(app, input.driver.path), version: input.playwright.version };
}

/** Own Chromium directly: Playwright's ordinary launch detaches another POSIX process group. */
export async function withIntegrationChromium<T>(
  options: {
    executable: { path: string; sha256: string };
    profileParent: string;
    env: IntegrationChildOptions["env"];
    secrets: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  observe: (context: { endpoint: string; budget: IntegrationBudget }) => Promise<T>,
) {
  const executable = join(
    realpathSync(dirname(options.executable.path)),
    basename(options.executable.path),
  );
  check(
    /^[a-f0-9]{64}$/.test(options.executable.sha256),
    "Chromium requires an exact executable hash",
  );
  check(
    applicationHash(
      readIntegrationFile(dirname(executable), basename(executable), 256 * 1024 * 1024),
    ) === options.executable.sha256,
    "Chromium executable hash mismatch",
  );
  const executableStat = lstatSync(executable);
  check(
    (executableStat.mode & 0o111) !== 0 && (executableStat.mode & 0o022) === 0,
    "Chromium executable must be executable and not writable by group or others",
  );
  const parent = realpathSync(options.profileParent);
  const parentStat = lstatSync(parent);
  check(
    parentStat.isDirectory() &&
      (parentStat.mode & 0o077) === 0 &&
      parentStat.uid === process.getuid?.(),
    "Browser profile parent must be private and owned",
  );
  options.signal?.throwIfAborted();
  const lifetimeMs = options.timeoutMs ?? INTEGRATION_LIMITS.scenarioMs;
  const cleanupReserveMs = Math.min(
    INTEGRATION_LIMITS.shutdownMs + INTEGRATION_LIMITS.reapMs + 1000,
    Math.floor(lifetimeMs / 2),
  );
  const profile = mkdtempSync(join(parent, ".m5-browser-"));
  let cleanupConfirmed = false;
  try {
    const result = await withIntegrationChild(
      {
        label: "owned-chromium",
        command: [
          executable,
          "--headless=new",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          // Match Playwright's automation defaults: this private fixture profile
          // must never prompt for, read, or write the operator's macOS keychain.
          "--password-store=basic",
          "--use-mock-keychain",
          "about:blank",
        ],
        cwd: parent,
        env: options.env,
        secrets: options.secrets,
        // Parent interruption stops the driver through the work budget first. The
        // independently bounded browser owner is stopped after that driver settles.
        timeoutMs: lifetimeMs,
      },
      async ({ budget: ownerBudget, child }) => {
        const budget = createIntegrationBudget(
          Math.max(1, ownerBudget.remainingMs() - cleanupReserveMs),
          options.signal
            ? AbortSignal.any([ownerBudget.signal, options.signal])
            : ownerBudget.signal,
        );
        try {
          let exited = false;
          void child.exited.then(() => {
            exited = true;
          });
          const navigation = createIntegrationBudget(
            Math.min(INTEGRATION_LIMITS.browserNavigationMs, budget.remainingMs()),
            budget.signal,
          );
          let endpoint: string;
          try {
            endpoint = await navigation.run(
              INTEGRATION_LIMITS.browserNavigationMs,
              async (signal) => {
                while (true) {
                  signal.throwIfAborted();
                  check(
                    !exited,
                    "Chromium exited before publishing its private debugging endpoint",
                  );
                  let activePort: string;
                  try {
                    activePort = readIntegrationFile(profile, "DevToolsActivePort", 256).toString(
                      "utf8",
                    );
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    await Bun.sleep(25);
                    continue;
                  }
                  const match =
                    /^(\d{1,5})\r?\n(\/devtools\/browser\/[A-Za-z0-9-]{1,80})\r?\n?$/.exec(
                      activePort,
                    );
                  check(
                    match && Number(match[1]) > 0 && Number(match[1]) <= 65535,
                    "Chromium debugging endpoint record is invalid",
                  );
                  const origin = `http://127.0.0.1:${match[1]}`;
                  await waitForIntegrationHttpReady({
                    url: `${origin}/json/version`,
                    budget: navigation,
                    exited: child.exited,
                    ready(response) {
                      if (response.status !== 200) return false;
                      const value: unknown = JSON.parse(response.body);
                      if (value === null || typeof value !== "object" || Array.isArray(value))
                        return false;
                      const record = value as Record<string, unknown>;
                      if (
                        typeof record.Browser !== "string" ||
                        !/^(?:Headless)?Chrome\//.test(record.Browser) ||
                        typeof record.webSocketDebuggerUrl !== "string"
                      )
                        return false;
                      const socket = new URL(record.webSocketDebuggerUrl);
                      return (
                        socket.protocol === "ws:" &&
                        socket.hostname === "127.0.0.1" &&
                        socket.port === match[1] &&
                        socket.pathname === match[2] &&
                        !socket.username &&
                        !socket.password &&
                        !socket.search &&
                        !socket.hash
                      );
                    },
                  });
                  return origin;
                }
              },
            );
          } finally {
            navigation.dispose();
          }
          const value = await observe({ endpoint, budget });
          budget.signal.throwIfAborted();
          return value;
        } finally {
          budget.dispose();
        }
      },
    );
    cleanupConfirmed = result.process.cleanupConfirmed;
    return {
      ...result,
      executableSHA256: options.executable.sha256,
      profileCleanup: cleanupConfirmed ? ("complete" as const) : ("retained-unconfirmed" as const),
    };
  } finally {
    if (cleanupConfirmed) rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * The reviewed driver must use chromium.connectOverCDP with the supplied endpoint,
 * never chromium.launch/launchServer. Browser and driver have independent owners.
 * The driver closes its context in finally; the parent stops driver before Chromium.
 */
export async function runIntegrationBrowser(
  options: IntegrationBrowserInput & {
    chromium: { path: string; sha256: string };
    /** Explicit supported runtime for the browser API (normally a resolved Node executable). */
    driverRuntime?: { path: string; sha256: string };
    env: IntegrationChildOptions["env"];
    secrets: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) {
  const selected = inspectIntegrationBrowser(options);
  let driverExecutable = process.execPath;
  if (options.driverRuntime) {
    check(
      isAbsolute(options.driverRuntime.path) && /^[a-f0-9]{64}$/.test(options.driverRuntime.sha256),
      "Browser driver runtime needs an absolute path and exact hash",
    );
    driverExecutable = realpathSync(options.driverRuntime.path);
    const stat = lstatSync(driverExecutable);
    check(
      stat.isFile() && (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0,
      "Browser driver runtime must be an ordinary executable",
    );
    check(
      applicationHash(
        readIntegrationFile(
          dirname(driverExecutable),
          basename(driverExecutable),
          256 * 1024 * 1024,
        ),
      ) === options.driverRuntime.sha256,
      "Browser driver runtime hash mismatch",
    );
  }
  let driverResult: Awaited<ReturnType<typeof withIntegrationChild>> | undefined;
  const result = await withIntegrationChromium(
    {
      executable: options.chromium,
      profileParent: selected.app,
      env: options.env,
      secrets: options.secrets,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
    async ({ endpoint, budget }) => {
      const driver = await withIntegrationChild(
        {
          label: "optional-app-browser",
          command: [driverExecutable, selected.driver],
          cwd: selected.app,
          env: { ...options.env, AUGGY_FIXTURE_BROWSER_CDP_ENDPOINT: endpoint },
          secrets: options.secrets,
          signal: budget.signal,
          timeoutMs: budget.remainingMs(),
        },
        async ({ child }) => {
          const ended = await child.finish();
          check(
            ended.exitCode === 0 &&
              ended.signal === null &&
              ended.cleanupConfirmed &&
              !ended.spawnFailed &&
              !ended.timedOut &&
              !ended.exceededOutput &&
              !ended.orphanedGroup,
            "Browser driver failed or left unconfirmed descendants",
          );
          return {
            driverSHA256: options.driver.sha256,
            playwrightVersion: selected.version,
            ...(options.driverRuntime ? { driverRuntimeSHA256: options.driverRuntime.sha256 } : {}),
          };
        },
      );
      driverResult = driver;
      check(driver.status === "passed", "Browser driver did not complete with confirmed cleanup");
      return driver;
    },
  );
  // A zero-exit driver is mechanics evidence only; A05 additionally needs validated browser/effect observations.
  return { ...result, driver: driverResult };
}

/** Explicit built-output inventory; never recursively archive an app or raw browser session. */
export function assertProductionFixtureExclusion(options: {
  appDirectory: string;
  builtFiles: readonly string[];
  forbiddenMarkers: readonly string[];
}): { files: number; bytes: number } {
  check(
    options.builtFiles.length > 0 &&
      options.builtFiles.length <= 128 &&
      new Set(options.builtFiles).size === options.builtFiles.length,
    "Production bundle inventory must be explicit and bounded",
  );
  check(
    options.forbiddenMarkers.length > 0 &&
      options.forbiddenMarkers.length <= 16 &&
      options.forbiddenMarkers.every((value) => value.length >= 8 && value.length <= 256),
    "Invalid fixture exclusion markers",
  );
  let total = 0;
  for (const file of options.builtFiles) {
    const bytes = readIntegrationFile(options.appDirectory, file, 2 * 1024 * 1024);
    total += bytes.length;
    check(total <= 16 * 1024 * 1024, "Production bundle inventory exceeded byte bound");
    for (const marker of options.forbiddenMarkers)
      check(
        !bytes.includes(Buffer.from(marker)),
        "Production bundle contains fixture authentication code",
      );
  }
  return { files: options.builtFiles.length, bytes: total };
}
