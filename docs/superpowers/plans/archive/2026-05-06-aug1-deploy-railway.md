# `aug1 deploy --to railway` Implementation Plan

> **✅ SHIPPED 2026-05-12** (PR #39, merged to main; `auggy@0.3.1` on npm). Final shape differs from this plan in 8 specific places — binary renamed `aug1` → `auggy`, 4 SQLite paths symlinked (not 2), idempotency gate added to publish workflow, `--provenance` deferred to repo-public flip, `.worktrees/` + `.claude/` added to bundle exclusions, `D7` domain-before-secrets sequencing for `${AUGGY_PUBLIC_URL}` interpolation. See `docs/18-deploy.md` for the operator-facing reality. This plan is historical reference; not actionable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `aug1 deploy <name> --to railway` so an operator can deploy a registered agent to Railway from the same machine where `aug1 dev <name>` runs. First deploy provisions the Railway service + volume + env vars + initial code push; subsequent runs of the same command re-deploy idempotently. Pairs with a "Deploy on Railway" README button for operators who want a one-click first install.

**Architecture:** Shell out to the Railway CLI (operator pre-installs and runs `railway login`) — same trust pattern as `git push` trusts `git`. No Railway API token storage, no OAuth flow to build. The deploy implements ADR-021's cloud design verbatim: one Railway service per agent, named `<name>`; one volume `<name>-data` mounted at `/app/data`; bundle excludes `.env`/`workspace/`/`*.db*`/`node_modules/`; entrypoint symlinks `./memory.db` and `./budgets.db` to the volume so `agent.yaml`'s `dbPath: ./memory.db` stays unchanged. Cloud state persists in the existing `~/.auggy/agents.json` index via a new `setCloud(name, record)` mutator. v1 is Railway-specific code in `src/cli/deploy/` — no plugin abstraction yet (ADR-021 commits to Railway as the first cloud target; "Other targets… deferred until concrete demand"). When that demand arrives, the existing module is the seam.

**Tech stack:** TypeScript, Bun (`Bun.spawn` for Railway CLI subprocess calls), `bun:test`, Commander.js (existing CLI framework), Node `fs`/`path` for bundle staging. No new runtime dependencies.

**Out of scope (deferred):**

- `aug1 redeploy <name>` (a re-run of `aug1 deploy <name>` IS the redeploy — explicit `redeploy` alias is YAGNI for v1)
- `aug1 stop <name> --cloud` (operator can pause via Railway UI; CLI flag deferred until concrete pain)
- Plugin abstraction for `--to fly` / `--to render` (deferred per ADR-021 line 222)
- Multi-machine index sync (deferred per ADR-021 line 192)
- `aug1 chat`'s `indexedCloudSource` adapter (deferred per ADR-021 line 224)
- AgentMail webhook URL registration (separate plan; this plan exposes `AUGGY_PUBLIC_URL` env var that the future bidirectional `emailTransport` augment will consume)

---

## Reference context for the engineer

Read these before starting:

- `docs/solutions/architecture/adr-021-agent-storage-and-deployment-locations.md` (in the parent `lo/` repo, not `augment-1/`) — the **complete cloud design**. The plan implements lines 132–166 verbatim.
- `src/cli/agent-index.ts` — the existing index module; mirrors `pid-registry.ts`'s atomic-write + locking pattern. Add `setCloud` and `clearCloud` here.
- `src/cli/types.ts:141-148` — `CloudRecord` type already designed; the plan populates it.
- `src/cli/index.ts` — CLI dispatcher (Commander.js); add the `deploy` command alongside `create`, `add`, `dev`, etc.
- `src/cli/commands/create.ts` — interactive prompt patterns. Mirror these in `commands/deploy.ts`.
- `src/cli/commands/remove.ts` — confirmation-prompt + `--yes` flag pattern. The deploy command's secrets-push prompt mirrors this.
- `tests/cli/agent-index.test.ts` — test-fixture pattern using `auggyDir` override.

Railway CLI commands referenced (operator must have `railway` installed and logged in):

- `railway --version` — presence check
- `railway whoami` — auth check
- `railway init` — interactive: links a project (existing or new) to the current dir, writes `.railway/config.json`
- `railway link --project <id> --service <name>` — non-interactive link to existing project + service
- `railway up --detach` — uploads source from current dir, builds, starts. `--detach` returns after upload (no build-log tail).
- `railway service` — outputs the current service id (we capture stdout)
- `railway domain --generate` — assigns a `*.up.railway.app` URL to the current service. Idempotent — second call returns the existing URL.
- `railway volume add <volume-name> --mount-path <path>` — provisions a volume and mounts it. (CLI version may surface this as `railway volume create` — verify with `railway volume --help`.)
- `railway variables --set KEY=value` — sets one env var. Repeatable. Triggers a redeploy on the service.
- `railway status --json` — outputs service+project+deployment metadata as JSON

For each subprocess call, capture stdout/stderr and exit code. Surface non-zero exits as errors with the captured stderr in the message.

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/cli/agent-index.ts` | Modify | Add `setCloud(name, record)` + `clearCloud(name)` mutators. |
| `tests/cli/agent-index.test.ts` | Modify | Add tests for the new mutators (locking, idempotency, missing-agent error). |
| `src/cli/deploy/railway-cli.ts` | Create | Thin wrapper around Railway CLI subprocess calls. Each Railway operation is one exported function; each calls a shared `runRailway(args, opts)` helper that uses `Bun.spawn`. |
| `tests/cli/deploy/railway-cli.test.ts` | Create | Unit tests with mocked `Bun.spawn` (factory injection — see Task 2 for the seam). |
| `src/cli/deploy/bundle.ts` | Create | Stages the agent dir into a temp directory minus exclusions (`.env`, `workspace/`, `*.db*`, `node_modules/`, `.git`, `.DS_Store`, `*.tmp`). Returns the staging dir path. |
| `tests/cli/deploy/bundle.test.ts` | Create | Tests the exclusion logic against a fixture agent dir. |
| `src/cli/deploy/secrets.ts` | Create | Reads `.env`, parses key=value pairs, plans the env-var diff to push to Railway, returns a structured plan. Does NOT execute the push (that's the command's job after operator confirmation). |
| `tests/cli/deploy/secrets.test.ts` | Create | Tests `.env` parsing, comment skipping, quoted values, the plan structure. |
| `src/cli/deploy/dockerfile.ts` | Create | Returns the Dockerfile + entrypoint script as strings (templated with the agent name). Static content; no operator-tunable knobs at v1. |
| `tests/cli/deploy/dockerfile.test.ts` | Create | Snapshot-style test that asserts key invariants in the generated Dockerfile (FROM line, COPY line, entrypoint reference, exposed port). |
| `src/cli/commands/deploy.ts` | Create | The `aug1 deploy <name> --to railway` command. Interactive: presence checks → first-deploy-or-redeploy detection → secrets-push confirmation → deploy → URL capture → index write. |
| `tests/cli/deploy.test.ts` | Create | End-to-end test using mocked Railway CLI + temp `auggyDir`. Covers first-deploy and redeploy paths. (Path matches `tests/cli/remove.test.ts` / `ls.test.ts` convention — top-level, not nested.) |
| `src/cli/index.ts` | Modify | Wire the `deploy` command into Commander.js. |
| `src/cli/commands/remove.ts` | Modify | Add `--cloud` flag — when present and `cloud` record exists, also call Railway destroy via the CLI wrapper. |
| `tests/cli/remove.test.ts` | Modify | Two new tests for `--cloud` path. |
| `templates/railway/README.md` | Create | A short README explaining how the "Deploy on Railway" button works for OSS adopters. |
| `README.md` (project root) | Modify | Add the "Deploy on Railway" template button section. |
| `docs/18-deploy.md` | Create | Operator reference: prereqs, `aug1 deploy` flow, secrets handling, troubleshooting, what NOT to expect (no auto-rollback, no multi-replica). |

---

## Task 1: agent-index `setCloud` + `clearCloud` mutators

**Files:**
- Modify: `src/cli/agent-index.ts` (add two exports)
- Modify: `tests/cli/agent-index.test.ts` (add 4 tests)

- [ ] **Step 1: Write failing tests**

The existing `tests/cli/agent-index.test.ts` uses top-level `let auggyDir; beforeEach/afterEach` to mkdtemp + cleanup. Each `describe` block contains `test(...)` cases. Mirror that. Append a new `describe("setCloud", ...)` and `describe("clearCloud", ...)` block to the bottom of the file:

```ts
describe("setCloud", () => {
  test("writes a cloud record on a registered agent", () => {
    addAgent("zip", "/agents/zip", { auggyDir });
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip-production.up.railway.app",
        volumeId: "vol_ghi",
        deployedAt: "2026-05-06T00:00:00.000Z",
      },
      { auggyDir },
    );
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud).toEqual({
      provider: "railway",
      projectId: "proj_abc",
      serviceId: "svc_def",
      url: "https://zip-production.up.railway.app",
      volumeId: "vol_ghi",
      deployedAt: "2026-05-06T00:00:00.000Z",
    });
  });

  test("overwrites an existing cloud record (redeploy)", () => {
    addAgent("zip", "/agents/zip", { auggyDir });
    setCloud("zip", { provider: "railway", projectId: "p1", serviceId: "s1", url: "u1", volumeId: "v1", deployedAt: "2026-05-01T00:00:00.000Z" }, { auggyDir });
    setCloud("zip", { provider: "railway", projectId: "p1", serviceId: "s1", url: "u2", volumeId: "v1", deployedAt: "2026-05-06T00:00:00.000Z" }, { auggyDir });
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud?.url).toBe("u2");
    expect(entry?.cloud?.deployedAt).toBe("2026-05-06T00:00:00.000Z");
  });

  test("throws when the agent is not registered", () => {
    expect(() =>
      setCloud(
        "ghost",
        { provider: "railway", projectId: "p", serviceId: "s", url: "u", volumeId: "v", deployedAt: "2026-05-06T00:00:00.000Z" },
        { auggyDir },
      ),
    ).toThrow(/not registered/);
  });
});

describe("clearCloud", () => {
  test("nulls the cloud record; idempotent on already-null", () => {
    addAgent("zip", "/agents/zip", { auggyDir });
    setCloud("zip", { provider: "railway", projectId: "p", serviceId: "s", url: "u", volumeId: "v", deployedAt: "2026-05-06T00:00:00.000Z" }, { auggyDir });
    clearCloud("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
    // Second call: still null, no throw
    clearCloud("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });
});
```

Add `setCloud, clearCloud` to the existing import block at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/agent-index.test.ts`
Expected: FAIL — `setCloud` / `clearCloud` are not exported.

- [ ] **Step 3: Implement the mutators**

Append to `src/cli/agent-index.ts`, after `removeAgent`:

```ts
import type { CloudRecord } from "./types";

/**
 * Set the cloud deployment record for an agent. Throws if the agent is not
 * registered. Overwrites any existing record (used by redeploy).
 */
export function setCloud(name: string, cloud: NonNullable<CloudRecord>, opts: IndexOptions = {}): void {
  const lock = acquireLock(opts);
  try {
    const idx = readIndex(opts);
    const entry = idx.agents[name];
    if (!entry) {
      throw new Error(
        `Agent "${name}" is not registered. Run \`aug1 create ${name}\` first.`,
      );
    }
    idx.agents[name] = { ...entry, cloud };
    writeIndex(idx, opts);
  } finally {
    lock.release();
  }
}

/**
 * Clear the cloud deployment record. Idempotent — no-op when already null
 * or when the agent isn't registered (mirrors `removeAgent`).
 */
export function clearCloud(name: string, opts: IndexOptions = {}): void {
  const lock = acquireLock(opts);
  try {
    const idx = readIndex(opts);
    const entry = idx.agents[name];
    if (!entry || entry.cloud === null) return;
    idx.agents[name] = { ...entry, cloud: null };
    writeIndex(idx, opts);
  } finally {
    lock.release();
  }
}
```

The `import type { CloudRecord }` may need to move to the existing import block at top of file rather than mid-file — tidy as you go.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/cli/agent-index.test.ts`
Expected: PASS, including all pre-existing tests in the file (regression).

- [ ] **Step 5: Commit**

```bash
git add src/cli/agent-index.ts tests/cli/agent-index.test.ts
git commit -m "feat(cli): agent-index setCloud/clearCloud mutators"
```

---

## Task 2: Railway CLI subprocess wrapper

**Files:**
- Create: `src/cli/deploy/railway-cli.ts`
- Create: `tests/cli/deploy/railway-cli.test.ts`

This wrapper is the only file in the codebase that knows about the `railway` CLI binary. Every Railway operation flows through `runRailway(args, opts)`. The wrapper accepts a `spawn` factory in its options so tests can inject a mock without spawning real subprocesses.

- [ ] **Step 1: Write failing tests**

Create `tests/cli/deploy/railway-cli.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  createRailwayCli,
  RailwayCliMissingError,
  RailwayNotLoggedInError,
} from "../../../src/cli/deploy/railway-cli";

interface MockSpawnCall {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

function mockSpawn(
  responder: (args: string[]) => { stdout: string; stderr: string; exitCode: number },
) {
  const calls: MockSpawnCall[] = [];
  const factory = (cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    calls.push({ cmd, cwd: opts.cwd, env: opts.env });
    const res = responder(cmd.slice(1)); // drop the binary name
    return {
      exited: Promise.resolve(res.exitCode),
      stdout: new Response(res.stdout).body!,
      stderr: new Response(res.stderr).body!,
    };
  };
  return { factory, calls };
}

describe("railway-cli", () => {
  test("checkPresence returns true on `railway --version` exit 0", async () => {
    const { factory } = mockSpawn(() => ({ stdout: "railway 4.0.0\n", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkPresence()).resolves.toBe(true);
  });

  test("checkPresence throws RailwayCliMissingError on ENOENT", async () => {
    const factory = () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    const cli = createRailwayCli({ spawn: factory as any });
    await expect(cli.checkPresence()).rejects.toBeInstanceOf(RailwayCliMissingError);
  });

  test("checkAuth throws RailwayNotLoggedInError on `railway whoami` exit non-zero", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "",
      stderr: "Unauthorized. Run `railway login` first.\n",
      exitCode: 1,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkAuth()).rejects.toBeInstanceOf(RailwayNotLoggedInError);
  });

  test("checkAuth returns the username from `railway whoami` stdout", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "Logged in as alice@example.com\n",
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.checkAuth()).resolves.toBe("alice@example.com");
  });

  test("link runs `railway link` with --project + --service flags from the given cwd", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.link({ projectId: "proj_abc", serviceName: "zip", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "link", "--project", "proj_abc", "--service", "zip"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("setVariable runs `railway variables --set KEY=value`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.setVariable({ key: "ANTHROPIC_API_KEY", value: "sk-secret", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "variables", "--set", "ANTHROPIC_API_KEY=sk-secret"]);
  });

  test("up runs `railway up --detach`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "Build queued\n", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.up({ cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "up", "--detach"]);
    expect(calls[0]!.cwd).toBe("/tmp/staging");
  });

  test("generateDomain returns the URL captured from stdout", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "Domain created: https://zip-production-abcd.up.railway.app\n",
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
  });

  test("generateDomain returns existing URL on second call (idempotent)", async () => {
    let callCount = 0;
    const { factory } = mockSpawn(() => {
      callCount++;
      return {
        stdout: "https://zip-production-abcd.up.railway.app\n",
        stderr: callCount > 1 ? "Domain already exists\n" : "",
        exitCode: 0,
      };
    });
    const cli = createRailwayCli({ spawn: factory });
    await cli.generateDomain({ cwd: "/tmp/staging" });
    const url = await cli.generateDomain({ cwd: "/tmp/staging" });
    expect(url).toBe("https://zip-production-abcd.up.railway.app");
  });

  test("addVolume runs `railway volume add <name> --mount-path <path>`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.addVolume({ name: "zip-data", mountPath: "/app/data", cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual([
      "railway",
      "volume",
      "add",
      "zip-data",
      "--mount-path",
      "/app/data",
    ]);
  });

  test("status returns parsed JSON from `railway status --json`", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: JSON.stringify({
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status: "SUCCESS" },
      }),
      stderr: "",
      exitCode: 0,
    }));
    const cli = createRailwayCli({ spawn: factory });
    const status = await cli.status({ cwd: "/tmp/staging" });
    expect(status.project.id).toBe("proj_abc");
    expect(status.service.id).toBe("svc_def");
    expect(status.deployment.status).toBe("SUCCESS");
  });

  test("destroy runs `railway service delete --yes`", async () => {
    const { factory, calls } = mockSpawn(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cli = createRailwayCli({ spawn: factory });
    await cli.destroyService({ cwd: "/tmp/staging" });
    expect(calls[0]!.cmd).toEqual(["railway", "service", "delete", "--yes"]);
  });

  test("non-zero exit codes throw with stderr in the message", async () => {
    const { factory } = mockSpawn(() => ({
      stdout: "",
      stderr: "Project not found\n",
      exitCode: 1,
    }));
    const cli = createRailwayCli({ spawn: factory });
    await expect(cli.up({ cwd: "/tmp/staging" })).rejects.toThrow(/Project not found/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/deploy/railway-cli.test.ts`
Expected: FAIL with "Cannot find module '...railway-cli'".

- [ ] **Step 3: Implement the wrapper**

Create `src/cli/deploy/railway-cli.ts`:

```ts
/**
 * Railway CLI subprocess wrapper.
 *
 * Sole owner of `railway` binary knowledge in the codebase. Every Railway
 * operation calls `runRailway(args, opts)` which uses the injected spawn
 * factory (defaults to `Bun.spawn`). Tests override the factory to mock
 * subprocess behavior without spawning anything.
 *
 * Operator pre-requisites: `railway` CLI installed (https://docs.railway.com/develop/cli)
 * and `railway login` completed. We trust the operator's auth context — same
 * pattern as `git push` trusts `git`. No token storage in this codebase.
 */

export class RailwayCliMissingError extends Error {
  constructor() {
    super(
      "Railway CLI not found. Install it: https://docs.railway.com/develop/cli, then `railway login`.",
    );
    this.name = "RailwayCliMissingError";
  }
}

export class RailwayNotLoggedInError extends Error {
  constructor(detail: string) {
    super(`Railway CLI not authenticated: ${detail}\nRun \`railway login\` and try again.`);
    this.name = "RailwayNotLoggedInError";
  }
}

interface SpawnHandle {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export type RailwaySpawnFactory = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => SpawnHandle;

interface CreateRailwayCliOptions {
  /** Subprocess factory. Defaults to a thin Bun.spawn wrapper. */
  spawn?: RailwaySpawnFactory;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface RailwayStatus {
  project: { id: string; name: string };
  service: { id: string; name: string };
  deployment: { status: string };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

const defaultSpawn: RailwaySpawnFactory = (cmd, opts = {}) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: proc.exited,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
  };
};

export interface RailwayCli {
  checkPresence(): Promise<true>;
  checkAuth(): Promise<string>;
  link(args: { projectId: string; serviceName: string; cwd: string }): Promise<void>;
  setVariable(args: { key: string; value: string; cwd: string }): Promise<void>;
  up(args: { cwd: string }): Promise<void>;
  generateDomain(args: { cwd: string }): Promise<string>;
  addVolume(args: { name: string; mountPath: string; cwd: string }): Promise<void>;
  status(args: { cwd: string }): Promise<RailwayStatus>;
  destroyService(args: { cwd: string }): Promise<void>;
}

export function createRailwayCli(opts: CreateRailwayCliOptions = {}): RailwayCli {
  const spawn = opts.spawn ?? defaultSpawn;

  async function runRailway(
    args: string[],
    runOpts: RunOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let handle: SpawnHandle;
    try {
      handle = spawn(["railway", ...args], runOpts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RailwayCliMissingError();
      }
      throw err;
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      readAll(handle.stdout),
      readAll(handle.stderr),
      handle.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function runOrThrow(args: string[], runOpts: RunOptions = {}): Promise<string> {
    const { stdout, stderr, exitCode } = await runRailway(args, runOpts);
    if (exitCode !== 0) {
      throw new Error(
        `\`railway ${args.join(" ")}\` exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      );
    }
    return stdout;
  }

  return {
    async checkPresence() {
      const { exitCode, stderr } = await runRailway(["--version"]);
      if (exitCode !== 0) {
        throw new RailwayCliMissingError();
      }
      return true as const;
    },

    async checkAuth() {
      const { stdout, stderr, exitCode } = await runRailway(["whoami"]);
      if (exitCode !== 0) {
        throw new RailwayNotLoggedInError(stderr.trim() || stdout.trim());
      }
      // Railway's whoami output: "Logged in as <email>" — extract the email.
      const match = stdout.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
      return match ? match[0] : stdout.trim();
    },

    async link({ projectId, serviceName, cwd }) {
      await runOrThrow(["link", "--project", projectId, "--service", serviceName], { cwd });
    },

    async setVariable({ key, value, cwd }) {
      await runOrThrow(["variables", "--set", `${key}=${value}`], { cwd });
    },

    async up({ cwd }) {
      await runOrThrow(["up", "--detach"], { cwd });
    },

    async generateDomain({ cwd }) {
      const out = await runOrThrow(["domain", "--generate"], { cwd });
      const match = out.match(/https:\/\/[\w.-]+\.up\.railway\.app/);
      if (!match) {
        throw new Error(`Could not parse Railway domain from output: ${out.trim()}`);
      }
      return match[0];
    },

    async addVolume({ name, mountPath, cwd }) {
      await runOrThrow(["volume", "add", name, "--mount-path", mountPath], { cwd });
    },

    async status({ cwd }) {
      const out = await runOrThrow(["status", "--json"], { cwd });
      return JSON.parse(out) as RailwayStatus;
    },

    async destroyService({ cwd }) {
      await runOrThrow(["service", "delete", "--yes"], { cwd });
    },
  };
}
```

The exact Railway CLI flag spellings (`--project`, `--service`, `--mount-path`, `--detach`, `--generate`, `--set`, `--yes`, `--json`) match Railway CLI v4.x as of 2026-05. If the operator's installed version differs, `runOrThrow` surfaces the stderr in the error message, which contains the CLI's own usage hint — fix-forward by checking `railway <verb> --help`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/deploy/railway-cli.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/deploy/railway-cli.ts tests/cli/deploy/railway-cli.test.ts
git commit -m "feat(cli): railway CLI subprocess wrapper"
```

---

## Task 3: Bundle staging helper

**Files:**
- Create: `src/cli/deploy/bundle.ts`
- Create: `tests/cli/deploy/bundle.test.ts`

The bundle helper copies the agent dir into a staging directory, applying ADR-021's exclusion list. The deploy command then runs `railway up` from the staging dir, ensuring the volume-bound files (`memory.db`, `budgets.db`) and secrets (`.env`) never enter the Railway image.

- [ ] **Step 1: Write failing tests**

Create `tests/cli/deploy/bundle.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageBundle } from "../../../src/cli/deploy/bundle";

describe("stageBundle", () => {
  let agentDir: string;
  let cleanup: string[] = [];

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "auggy-bundle-test-"));
    cleanup.push(agentDir);
  });

  afterEach(() => {
    for (const d of cleanup) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    cleanup = [];
  });

  function seedAgentDir() {
    writeFileSync(join(agentDir, "agent.yaml"), "name: zip\n");
    writeFileSync(join(agentDir, "identity.md"), "# Identity\n");
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=secret\n");
    writeFileSync(join(agentDir, ".env.example"), "ANTHROPIC_API_KEY=\n");
    writeFileSync(join(agentDir, "memory.db"), "binary");
    writeFileSync(join(agentDir, "memory.db-wal"), "wal");
    writeFileSync(join(agentDir, "memory.db-shm"), "shm");
    writeFileSync(join(agentDir, "budgets.db"), "binary");
    mkdirSync(join(agentDir, "workspace"));
    writeFileSync(join(agentDir, "workspace", "scratch.txt"), "ephemeral");
    mkdirSync(join(agentDir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(agentDir, "node_modules", "x", "index.js"), "x");
    mkdirSync(join(agentDir, ".git"));
    writeFileSync(join(agentDir, ".git", "HEAD"), "ref");
    mkdirSync(join(agentDir, "skills", "facility"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "facility", "SKILL.md"), "# skill");
    writeFileSync(join(agentDir, ".DS_Store"), "junk");
  }

  test("copies non-excluded files into the staging dir", () => {
    seedAgentDir();
    const staged = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(staged);
    expect(existsSync(join(staged, "agent.yaml"))).toBe(true);
    expect(existsSync(join(staged, "identity.md"))).toBe(true);
    expect(existsSync(join(staged, "skills", "facility", "SKILL.md"))).toBe(true);
    expect(existsSync(join(staged, ".env.example"))).toBe(true);
  });

  test("excludes .env, *.db*, workspace/, node_modules/, .git/, .DS_Store", () => {
    seedAgentDir();
    const staged = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(staged);
    expect(existsSync(join(staged, ".env"))).toBe(false);
    expect(existsSync(join(staged, "memory.db"))).toBe(false);
    expect(existsSync(join(staged, "memory.db-wal"))).toBe(false);
    expect(existsSync(join(staged, "memory.db-shm"))).toBe(false);
    expect(existsSync(join(staged, "budgets.db"))).toBe(false);
    expect(existsSync(join(staged, "workspace"))).toBe(false);
    expect(existsSync(join(staged, "node_modules"))).toBe(false);
    expect(existsSync(join(staged, ".git"))).toBe(false);
    expect(existsSync(join(staged, ".DS_Store"))).toBe(false);
  });

  test("returns an absolute path to a fresh staging dir each call", () => {
    seedAgentDir();
    const a = stageBundle({ agentDir, agentName: "zip" });
    const b = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(a, b);
    expect(a).not.toBe(b);
    expect(a.startsWith("/")).toBe(true);
  });

  test("throws when the agent dir does not exist", () => {
    expect(() => stageBundle({ agentDir: "/no/such/path", agentName: "zip" })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/deploy/bundle.test.ts`
Expected: FAIL with "Cannot find module '...bundle'".

- [ ] **Step 3: Implement the bundler**

Create `src/cli/deploy/bundle.ts`:

```ts
/**
 * Bundle staging — copies an agent dir into a fresh temp directory minus the
 * exclusions defined by ADR-021 (`.env`, `workspace/`, `*.db*`, `node_modules/`,
 * `.git/`, `.DS_Store`, `*.tmp`).
 *
 * The deploy command runs `railway up` from the staging dir to ensure
 * volume-bound state and secrets never enter the cloud image.
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface StageBundleOptions {
  agentDir: string;
  agentName: string;
}

const EXCLUDED_NAMES = new Set([".env", ".git", ".DS_Store", "node_modules", "workspace"]);

function isExcludedFile(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  // *.db, *.db-wal, *.db-shm
  if (/\.db(-(?:wal|shm))?$/.test(name)) return true;
  // *.tmp
  if (name.endsWith(".tmp")) return true;
  return false;
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isExcludedFile(entry)) continue;
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      copyTree(srcPath, dstPath);
    } else if (stats.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
    // skip symlinks, sockets, etc. — agent dirs shouldn't have them
  }
}

/**
 * Copy the agent dir into a fresh temp staging dir minus exclusions.
 * Returns the absolute path to the staging dir.
 */
export function stageBundle(opts: StageBundleOptions): string {
  if (!existsSync(opts.agentDir)) {
    throw new Error(`Agent directory not found: ${opts.agentDir}`);
  }
  const staging = mkdtempSync(join(tmpdir(), `auggy-deploy-${opts.agentName}-`));
  copyTree(opts.agentDir, staging);
  return staging;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/deploy/bundle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/deploy/bundle.ts tests/cli/deploy/bundle.test.ts
git commit -m "feat(cli): bundle staging with ADR-021 exclusions"
```

---

## Task 4: Secrets bridge — `.env` parser + push plan

**Files:**
- Create: `src/cli/deploy/secrets.ts`
- Create: `tests/cli/deploy/secrets.test.ts`

The secrets bridge reads the agent's `.env` file, parses it into a key=value plan, and returns the plan for confirmation. It does NOT execute the push — that's the deploy command's job after the operator confirms.

- [ ] **Step 1: Write failing tests**

Create `tests/cli/deploy/secrets.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planSecretsPush } from "../../../src/cli/deploy/secrets";

describe("planSecretsPush", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auggy-secrets-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("parses a simple .env file", () => {
    writeFileSync(
      join(dir, ".env"),
      "ANTHROPIC_API_KEY=sk-abc\nWEB_BEARER_TOKEN=tok-1\n",
    );
    const plan = planSecretsPush({ envPath: join(dir, ".env") });
    expect(plan.entries).toEqual([
      { key: "ANTHROPIC_API_KEY", value: "sk-abc" },
      { key: "WEB_BEARER_TOKEN", value: "tok-1" },
    ]);
  });

  test("skips comments and blank lines", () => {
    writeFileSync(
      join(dir, ".env"),
      "# This is a comment\nKEY=value\n\n  # indented comment\nOTHER=v2\n",
    );
    const plan = planSecretsPush({ envPath: join(dir, ".env") });
    expect(plan.entries).toEqual([
      { key: "KEY", value: "value" },
      { key: "OTHER", value: "v2" },
    ]);
  });

  test("strips surrounding double or single quotes from values", () => {
    writeFileSync(
      join(dir, ".env"),
      `A="quoted"\nB='single'\nC=plain\nD="with spaces"\n`,
    );
    const plan = planSecretsPush({ envPath: join(dir, ".env") });
    expect(plan.entries).toEqual([
      { key: "A", value: "quoted" },
      { key: "B", value: "single" },
      { key: "C", value: "plain" },
      { key: "D", value: "with spaces" },
    ]);
  });

  test("returns empty plan when .env does not exist (operator may have all secrets via Railway UI)", () => {
    const plan = planSecretsPush({ envPath: join(dir, ".env") });
    expect(plan.entries).toEqual([]);
    expect(plan.envFileExists).toBe(false);
  });

  test("excludes keys listed in skipKeys (e.g. AUGGY_PUBLIC_URL is set by deploy itself)", () => {
    writeFileSync(
      join(dir, ".env"),
      "ANTHROPIC_API_KEY=sk-abc\nAUGGY_PUBLIC_URL=http://localhost:8080\n",
    );
    const plan = planSecretsPush({
      envPath: join(dir, ".env"),
      skipKeys: ["AUGGY_PUBLIC_URL"],
    });
    expect(plan.entries.map((e) => e.key)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  test("rejects malformed lines (no equals sign) by surfacing them in errors", () => {
    writeFileSync(join(dir, ".env"), "VALID=ok\nINVALID_NO_EQUALS\nVALID2=ok2\n");
    const plan = planSecretsPush({ envPath: join(dir, ".env") });
    expect(plan.entries.map((e) => e.key)).toEqual(["VALID", "VALID2"]);
    expect(plan.errors).toEqual(["line 2: missing '=' in 'INVALID_NO_EQUALS'"]);
  });

  test("renderForPrompt produces a redacted preview suitable for operator confirmation", () => {
    writeFileSync(
      join(dir, ".env"),
      "ANTHROPIC_API_KEY=sk-abc-very-long-secret\nFOO=short\n",
    );
    const plan = planSecretsPush({ envPath: join(dir, ".env") });
    const lines = plan.renderForPrompt();
    expect(lines).toEqual([
      "ANTHROPIC_API_KEY=sk-abc…cret  (24 chars)",
      "FOO=short  (5 chars)",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/deploy/secrets.test.ts`
Expected: FAIL with "Cannot find module '...secrets'".

- [ ] **Step 3: Implement the bridge**

Create `src/cli/deploy/secrets.ts`:

```ts
/**
 * Secrets bridge — parses the agent's `.env` file and plans an env-var push
 * to Railway. Returns a structured plan; does NOT execute the push.
 *
 * The deploy command renders the plan for operator confirmation before
 * iterating it through `railway variables --set KEY=value`.
 */

import { existsSync, readFileSync } from "node:fs";

export interface SecretEntry {
  key: string;
  value: string;
}

export interface SecretsPushPlan {
  envFileExists: boolean;
  entries: SecretEntry[];
  errors: string[];
  /** Render a redacted preview of each entry, one line per entry. */
  renderForPrompt(): string[];
}

interface PlanOptions {
  envPath: string;
  /** Keys to omit from the plan (e.g. AUGGY_PUBLIC_URL — set by deploy itself). */
  skipKeys?: string[];
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function redact(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function planSecretsPush(opts: PlanOptions): SecretsPushPlan {
  const skipKeys = new Set(opts.skipKeys ?? []);

  if (!existsSync(opts.envPath)) {
    return {
      envFileExists: false,
      entries: [],
      errors: [],
      renderForPrompt: () => [],
    };
  }

  const raw = readFileSync(opts.envPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const entries: SecretEntry[] = [];
  const errors: string[] = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      errors.push(`line ${idx + 1}: missing '=' in '${trimmed}'`);
      return;
    }
    const key = trimmed.slice(0, eq).trim();
    const valueRaw = trimmed.slice(eq + 1).trim();
    const value = unquote(valueRaw);
    if (skipKeys.has(key)) return;
    entries.push({ key, value });
  });

  return {
    envFileExists: true,
    entries,
    errors,
    renderForPrompt: () =>
      entries.map((e) => `${e.key}=${redact(e.value)}  (${e.value.length} chars)`),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/deploy/secrets.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/deploy/secrets.ts tests/cli/deploy/secrets.test.ts
git commit -m "feat(cli): .env → Railway secrets push planner"
```

---

## Task 5: Dockerfile + entrypoint generator

**Files:**
- Create: `src/cli/deploy/dockerfile.ts`
- Create: `tests/cli/deploy/dockerfile.test.ts`

This module generates the Dockerfile + entrypoint script as strings. The deploy command writes them into the staging dir before `railway up` runs.

The Dockerfile installs Bun, copies the staged agent dir, installs `aug1` globally (from the published npm package or, if running against a workspace clone, from the local source — see comments in the impl), and execs the entrypoint script. The entrypoint symlinks `./memory.db` → `/app/data/memory.db` (and the same for `budgets.db`), then execs `aug1 dev <name> --internal-mode railway`.

ADR-021 line 144: "Symlinks `./memory.db` → `/app/data/memory.db` (and the WAL/SHM files if SQLite recreates them on attach), same for `./budgets.db`."

- [ ] **Step 1: Write failing tests**

Create `tests/cli/deploy/dockerfile.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { generateDockerfile, generateEntrypoint } from "../../../src/cli/deploy/dockerfile";

describe("generateDockerfile", () => {
  test("uses the official Bun base image", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/^FROM\s+oven\/bun:/m);
  });

  test("installs aug1 globally", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/bun install -g augment-1/);
  });

  test("copies the agent dir to /app", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/^COPY \. \/app$/m);
  });

  test("declares /app/data as a volume mount target", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/^VOLUME \["\/app\/data"\]$/m);
  });

  test("exposes port 8080 (web transport default)", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/^EXPOSE 8080$/m);
  });

  test("calls the entrypoint script with the agent name", () => {
    const df = generateDockerfile({ agentName: "zip" });
    expect(df).toMatch(/ENTRYPOINT \["\/app\/auggy-entrypoint\.sh", "zip"\]/);
  });
});

describe("generateEntrypoint", () => {
  test("uses #!/bin/sh and `set -e`", () => {
    const sh = generateEntrypoint();
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toMatch(/^set -e$/m);
  });

  test("creates the volume target dir if missing", () => {
    const sh = generateEntrypoint();
    expect(sh).toMatch(/mkdir -p \/app\/data/);
  });

  test("symlinks memory.db and budgets.db to /app/data/", () => {
    const sh = generateEntrypoint();
    expect(sh).toMatch(/ln -sf \/app\/data\/memory\.db \/app\/memory\.db/);
    expect(sh).toMatch(/ln -sf \/app\/data\/budgets\.db \/app\/budgets\.db/);
  });

  test("execs aug1 dev with --internal-mode railway", () => {
    const sh = generateEntrypoint();
    expect(sh).toMatch(/^exec aug1 dev "\$1" --internal-mode railway$/m);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/deploy/dockerfile.test.ts`
Expected: FAIL with "Cannot find module '...dockerfile'".

- [ ] **Step 3: Implement the generator**

Create `src/cli/deploy/dockerfile.ts`:

```ts
/**
 * Dockerfile + entrypoint generator for `aug1 deploy`.
 *
 * The deploy command writes the output of these functions into the staging
 * dir before `railway up`. ADR-021 cloud design: bake-in the volume symlink
 * dance + `aug1 dev --internal-mode railway` invocation so `agent.yaml`'s
 * `dbPath: ./memory.db` works unchanged in cloud.
 */

const BUN_VERSION = "1.1-alpine"; // pin a specific Bun base; bump deliberately.

interface DockerfileOptions {
  agentName: string;
}

export function generateDockerfile(opts: DockerfileOptions): string {
  return `FROM oven/bun:${BUN_VERSION}

WORKDIR /app

# Install aug1 globally so the entrypoint can call \`aug1 dev\`.
RUN bun install -g augment-1

COPY . /app

# Make the entrypoint executable.
RUN chmod +x /app/auggy-entrypoint.sh

VOLUME ["/app/data"]

EXPOSE 8080

ENTRYPOINT ["/app/auggy-entrypoint.sh", "${opts.agentName}"]
`;
}

export function generateEntrypoint(): string {
  return `#!/bin/sh
# Auggy Railway entrypoint.
# - Volume is mounted at /app/data (Railway-managed; persists across redeploys).
# - SQLite-backed augments (layeredMemory, budgets) write to ./memory.db
#   and ./budgets.db; we symlink those names into the volume so paths in
#   agent.yaml stay unchanged between local and cloud.
# - WAL/SHM siblings are recreated by SQLite on attach; symlinks to the
#   volume cover that pattern (SQLite follows the symlink and creates the
#   sibling files alongside the target).

set -e

mkdir -p /app/data

# Symlink SQLite files to the volume. -f overwrites any prior symlink so
# redeploys don't fail on the second run; the actual data lives in /app/data.
ln -sf /app/data/memory.db /app/memory.db
ln -sf /app/data/budgets.db /app/budgets.db

# $1 is the agent name passed by ENTRYPOINT.
exec aug1 dev "$1" --internal-mode railway
`;
}
```

The `--internal-mode railway` flag is already supported by `aug1 dev` (`src/cli/index.ts:67` accepts `--internal-mode <mode>`). It surfaces in the PID manifest as `mode: "railway"`. No additional CLI changes needed for this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/deploy/dockerfile.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/deploy/dockerfile.ts tests/cli/deploy/dockerfile.test.ts
git commit -m "feat(cli): Dockerfile + entrypoint generator for railway deploy"
```

---

## Task 6: `aug1 deploy` command — first-deploy path

**Files:**
- Create: `src/cli/commands/deploy.ts`
- Create: `tests/cli/deploy.test.ts`

The command orchestrates: presence checks → resolve agent → confirm with operator → stage bundle → write Dockerfile + entrypoint → init Railway service if first deploy → push secrets → `railway up` → generate domain → write CloudRecord to index.

For testability, `runDeploy` accepts a dependency-injection options bag carrying the Railway CLI instance, the prompt function, the printer, and the index opts. Production `aug1 deploy` builds the real CLI; tests inject a mock CLI + scripted prompts.

This task covers the **first-deploy** path (no existing CloudRecord). Task 7 covers the redeploy path.

- [ ] **Step 1: Write the failing test for first-deploy**

Create `tests/cli/deploy.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDeploy } from "../../src/cli/commands/deploy";
import { addAgent, getAgent, setCloud } from "../../src/cli/agent-index";
import type { RailwayCli } from "../../src/cli/deploy/railway-cli";

interface MockCliCalls {
  checkPresence: number;
  checkAuth: number;
  link: Array<{ projectId: string; serviceName: string }>;
  setVariable: Array<{ key: string; value: string }>;
  up: number;
  generateDomain: number;
  addVolume: Array<{ name: string; mountPath: string }>;
  status: number;
}

function mockRailwayCli(overrides: Partial<RailwayCli> = {}): { cli: RailwayCli; calls: MockCliCalls } {
  const calls: MockCliCalls = {
    checkPresence: 0,
    checkAuth: 0,
    link: [],
    setVariable: [],
    up: 0,
    generateDomain: 0,
    addVolume: [],
    status: 0,
  };
  const cli: RailwayCli = {
    async checkPresence() {
      calls.checkPresence++;
      return true as const;
    },
    async checkAuth() {
      calls.checkAuth++;
      return "operator@example.com";
    },
    async link({ projectId, serviceName }) {
      calls.link.push({ projectId, serviceName });
    },
    async setVariable({ key, value }) {
      calls.setVariable.push({ key, value });
    },
    async up() {
      calls.up++;
    },
    async generateDomain() {
      calls.generateDomain++;
      return "https://zip-production-abcd.up.railway.app";
    },
    async addVolume({ name, mountPath }) {
      calls.addVolume.push({ name, mountPath });
    },
    async status() {
      calls.status++;
      return {
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status: "SUCCESS" },
      };
    },
    async destroyService() {
      // not used in deploy
    },
    ...overrides,
  };
  return { cli, calls };
}

describe("runDeploy — first deploy", () => {
  let auggyDir: string;
  let agentDir: string;

  beforeEach(() => {
    auggyDir = mkdtempSync(join(tmpdir(), "auggy-deploy-test-"));
    agentDir = join(auggyDir, "agents", "zip");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), "name: zip\nmodel: claude-sonnet-4-6\n");
    writeFileSync(join(agentDir, "identity.md"), "# Zip\n");
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-test\nWEB_BEARER_TOKEN=tok-1\n");
    addAgent("zip", agentDir, { auggyDir });
  });

  afterEach(() => {
    rmSync(auggyDir, { recursive: true, force: true });
  });

  test("first deploy: links, pushes secrets, runs up, generates domain, writes CloudRecord", async () => {
    const { cli, calls } = mockRailwayCli();
    const prompts: string[] = [];
    const result = await runDeploy("zip", {
      to: "railway",
      yes: false,
      auggyDir,
      cli,
      promptProjectId: async () => {
        prompts.push("project");
        return "proj_abc";
      },
      promptConfirm: async (msg) => {
        prompts.push(`confirm:${msg}`);
        return true;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(calls.checkPresence).toBe(1);
    expect(calls.checkAuth).toBe(1);
    expect(calls.link).toEqual([{ projectId: "proj_abc", serviceName: "zip" }]);
    expect(calls.addVolume).toEqual([{ name: "zip-data", mountPath: "/app/data" }]);
    // Secrets pushed: ANTHROPIC_API_KEY, WEB_BEARER_TOKEN, plus AUGGY_PUBLIC_URL after domain.
    const keys = calls.setVariable.map((v) => v.key).sort();
    expect(keys).toEqual(["ANTHROPIC_API_KEY", "AUGGY_PUBLIC_URL", "WEB_BEARER_TOKEN"]);
    const publicUrlVar = calls.setVariable.find((v) => v.key === "AUGGY_PUBLIC_URL");
    expect(publicUrlVar?.value).toBe("https://zip-production-abcd.up.railway.app");
    expect(calls.up).toBe(1);
    expect(calls.generateDomain).toBe(1);
    expect(result.url).toBe("https://zip-production-abcd.up.railway.app");
    // Index updated.
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud).toMatchObject({
      provider: "railway",
      projectId: "proj_abc",
      serviceId: "svc_def",
      url: "https://zip-production-abcd.up.railway.app",
      volumeId: "zip-data",
    });
  });

  test("aborts when operator declines secrets-push confirmation", async () => {
    const { cli, calls } = mockRailwayCli();
    await expect(
      runDeploy("zip", {
        to: "railway",
        yes: false,
        auggyDir,
        cli,
        promptProjectId: async () => "proj_abc",
        promptConfirm: async () => false,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/aborted/i);
    expect(calls.up).toBe(0);
    expect(calls.setVariable).toEqual([]);
    // Index NOT updated.
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("--yes flag skips the confirmation prompt", async () => {
    const { cli } = mockRailwayCli();
    let promptCalled = false;
    await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => "proj_abc",
      promptConfirm: async () => {
        promptCalled = true;
        return true;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(promptCalled).toBe(false);
  });

  test("rejects unknown providers", async () => {
    await expect(
      runDeploy("zip", {
        to: "fly" as any,
        yes: false,
        auggyDir,
        cli: mockRailwayCli().cli,
        promptProjectId: async () => "x",
        promptConfirm: async () => true,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/only railway is supported/i);
  });

  test("throws when the agent is not registered", async () => {
    await expect(
      runDeploy("ghost", {
        to: "railway",
        yes: true,
        auggyDir,
        cli: mockRailwayCli().cli,
        promptProjectId: async () => "x",
        promptConfirm: async () => true,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/not registered/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/deploy.test.ts`
Expected: FAIL with "Cannot find module '...deploy'".

- [ ] **Step 3: Implement the command (first-deploy path only)**

Create `src/cli/commands/deploy.ts`:

```ts
/**
 * `aug1 deploy <name> --to railway` — provisions a Railway service for a
 * registered agent and pushes the agent dir + secrets. Idempotent: a re-run
 * with an existing CloudRecord skips the init/volume steps and just bundles
 * + pushes (see Task 7).
 *
 * Operator pre-requisites:
 *   - `railway` CLI installed and `railway login` completed
 *   - Agent registered locally (`aug1 create <name>` or `aug1 dev` already worked)
 *   - `.env` file in the agent dir contains the secrets the agent needs
 *     (the deploy will push these to Railway env vars)
 *
 * Trust posture: shells out to the operator's authenticated `railway` CLI.
 * No Railway API token is stored or transmitted by this code.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgent, setCloud } from "../agent-index";
import type { IndexEntry } from "../types";
import {
  createRailwayCli,
  RailwayCliMissingError,
  RailwayNotLoggedInError,
} from "../deploy/railway-cli";
import type { RailwayCli } from "../deploy/railway-cli";
import { stageBundle } from "../deploy/bundle";
import { planSecretsPush } from "../deploy/secrets";
import { generateDockerfile, generateEntrypoint } from "../deploy/dockerfile";

export type DeployTarget = "railway";

interface DeployLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface RunDeployOptions {
  to: DeployTarget;
  yes?: boolean;
  /** Override `~/.auggy/` for tests (matches `RemoveOptions.auggyDir`). */
  auggyDir?: string;
  /** Railway CLI dependency injection. Production: omit and the default is built. */
  cli?: RailwayCli;
  /** Prompt for Railway project id (first deploy only). Production: stdin reader. */
  promptProjectId?: () => Promise<string>;
  /** Yes/no confirmation prompt. Returns true on yes. */
  promptConfirm?: (message: string) => Promise<boolean>;
  /** Logger override. Production: console-backed. */
  logger?: DeployLogger;
}

export interface DeployResult {
  url: string;
  projectId: string;
  serviceId: string;
}

const VOLUME_MOUNT_PATH = "/app/data";

function defaultLogger(): DeployLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

async function defaultPromptProjectId(): Promise<string> {
  const { default: prompts } = await import("prompts");
  const res = await prompts({
    type: "text",
    name: "projectId",
    message:
      "Railway project id (find with `railway list` or create one in the Railway UI):",
    validate: (v: string) => (v.trim().length > 0 ? true : "Project id required"),
  });
  if (!res.projectId) throw new Error("Project id required.");
  return res.projectId.trim();
}

async function defaultPromptConfirm(message: string): Promise<boolean> {
  const { default: prompts } = await import("prompts");
  const res = await prompts({ type: "confirm", name: "ok", message, initial: false });
  return Boolean(res.ok);
}

export async function runDeploy(name: string, opts: RunDeployOptions): Promise<DeployResult> {
  if (opts.to !== "railway") {
    throw new Error(`--to "${opts.to}" not supported. Only railway is supported at v1.`);
  }

  const log = opts.logger ?? defaultLogger();
  const cli = opts.cli ?? createRailwayCli();
  const promptProjectId = opts.promptProjectId ?? defaultPromptProjectId;
  const promptConfirm = opts.promptConfirm ?? defaultPromptConfirm;

  const entry: IndexEntry | null = getAgent(name, { auggyDir: opts.auggyDir });
  if (!entry) {
    throw new Error(
      `Agent "${name}" is not registered. Run \`aug1 create ${name}\` first.`,
    );
  }

  log.info(`Checking Railway CLI…`);
  await cli.checkPresence();
  const who = await cli.checkAuth();
  log.info(`Logged in to Railway as ${who}.`);

  const isFirstDeploy = entry.cloud === null;
  if (isFirstDeploy) {
    log.info(`First deploy of "${name}". This will create a Railway service + volume.`);
  } else {
    log.info(`Redeploying "${name}" to existing Railway service ${entry.cloud!.serviceId}.`);
  }

  // Plan secrets push BEFORE any irreversible step so the operator can abort cleanly.
  const envPath = join(entry.localDir, ".env");
  const plan = planSecretsPush({
    envPath,
    skipKeys: ["AUGGY_PUBLIC_URL"], // set by deploy itself after domain generation
  });
  if (plan.errors.length > 0) {
    log.warn(`Issues parsing .env:\n  ${plan.errors.join("\n  ")}`);
  }

  // Build the staging dir.
  log.info(`Staging bundle…`);
  const staging = stageBundle({ agentDir: entry.localDir, agentName: name });
  // Write Dockerfile + entrypoint into the staging dir.
  writeFileSync(join(staging, "Dockerfile"), generateDockerfile({ agentName: name }));
  writeFileSync(join(staging, "auggy-entrypoint.sh"), generateEntrypoint(), { mode: 0o755 });

  // Confirm secrets push.
  if (!opts.yes) {
    const previewLines = plan.renderForPrompt();
    const previewBlock =
      previewLines.length > 0
        ? `\n  ${previewLines.join("\n  ")}`
        : "  (no .env entries — Railway env vars must be set manually if required)";
    const confirmed = await promptConfirm(
      `About to push ${plan.entries.length} env vars to Railway:${previewBlock}\n` +
        `Plus AUGGY_PUBLIC_URL after domain generation. Proceed?`,
    );
    if (!confirmed) {
      throw new Error("Deploy aborted by operator.");
    }
  }

  // First deploy: link to a new service in operator-chosen project, then add volume.
  // Redeploy: link to the existing service id (no volume changes).
  let projectId: string;
  if (isFirstDeploy) {
    projectId = await promptProjectId();
    log.info(`Linking new service "${name}" in project ${projectId}…`);
    await cli.link({ projectId, serviceName: name, cwd: staging });
    log.info(`Adding volume "${name}-data" mounted at ${VOLUME_MOUNT_PATH}…`);
    await cli.addVolume({ name: `${name}-data`, mountPath: VOLUME_MOUNT_PATH, cwd: staging });
  } else {
    projectId = entry.cloud!.projectId;
    log.info(`Linking to existing service ${entry.cloud!.serviceId}…`);
    await cli.link({ projectId, serviceName: name, cwd: staging });
  }

  // Push secrets.
  log.info(`Pushing ${plan.entries.length} env vars…`);
  for (const e of plan.entries) {
    await cli.setVariable({ key: e.key, value: e.value, cwd: staging });
  }

  // Push code.
  log.info(`Pushing code (\`railway up --detach\`)…`);
  await cli.up({ cwd: staging });

  // Generate (or fetch existing) domain.
  log.info(`Generating Railway domain…`);
  const url = await cli.generateDomain({ cwd: staging });
  log.info(`Service URL: ${url}`);

  // Set AUGGY_PUBLIC_URL so the agent can self-detect its public URL.
  await cli.setVariable({ key: "AUGGY_PUBLIC_URL", value: url, cwd: staging });

  // Read service+project ids from `railway status --json` and persist.
  const status = await cli.status({ cwd: staging });
  setCloud(
    name,
    {
      provider: "railway",
      projectId: status.project.id,
      serviceId: status.service.id,
      url,
      volumeId: `${name}-data`,
      deployedAt: new Date().toISOString(),
    },
    { auggyDir: opts.auggyDir },
  );

  log.info(`✓ Deployed ${name} to ${url}`);
  return { url, projectId: status.project.id, serviceId: status.service.id };
}

// Re-export so the dispatcher in src/cli/index.ts can import a single symbol.
export { RailwayCliMissingError, RailwayNotLoggedInError };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/deploy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/deploy.ts tests/cli/deploy.test.ts
git commit -m "feat(cli): aug1 deploy --to railway (first-deploy path)"
```

---

## Task 7: Redeploy path (existing CloudRecord → no init, no volume)

**Files:**
- Modify: `tests/cli/deploy.test.ts` (add 2 tests for redeploy)

The Task 6 implementation already handles the redeploy branch (`isFirstDeploy = entry.cloud === null` and the conditional below it). This task locks the redeploy contract with explicit tests.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli/deploy.test.ts`:

```ts
describe("runDeploy — redeploy", () => {
  let auggyDir: string;
  let agentDir: string;

  beforeEach(() => {
    auggyDir = mkdtempSync(join(tmpdir(), "auggy-redeploy-test-"));
    agentDir = join(auggyDir, "agents", "zip");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), "name: zip\n");
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-test\n");
    addAgent("zip", agentDir, { auggyDir });
    // Pre-existing cloud record => redeploy path.
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip-production-abcd.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-01T00:00:00.000Z",
      },
      { auggyDir },
    );
  });

  afterEach(() => {
    rmSync(auggyDir, { recursive: true, force: true });
  });

  test("redeploy: skips volume creation; reuses existing project + service", async () => {
    const { cli, calls } = mockRailwayCli();
    let projectIdPrompted = false;
    await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => {
        projectIdPrompted = true;
        return "should-not-be-called";
      },
      promptConfirm: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(projectIdPrompted).toBe(false);
    expect(calls.addVolume).toEqual([]);
    expect(calls.link).toEqual([{ projectId: "proj_abc", serviceName: "zip" }]);
    expect(calls.up).toBe(1);
  });

  test("redeploy: bumps deployedAt timestamp in the index", async () => {
    const { cli } = mockRailwayCli();
    const beforeEntry = getAgent("zip", { auggyDir });
    const beforeTs = beforeEntry?.cloud?.deployedAt;
    // Wait a tick to ensure ISO string changes.
    await new Promise((r) => setTimeout(r, 5));
    await runDeploy("zip", {
      to: "railway",
      yes: true,
      auggyDir,
      cli,
      promptProjectId: async () => "x",
      promptConfirm: async () => true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const afterEntry = getAgent("zip", { auggyDir });
    const afterTs = afterEntry?.cloud?.deployedAt;
    expect(afterTs).toBeDefined();
    expect(afterTs! > beforeTs!).toBe(true);
  });
});
```

`setCloud` is already imported per Task 6 step 1. No additional import needed.

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/cli/deploy.test.ts`
Expected: PASS — Task 6's `isFirstDeploy` branch already correctly skips `addVolume` and reuses `entry.cloud!.projectId` when a CloudRecord exists. These tests are contract locks.

- [ ] **Step 3: Commit**

```bash
git add tests/cli/deploy.test.ts
git commit -m "test(cli): lock redeploy contract"
```

---

## Task 8: Wire the command into the CLI dispatcher

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Read the existing dispatcher**

Open `src/cli/index.ts`. Note the pattern:

```ts
import { runRemove } from "./commands/remove";
import { runLs } from "./commands/ls";

program
  .command("remove <name>")
  .description("...")
  .option("--yes", "...")
  .action(async (name, opts) => { ... });
```

- [ ] **Step 2: Add the import + command**

Add `import { runDeploy } from "./commands/deploy";` at the top with the other command imports.

After the last `program.command(...)` block (currently `aug1 remove`), insert:

```ts
program
  .command("deploy <name>")
  .description("Deploy a registered agent to a cloud target (Railway only at v1)")
  .option("--to <provider>", "deployment target", "railway")
  .option("--yes", "skip the secrets-push confirmation prompt")
  .action(async (name: string, opts: { to: string; yes?: boolean }) => {
    try {
      await runDeploy(name, {
        to: opts.to as "railway",
        yes: opts.yes,
      });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
```

Update the JSDoc Commands list at the top of the file to include:

```
 *   aug1 deploy <name> --to railway   Deploy to a cloud target
```

- [ ] **Step 3: Sanity-check the CLI compiles**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Smoke test the CLI parses (no-args help)**

Run: `bun src/cli/index.ts --help`
Expected: output includes the line `deploy <name>          Deploy a registered agent to a cloud target (Railway only at v1)`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire aug1 deploy into dispatcher"
```

---

## Task 9: `aug1 remove <name> --cloud` flag

**Files:**
- Modify: `src/cli/commands/remove.ts`
- Modify: `tests/cli/remove.test.ts`
- Modify: `src/cli/index.ts`

Extend the existing `aug1 remove` command with a `--cloud` flag. When set, also call `cli.destroyService` and `clearCloud(name)`. Mirrors the destructive-action UX of the local case — `@inquirer/prompts confirm` is mocked at the top of the existing test file via `mock.module(...)`, returning a `confirmAnswer` let-bound that defaults to `true`; flip to `false` for decline-aborts test.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli/remove.test.ts` after the existing `describe("runRemove", ...)` block:

```ts
import { setCloud } from "../../src/cli/agent-index";
import type { RailwayCli } from "../../src/cli/deploy/railway-cli";

interface MockCalls {
  link: number;
  destroy: number;
}

function mockRailwayCliForRemove(): { cli: RailwayCli; calls: MockCalls } {
  const calls: MockCalls = { link: 0, destroy: 0 };
  const cli: RailwayCli = {
    async checkPresence() { return true as const; },
    async checkAuth() { return "operator@example.com"; },
    async link() { calls.link++; },
    async setVariable() {},
    async up() {},
    async generateDomain() { return "https://x.up.railway.app"; },
    async addVolume() {},
    async status() {
      return {
        project: { id: "proj_abc", name: "lorf" },
        service: { id: "svc_def", name: "zip" },
        deployment: { status: "SUCCESS" },
      };
    },
    async destroyService() { calls.destroy++; },
  };
  return { cli, calls };
}

describe("runRemove --cloud", () => {
  test("destroys Railway service when --cloud is set and CloudRecord exists", async () => {
    const dir = setupAgent("zip");
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-01T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli, calls } = mockRailwayCliForRemove();
    await runRemove("zip", { yes: true, auggyDir, cloud: true, cli });
    expect(calls.destroy).toBe(1);
    expect(existsSync(dir)).toBe(false);
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("--cloud on agent with no CloudRecord skips destroy cleanly; local removal still proceeds", async () => {
    const dir = setupAgent("zip");
    // No setCloud — cloud field is null.
    const { cli, calls } = mockRailwayCliForRemove();
    await runRemove("zip", { yes: true, auggyDir, cloud: true, cli });
    expect(calls.destroy).toBe(0);
    expect(existsSync(dir)).toBe(false);
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("--cloud without --yes prompts; declining aborts BEFORE destroying or removing locally", async () => {
    const dir = setupAgent("zip");
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "p",
        serviceId: "s",
        url: "u",
        volumeId: "v",
        deployedAt: "2026-05-01T00:00:00.000Z",
      },
      { auggyDir },
    );
    const { cli, calls } = mockRailwayCliForRemove();
    confirmAnswer = false;
    try {
      await runRemove("zip", { yes: false, auggyDir, cloud: true, cli });
    } finally {
      confirmAnswer = true; // restore default for subsequent tests
    }
    expect(calls.destroy).toBe(0);
    expect(existsSync(dir)).toBe(true);
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })?.cloud).not.toBeNull();
  });
});
```

These tests follow the existing file's patterns: top-level `auggyDir` from the file's `beforeEach`, the `setupAgent` helper already in the file, the `confirmAnswer` let-bound that the file's `mock.module(...)` block returns, dynamic `import` of `getAgent` (matching how the existing `--yes` test does it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/remove.test.ts`
Expected: FAIL — `cloud` and `cli` options don't exist on `RemoveOptions` yet.

- [ ] **Step 3: Implement the `--cloud` flag in `src/cli/commands/remove.ts`**

The change adds a cloud-destroy branch BEFORE the existing local-removal branch and folds the cloud-destroy line into the existing confirmation prompt so the operator confirms once for both. Apply this concrete diff:

Update the imports at the top of the file:

```ts
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { confirm } from "@inquirer/prompts";
import { getAgent, removeAgent, clearCloud } from "../agent-index";
import { readPidManifest, isProcessAlive, removePidManifest } from "../pid-registry";
import { createRailwayCli } from "../deploy/railway-cli";
import type { RailwayCli } from "../deploy/railway-cli";
```

Update the `RemoveOptions` interface (currently `src/cli/commands/remove.ts:26-31`):

```ts
interface RemoveOptions {
  /** Skip the y/N prompt. */
  yes?: boolean;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Also destroy the cloud deployment if a CloudRecord exists. */
  cloud?: boolean;
  /** Railway CLI dependency injection (tests pass a mock). */
  cli?: RailwayCli;
}
```

Update the confirmation prompt (currently lines 57–68) to include the cloud line when applicable:

```ts
  if (!opts.yes) {
    const cloudLine =
      opts.cloud && entry.cloud
        ? `\n  Railway service "${entry.cloud.serviceId}" and volume "${entry.cloud.volumeId}" (volume data will be permanently lost)`
        : "";
    const ok = await confirm({
      message:
        `This will permanently delete:\n  ${entry.localDir}${cloudLine}\n\n` +
        `And remove the registry entry for "${name}".\n\nContinue?`,
      default: false,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }
```

Insert a new cloud-destroy block AFTER the confirmation block and BEFORE the existing `if (existsSync(entry.localDir)) {...}` block (the local-removal branch around line 73):

```ts
  // Cloud-destroy first (so a Railway-CLI failure doesn't leave a half-removed agent).
  if (opts.cloud && entry.cloud) {
    const cli = opts.cli ?? createRailwayCli();
    // Stage a tiny temp dir to run `railway link` from — Railway CLI requires
    // a cwd with `.railway/config.json` written by `link`. The dir is throwaway.
    const stagingDir = mkdtempSync(join(tmpdir(), `auggy-remove-${name}-`));
    try {
      await cli.link({
        projectId: entry.cloud.projectId,
        serviceName: name,
        cwd: stagingDir,
      });
      await cli.destroyService({ cwd: stagingDir });
      clearCloud(name, { auggyDir: opts.auggyDir });
      console.log(`Destroyed Railway service "${name}".`);
    } finally {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } else if (opts.cloud && !entry.cloud) {
    console.log(`No cloud deployment recorded for "${name}" — skipping cloud destroy.`);
  }
```

The existing local-removal branch (lines 73–94) stays unchanged — it deletes `entry.localDir`, cleans PID manifests, and calls `removeAgent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/remove.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Wire `--cloud` into the CLI dispatcher**

In `src/cli/index.ts`, find the `program.command("remove <name>")` block. Add `.option("--cloud", "also destroy the cloud deployment")` and pass `cloud: opts.cloud` through:

```ts
program
  .command("remove <name>")
  .description("Delete an agent (dir + index entry)")
  .option("--yes", "skip the confirmation prompt")
  .option("--cloud", "also destroy the cloud deployment")
  .action(async (name: string, opts: { yes?: boolean; cloud?: boolean }) => {
    try {
      await runRemove(name, { yes: opts.yes, cloud: opts.cloud });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 6: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/remove.ts tests/cli/remove.test.ts src/cli/index.ts
git commit -m "feat(cli): aug1 remove --cloud (destroys Railway service + volume)"
```

---

## Task 10: Operator documentation

**Files:**
- Create: `docs/18-deploy.md`

- [ ] **Step 1: Write the operator reference**

Create `docs/18-deploy.md`:

````markdown
# 18 — Deploy Reference

> Operator reference for `aug1 deploy <name> --to railway`. Source: `src/cli/commands/deploy.ts`, `src/cli/deploy/`. Architectural authority: [ADR-021](https://github.com/looselyorganized/lo/blob/main/docs/solutions/architecture/adr-021-agent-storage-and-deployment-locations.md).

## What it does

`aug1 deploy zip --to railway` deploys the locally-registered agent `zip` to Railway. The first run creates a Railway service named `zip`, attaches a persistent volume `zip-data` mounted at `/app/data`, pushes your `.env` contents as Railway env vars, generates a public URL, and writes the cloud state to `~/.auggy/agents.json`. Subsequent runs of the same command redeploy idempotently — same service, same volume, refreshed env vars + code.

## Prerequisites

- **Railway CLI installed and authenticated.** Install per https://docs.railway.com/develop/cli, then `railway login`. `aug1 deploy` shells out to your `railway` binary; no Railway tokens are stored by Auggy.
- **Agent registered locally.** `aug1 ls` should show the agent. If not, `aug1 create <name>` first.
- **`.env` populated.** Whatever vars the agent needs (`ANTHROPIC_API_KEY`, `WEB_BEARER_TOKEN`, augment-specific keys) live in `<agent-dir>/.env`. The deploy will push these to Railway.
- **A Railway project.** First deploy prompts for a project id. Find existing ones via `railway list` or create one in the Railway UI before deploying.

## Flow

1. `aug1 deploy zip --to railway`
2. CLI checks `railway --version` and `railway whoami`.
3. CLI stages a copy of the agent dir into `/tmp/auggy-deploy-zip-<rand>/` minus `.env`, `*.db*`, `workspace/`, `node_modules/`, `.git/`.
4. CLI writes `Dockerfile` + `auggy-entrypoint.sh` into the staging dir.
5. CLI shows a redacted preview of env vars about to be pushed and asks for confirmation. `--yes` skips this prompt.
6. **First deploy only:** prompts for the Railway project id. Then `railway link --project <id> --service zip` and `railway volume add zip-data --mount-path /app/data`.
7. CLI iterates `railway variables --set KEY=value` for each `.env` entry.
8. `railway up --detach` uploads code; Railway builds + starts the container.
9. `railway domain --generate` returns the public URL (idempotent — second call returns existing).
10. `railway variables --set AUGGY_PUBLIC_URL=<url>` so the agent can self-detect its address.
11. CLI writes the CloudRecord to `~/.auggy/agents.json` and prints the URL.

## What ends up where

| Component | Location |
|---|---|
| Image source | `/tmp/auggy-deploy-<name>-<rand>/` (staging dir; cleaned by OS) |
| Container code | `/app/` inside the container (Bun + globally-installed `aug1`) |
| Persistent state | `/app/data/` inside the container, mounted from Railway volume `<name>-data` |
| `memory.db` / `budgets.db` | Symlinks at `/app/memory.db` → `/app/data/memory.db`; same for `budgets.db` |
| Secrets | Railway env vars on the service. Pushed from `<agent-dir>/.env` minus `AUGGY_PUBLIC_URL` (set by deploy itself). |
| Public URL | `https://<name>-production-<random>.up.railway.app` |
| Health check | `GET /health` on the service URL — already served by `webTransport`. Configure Railway to use it via the service settings. |

## Redeploy

`aug1 deploy zip --to railway` again. Same command, idempotent. Skips volume creation; reuses existing project + service ids from `~/.auggy/agents.json`. Re-pushes secrets (any `.env` changes propagate). Re-uploads code via `railway up --detach`. Bumps `deployedAt` in the index.

If you've changed the agent.yaml augments list, the redeploy picks up the new code. If you've added new env vars to `.env`, they're pushed. If you've removed env vars from `.env`, **they are NOT removed from Railway** — you'll need to delete them via `railway variables --delete KEY` or the Railway UI. (This is deliberate: deletion is destructive; we don't want a typo in `.env` to wipe production credentials.)

## Remove

`aug1 remove zip --cloud --yes` destroys the Railway service AND its volume after confirmation. **Volume data is permanently lost.** The local agent dir + index entry are also removed (same as `aug1 remove zip` without `--cloud`).

To remove the cloud deployment but keep the local agent: there is no v1 flag for this. Use `aug1 remove zip --cloud-only` is **not** implemented; for now, destroy the Railway service via the Railway UI and `aug1 deploy` will refuse on next run because the index still points at the gone service. Manual fix: edit `~/.auggy/agents.json` and set the agent's `cloud` field to `null`. (A `--cloud-only` flag is on the deferred list per ADR-021.)

## Things to know

- **Single replica.** The `budgets` and `layeredMemory` SQLite files are not multi-process-safe. The deploy does not enforce `replicas=1` programmatically — it's the operator's responsibility not to scale the service. (Future: `redisBudgets` makes multi-replica safe; deferred.)
- **No automatic rollback.** If a deploy fails (build error, runtime crash), the previous deployment continues serving (Railway's default). Roll back via the Railway UI's deployment history.
- **No CI/CD integration.** `aug1 deploy` is operator-driven; no GitHub Action, no auto-deploy on push. Wire that yourself if needed.
- **No Auggy-side spend visibility.** Railway charges per CPU/RAM/egress. Watch your Railway dashboard separately. The runtime's `dailyBudgetUsd` only models LLM API costs.
- **Suppression list permanence (when `notify` agentmail adapter is in use).** A bounced or blocked recipient is permanently suppressed at AgentMail. Test in a sandbox account before pinning destinations in production.
- **Trust posture.** This command uploads your `.env` contents to Railway as env vars. Treat `aug1 deploy` like `git push` — it crosses a trust boundary. The confirmation prompt is the bright line; `--yes` skips it intentionally.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Railway CLI not found` | `railway` not installed or not on PATH | Install per https://docs.railway.com/develop/cli |
| `Railway CLI not authenticated` | `railway login` not completed | Run `railway login` |
| `railway link` fails: `Project not found` | Wrong project id at the prompt | Confirm via `railway list` and re-run |
| `railway link` fails: `Service already exists` | Two services with the same name in one project | Pick a different agent name OR a different Railway project. Pre-spine, names are unique per project. |
| `railway up` fails: `Build error` | Docker build failed | Check Railway's build logs in the UI; likely a Dockerfile or entrypoint issue |
| Agent boots but visitor can't reach it | `webTransport` port mismatch | Confirm `agent.yaml` has `port: 8080` (matches Dockerfile EXPOSE) |
| Memory doesn't persist across redeploys | Volume not mounted, or `dbPath` not relative | Confirm `agent.yaml` has `dbPath: ./memory.db` (NOT absolute), and the Railway volume is mounted at `/app/data` (check via `railway volume list`) |
````

- [ ] **Step 2: Commit**

```bash
git add docs/18-deploy.md
git commit -m "docs: aug1 deploy operator reference"
```

---

## Task 11: README "Deploy on Railway" template button

**Files:**
- Create: `templates/railway/README.md`
- Modify: `README.md` (project root)

The button is a Railway template URL pointing at the Auggy GitHub repo; the linked README in `templates/railway/README.md` explains the post-deploy flow (set env vars, set `AUGGY_PUBLIC_URL`, etc.). For OSS adopters who'd rather click than type.

- [ ] **Step 1: Write the template README**

Create `templates/railway/README.md`:

```markdown
# Auggy on Railway — one-click deploy

This Railway template deploys an Auggy agent runtime as a Railway service. Use it when you want to try Auggy in cloud without installing Bun + the `aug1` CLI locally first.

## What clicking the button does

1. Forks the [augment-1](https://github.com/looselyorganized/augment-1) repo to your GitHub account (you can opt out of forking).
2. Creates a Railway project containing one service backed by your fork.
3. Prompts you for required env vars: `ANTHROPIC_API_KEY` and `WEB_BEARER_TOKEN` minimum.
4. Deploys the service. On first boot, the runtime serves the example "hello-world" agent at the generated `*.up.railway.app` URL.

## After deploy

The example agent has minimal capabilities. To make it your own:

- **Locally** clone your fork, `aug1 create myagent --dir ./myagent`, customize `identity.md`, then `aug1 deploy myagent --to railway` against the same Railway project. This second path takes over for production.
- The Railway template is a starting point, not a long-term path. The CLI flow (`aug1 deploy`) is the supported way to ship updates.

## Limits

- One service per template deploy. For multi-agent setups, deploy more services via the CLI.
- The template uses Railway's default region. Switch regions via the Railway UI.
- The template does not configure custom domains — use Railway's domain UI or the `aug1 deploy` flow.

## Why both a button and a CLI?

The button is for evaluation: zero-install path to seeing Auggy run. The CLI is for ownership: full local iteration loop, your own agent dir, your own credentials. Most operators move from the button to the CLI within their first week.
```

- [ ] **Step 2: Add the button section to the project README**

Open `README.md` (at the augment-1 repo root). Find the "Deploy" or "Quickstart" section (or the top of the README if no such section exists). Add a section:

```markdown
## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/auggy-runtime)

One-click deploy of an example Auggy agent. See [`templates/railway/README.md`](./templates/railway/README.md) for what the button does and what to do after.

For the canonical deploy flow:

```bash
aug1 deploy <name> --to railway
```

See [`docs/18-deploy.md`](./docs/18-deploy.md) for the operator reference.
```

If the README already has a "Deploy" section with different framing, integrate this content there rather than duplicating. The button URL `https://railway.com/template/auggy-runtime` is a placeholder — the actual template URL is generated by Railway when the operator publishes a template from the augment-1 repo via the Railway UI's "Create Template" flow. Update the placeholder once the template is published.

- [ ] **Step 3: Commit**

```bash
git add templates/railway/README.md README.md
git commit -m "docs: deploy-on-railway template button + README"
```

---

## Task 12: Partial-failure recovery — `cloud.state` discriminator + per-agent deploy lock

**Files:**
- Modify: `src/cli/types.ts` — extend `CloudRecord` with `state: "pending" | "active"`.
- Modify: `src/cli/agent-index.ts` — `setCloud` accepts the state field; no signature break (existing callers pass `state: "active"`).
- Modify: `src/cli/commands/deploy.ts` — write `state: "pending"` before any irreversible Railway operation; flip to `state: "active"` only after the final `setCloud` succeeds; on `aug1 deploy` re-entry, detect `pending` and resume from a checkpoint instead of treating as a fresh first-deploy.
- Create: `src/cli/deploy/deploy-lock.ts` — per-agent advisory lock file at `<localDir>/.deploy.lock`. Acquired for the duration of `runDeploy`. Refuses concurrent deploys with a clear "another deploy is in progress (pid <n>, since <ts>); wait or remove the lock if stale" message.
- Modify: `tests/cli/deploy.test.ts` — 4 new tests.

**Why this exists separately from Task 6:** Codex review (2026-05-06) flagged that Task 6's happy-path flow — `link → addVolume → setVariable* → up → generateDomain → setCloud` — leaves Railway in a half-initialized state if any step before `setCloud` fails. The next `aug1 deploy` thinks `cloud === null` and tries `link` again (likely fails because the service exists). Operator stuck.

**The fix:** persist a `state: "pending"` CloudRecord BEFORE the irreversible operations, capture whatever subset of `{projectId, serviceId, volumeId, url}` is known at each checkpoint, and on re-entry check `state === "pending"` to resume from the right step. `state: "active"` is only written when the deploy succeeds end-to-end.

- [ ] **Step 1: Update `CloudRecord` type**

In `src/cli/types.ts`, change `CloudRecord` from:

```ts
export type CloudRecord = null | {
  provider: "railway";
  projectId: string;
  serviceId: string;
  url: string;
  volumeId: string;
  deployedAt: string;
};
```

to:

```ts
export type CloudRecord = null | {
  provider: "railway";
  /** "pending" while a deploy is in flight; "active" after the deploy completed end-to-end. Re-entry on "pending" triggers resume-from-checkpoint logic. */
  state: "pending" | "active";
  projectId: string;
  /** Set as soon as `railway link` succeeds. */
  serviceId?: string;
  /** Set as soon as `railway domain --generate` returns. */
  url?: string;
  /** Set as soon as `railway volume add` succeeds. */
  volumeId?: string;
  /** ISO 8601, set on every state transition (pending or active). */
  updatedAt: string;
  /** ISO 8601, set only on transition to "active". */
  deployedAt?: string;
};
```

This is a structural change — `serviceId`, `url`, `volumeId`, `deployedAt` become optional during the `pending` window. All existing readers must handle the optional case.

- [ ] **Step 2: Update Task 1 tests for the new shape**

The Task 1 tests assume the legacy shape. Update them to set `state: "active"` and `updatedAt` on every `setCloud` call. Existing assertions against `cloud.url`, `cloud.serviceId`, etc. continue to work because those fields are still present in `active` records.

- [ ] **Step 3: Implement per-agent deploy lock**

Create `src/cli/deploy/deploy-lock.ts`:

```ts
/**
 * Per-agent deploy advisory lock. Mirrors the agent-index lock pattern
 * (atomic create via openSync(wx); time-based stale recovery).
 *
 * Lock file: <localDir>/.deploy.lock
 * Held for the full runDeploy duration to prevent concurrent deploys
 * from racing the index, the bundle staging, or Railway operations.
 */

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const LOCK_TIMEOUT_MS = 30_000; // generous: deploy itself takes minutes

export interface DeployLockHandle {
  release(): void;
}

export function acquireDeployLock(agentDir: string, opts: { force?: boolean } = {}): DeployLockHandle {
  const path = join(agentDir, ".deploy.lock");
  const body = JSON.stringify({ pid: process.pid, acquired: new Date().toISOString() });

  if (opts.force) {
    try { unlinkSync(path); } catch {}
  }

  try {
    const fd = openSync(path, "wx");
    writeSync(fd, body);
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Read who's holding it for the operator's error message.
      let holder = "(unknown)";
      try {
        const content = require("node:fs").readFileSync(path, "utf-8");
        const parsed = JSON.parse(content);
        holder = `pid ${parsed.pid}, since ${parsed.acquired}`;
      } catch {}
      throw new Error(
        `Another deploy is in progress for this agent (${holder}). ` +
          `Wait for it to finish, or run \`aug1 deploy <name> --force\` if you're certain it crashed.`,
      );
    }
    throw err;
  }

  return {
    release: () => {
      try { unlinkSync(path); } catch {}
    },
  };
}
```

Add `--force` flag to `aug1 deploy` for the recovery case. Tests cover: lock acquired, second-call rejected, force-acquires after stale.

- [ ] **Step 4: Update `runDeploy` to write `state: "pending"` checkpoints**

In `src/cli/commands/deploy.ts`, the order of operations during first-deploy becomes:

1. Acquire deploy lock.
2. Read existing CloudRecord. If `state === "pending"`, log "resuming previous deploy from <updatedAt>" and skip operations whose checkpoint marker is already set (e.g. if `serviceId` is present, skip `link`; if `volumeId` is present, skip `addVolume`).
3. After `link`: write `state: "pending"` CloudRecord with `projectId`, `serviceId`. Updates `updatedAt`.
4. After `addVolume`: update CloudRecord with `volumeId`. Still `state: "pending"`.
5. Push secrets (idempotent against partial — `setVariable` overwrites).
6. `up`. (No state change; build/start failures surface in Railway logs but don't corrupt our state.)
7. After `generateDomain`: update CloudRecord with `url`. Still `state: "pending"`.
8. After `AUGGY_PUBLIC_URL` setVariable + `status` fetch: flip to `state: "active"`, set `deployedAt`. Final state.
9. Release lock.

Each setCloud call passes the full record with `state: "pending"` until the very last one. The lock release is in `finally` so a crash mid-deploy still cleans up.

- [ ] **Step 5: Add resume-from-checkpoint tests**

Append to `tests/cli/deploy.test.ts`:

```ts
  test("resume: detects pending state and skips link if serviceId is set", async () => {
    const dir = setupAgent("zip");
    setCloud("zip", {
      provider: "railway",
      state: "pending",
      projectId: "proj_abc",
      serviceId: "svc_def",
      updatedAt: "2026-05-06T00:00:00.000Z",
    } as any, { auggyDir });
    const { cli, calls } = mockRailwayCli();
    await runDeploy("zip", { to: "railway", yes: true, auggyDir, cli, /* ... */ });
    expect(calls.link).toEqual([]); // skipped — serviceId present
    expect(calls.up).toBe(1); // re-pushed
  });

  test("resume: skips addVolume if volumeId is set", async () => { /* analogous */ });

  test("deploy lock: second concurrent deploy throws", async () => { /* spawn two runDeploy promises against same agent; assert second rejects */ });

  test("deploy lock: --force overrides a stale lock", async () => { /* ... */ });
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/cli/deploy.test.ts tests/cli/agent-index.test.ts`
Expected: PASS.

Run: `bunx tsc --noEmit`
Expected: PASS — but expect type errors at every site that reads `cloud.serviceId`, `cloud.url`, etc., because they're now optional. Fix each by either (a) handling the optional case (preferred) or (b) `state === "active" ?` narrowing. The `runRemove --cloud` path needs explicit handling: refuse to destroy a `pending` record (it may not have a `serviceId` to destroy) and force the operator to either complete the deploy (`aug1 deploy`) or manually clear the index (`aug1 remove`).

- [ ] **Step 7: Update `aug1 remove --cloud` to handle `pending` state**

In `src/cli/commands/remove.ts`, the cloud-destroy branch checks `entry.cloud?.state`:

- `state === "active"`: destroy as before.
- `state === "pending"` with `serviceId` set: best-effort destroy via `cli.destroyService`, then `clearCloud`. Log a warning.
- `state === "pending"` without `serviceId`: nothing to destroy on Railway; just `clearCloud`.

Add one test for each of the three branches.

- [ ] **Step 8: Commit**

```bash
git add src/cli/types.ts src/cli/agent-index.ts src/cli/deploy/deploy-lock.ts src/cli/commands/deploy.ts src/cli/commands/remove.ts tests/cli/deploy.test.ts tests/cli/agent-index.test.ts tests/cli/remove.test.ts
git commit -m "feat(cli): partial-failure recovery for aug1 deploy (cloud.state + per-agent lock)"
```

---

## Task 13: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS. Test count delta: +4 (agent-index) + 12 (railway-cli) + 4 (bundle) + 7 (secrets) + 10 (dockerfile) + 5 (deploy first) + 2 (deploy redeploy) + 2 (remove --cloud) + 4 (Task 12 recovery + lock) + 3 (Task 12 remove pending-state cases) = **+53 tests**. Baseline before this plan should be `1105 augment-1 tests` (after the AgentMail notify-adapter plan ships with its 14 new tests); expect `1158 augment-1 tests` after this plan.

If the AgentMail plan has not yet shipped, the baseline is `1091` and the post-plan count is `1144`.

- [ ] **Step 3: Smoke-test the CLI help**

Run: `bun src/cli/index.ts deploy --help`
Expected: prints the deploy command's flags including `--to <provider>` (default: railway) and `--yes`.

- [ ] **Step 4: Confirm git status is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 5: (Optional) Real Railway smoke test**

If the engineer has a Railway account with `railway login` already completed, do a real first-deploy + redeploy + remove cycle on a throwaway agent. Document any rough edges that need a follow-up patch. Skip if no Railway account is available — the unit tests cover the logic; this is a sanity check on the actual `railway` CLI behavior.

---

## Acceptance criteria

- [ ] `bun test` passes with the full new suite (~53 new tests).
- [ ] `bunx tsc --noEmit` passes clean.
- [ ] `aug1 deploy <name> --to railway` first-run creates Railway service + volume + secrets + URL, writes CloudRecord to index.
- [ ] `aug1 deploy <name> --to railway` second-run is idempotent: same service, same volume, refreshed secrets + code, bumped `deployedAt`.
- [ ] `aug1 deploy <name> --to fly` (or any non-railway target) errors clearly: "Only railway is supported at v1."
- [ ] `aug1 remove <name> --cloud` destroys Railway service + volume after confirmation; `--yes` skips confirmation.
- [ ] Operator-confirmation prompt previews redacted env vars before push; declining aborts cleanly with no Railway-side state changes and no index update.
- [ ] `~/.auggy/agents.json` cloud field correctly populated/cleared per state transitions.
- [ ] `docs/18-deploy.md` documents the full operator flow + troubleshooting.
- [ ] Project README has a "Deploy on Railway" section with template button placeholder.
- [ ] **Partial-failure recoverability** (per Codex review 2026-05-06): `cloud.state` discriminator (`pending | active`) is set; mid-deploy crash + re-run resumes from the right checkpoint instead of treating as fresh first-deploy.
- [ ] **Per-agent deploy lock** (per Codex review 2026-05-06): concurrent `aug1 deploy` from two terminals against the same agent is rejected with a clear message naming the holder; `--force` flag available for stale-lock recovery.
- [ ] **`aug1 remove --cloud` handles `pending` state** without throwing: best-effort destroy when `serviceId` is known, clean index clear when not.

---

## What this plan deliberately does NOT do

- **No `aug1 redeploy <name>` alias.** Re-running `aug1 deploy <name>` IS the redeploy. Adding an alias is sugar.
- **No `aug1 stop <name> --cloud`.** Pause via Railway UI; CLI flag deferred.
- **No `aug1 logs <name> --cloud`.** Operator runs `railway logs` directly; CLI bridge deferred.
- **No multi-provider plugin abstraction.** Railway-specific code in `src/cli/deploy/`. When `--to fly` or `--to render` arrives, refactor against the existing module — that refactor is much cleaner with two concrete impls than with one abstract one.
- **No CI/CD integration.** `aug1 deploy` is operator-driven. GitHub Actions or similar are out of scope.
- **No automatic Railway project creation.** First deploy prompts for an existing project id. Project creation is operator-side via the Railway UI.
- **No env-var deletion.** Removing a key from `.env` does NOT remove it from Railway. Operator handles via `railway variables --delete` or the Railway UI. Deliberate — destruction is opt-in.
- **No multi-region or custom-domain wiring.** Railway's default region; Railway's auto-generated `*.up.railway.app` domain. Custom domains are an operator-side concern.
- **No `aug1 chat` cloud-source adapter.** Deferred per ADR-021 line 224.
- **No automatic adoption of pre-existing Railway services.** If the operator has a Railway service for an agent that was created outside `aug1 deploy`, it doesn't get adopted; they must `aug1 remove --cloud` (which fails because there's no CloudRecord) and re-deploy fresh. Adoption is deferred per ADR-021.
