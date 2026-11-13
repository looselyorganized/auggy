import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { readPidManifest } from "../../src/cli/pid-registry";

const repo = fileURLToPath(new URL("../..", import.meta.url));
async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture readiness timed out");
    await Bun.sleep(5);
  }
}

async function checkRunner(scenario: string, hook: "complete" | "reject" | "pending") {
  const project = mkdtempSync(join(tmpdir(), "auggy-runner-test-"));
  const id = `aug1_${crypto.randomUUID()}`;
  const registry = { auggyDir: join(project, "registry") };
  mkdirSync(join(project, "node_modules", "@auggy"), { recursive: true });
  symlinkSync(join(repo, "packages/anthropic"), join(project, "node_modules/@auggy/anthropic"));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "@auggy/anthropic": "workspace:*" } }),
  );
  writeFileSync(join(project, "entry.ts"), "// declaration only; child supplies named main\n");
  writeFileSync(
    join(project, "resource.ts"),
    `import { appendFileSync } from "node:fs";
export default () => ({ name: "resource", onBoot: async () => {}, onShutdown: async () => {
 appendFileSync(${JSON.stringify(join(project, "cleanup"))}, "attempted\\n");
 ${hook === "reject" ? 'throw new Error("fixture cleanup rejection");' : hook === "pending" ? "await new Promise(() => {});" : ""}
} });\n`,
  );
  writeFileSync(
    join(project, "agent.yaml"),
    stringify({
      id,
      name: "runner-test",
      application: { entrypoint: "./entry.ts", contractVersion: 1 },
      engine: { provider: "anthropic", model: "fixture" },
      augments: [{ name: "resource", type: "custom", source: "./resource.ts" }],
    }),
  );
  const child = Bun.spawn(
    [process.execPath, join(repo, "tests/fixtures/application-runner-child.ts"), project, scenario],
    {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: project, ANTHROPIC_API_KEY: "test-only-never-sent" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = Promise.race([
    child.exited,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("runner did not stop within test bound"));
      }, 22000);
    }),
  ]);
  try {
    if (scenario !== "startup-throw") {
      await waitFor(() => existsSync(join(project, "ready")) || child.exitCode !== null);
      expect(existsSync(join(project, "ready"))).toBe(true);
      if (scenario === "return-after-ready")
        await waitFor(() => existsSync(join(project, "returned")));
      else expect(existsSync(join(project, "returned"))).toBe(false);
      child.kill("SIGTERM");
    }
    const code = await completed;
    const [stdout, stderr] = await output;
    expect(code).toBe(scenario === "startup-throw" || hook !== "complete" ? 1 : 0);
    expect(child.signalCode).toBeNull();
    expect(readFileSync(join(project, "cleanup"), "utf8")).toBe("attempted\n");
    expect(readPidManifest(id, registry) !== null).toBe(hook !== "complete");
    expect(stdout + stderr).not.toContain("test-only-never-sent");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
    rmSync(project, { recursive: true, force: true });
  }
}

test(
  "managed signal shutdown exits cleanly after releasing real claims",
  () => checkRunner("until-shutdown", "complete"),
  10000,
);
test(
  "legacy return-after-ready leaves the same runner responsible for later signals",
  () => checkRunner("return-after-ready", "complete"),
  10000,
);
test(
  "startup failure remains exit one after successful cleanup",
  () => checkRunner("startup-throw", "complete"),
  10000,
);
test(
  "unknown settled cleanup exits one and preserves claims",
  () => checkRunner("until-shutdown", "reject"),
  10000,
);
test(
  "runner's 15 second observation limit retains live cleanup claims before forcing exit one",
  () => checkRunner("until-shutdown", "pending"),
  25000,
);
