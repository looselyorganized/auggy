import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { runAgentMailSetup, type AgentMailCommandDeps } from "../../src/cli/commands/agentmail";
import { acquireProjectMutationLease } from "../../src/cli/authoring/publication";
import { acquireAgentEnvMutationLock } from "../../src/cli/env-mutation-lock";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import {
  VISITOR_AUTH_LOCAL_RATE_LIMIT_DEFAULT,
  VISITOR_AUTH_AGENTMAIL_RATE_LIMIT_DEFAULT,
} from "../../src/cli/augment-catalog";

// Compile the actual packed command gate without executing its CLI entrypoint in unit tests.
export type PackedAgentMailSmoke = typeof import("../../scripts/release-smoke-agentmail-cli");

const ID = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";
const KEY = "am_verified_private_fixture";
const OLD_ENV = "# owned env\nUNRELATED=private_preimage_fixture\n";
const CREDENTIAL_KEYS = [
  "AGENTMAIL_API_KEY",
  "AGENTMAIL_INBOX_ID",
  "AGENTMAIL_INBOX_EMAIL",
  "AGENTMAIL_ACCOUNT_API_KEY",
];
let roots: string[] = [];
let priorEnv: Record<string, string | undefined>;

beforeEach(() => {
  priorEnv = Object.fromEntries(CREDENTIAL_KEYS.map((key) => [key, process.env[key]]));
  for (const key of CREDENTIAL_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(augments: unknown[] = [{ name: "agentMail", type: "agentMail", options: {} }]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auggy-agentmail-authoring-")));
  roots.push(root);
  const config = join(root, "agent.yaml");
  const env = join(root, ".env");
  writeFileSync(
    config,
    "# owned declaration\n" +
      stringify({
        id: ID,
        name: "mail-agent",
        engine: { provider: "anthropic", model: "fixture" },
        augments,
      }),
  );
  writeFileSync(env, OLD_ENV, { mode: 0o600 });
  const before = readFileSync(config, "utf8");
  return { root, config, env, before };
}
function verification() {
  return {
    emailAddress: "owned@agentmail.to",
    verifiedPermissions: ["inbox_read", "message_read", "draft_read"],
  };
}
function setup(project: ReturnType<typeof fixture>, deps: AgentMailCommandDeps = {}) {
  return runAgentMailSetup(
    "agentMail",
    { config: project.config, mode: "manual", apiKey: KEY, inboxId: "owned@agentmail.to" },
    {
      cwd: project.root,
      interactive: false,
      verifyRuntimeAccess: async () => verification(),
      ...deps,
    },
  );
}
function receiptBytes(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) =>
      entry.isDirectory()
        ? receiptBytes(join(directory, entry.name))
        : readFileSync(join(directory, entry.name), "utf8"),
    )
    .join("\n");
}

describe("inline AgentMail authoring and credential preservation", () => {
  test("updates only the canonical options while keeping comments, identity and unrelated declarations", async () => {
    const unrelated = {
      name: "custom",
      type: "custom",
      source: "./owned.ts",
      options: { flag: false, count: 0, empty: null, nested: ["${UNEXPANDED}", "keep"] },
    };
    const project = fixture([
      { type: "agentMail", options: { addressVisibility: "public" } },
      unrelated,
    ]);
    await setup(project);
    const text = readFileSync(project.config, "utf8");
    const doc = parse(text);
    expect(text).toContain("# owned declaration");
    expect(doc.id).toBe(ID);
    expect(doc.augments[1]).toEqual(unrelated);
    expect(doc.augments[0].options).toMatchObject({
      apiKey: "${AGENTMAIL_API_KEY}",
      inboxId: "${AGENTMAIL_INBOX_ID}",
      emailAddress: "${AGENTMAIL_INBOX_EMAIL}",
      addressVisibility: "public",
    });
    expect(readFileSync(project.env, "utf8")).toContain(KEY);
    expect(statSync(project.env).mode & 0o777).toBe(0o600);
    expect(existsSync(join(project.root, "augments"))).toBe(false);
    const privateFiles = receiptBytes(join(project.root, ".auggy", "operations"));
    expect(privateFiles).not.toContain(KEY);
    expect(privateFiles).not.toContain("private_preimage_fixture");
  });

  for (const mixed of [false, true])
    test(`refuses ${mixed ? "mixed" : "legacy"} declarations before credential reads, locks or provider calls`, async () => {
      const project = fixture(mixed ? ["agentMail", { type: "skills" }] : ["agentMail"]);
      mkdirSync(join(project.root, "augments", "agentMail"), { recursive: true });
      writeFileSync(
        join(project.root, "augments", "agentMail", "augment.yaml"),
        "type: agentMail\nconfig: {}\n",
      );
      rmSync(project.env);
      expect(spawnSync("mkfifo", [project.env]).status).toBe(0);
      const verifyRuntimeAccess = mock(async () => verification());
      await expect(setup(project, { verifyRuntimeAccess })).rejects.toThrow("auggy migrate");
      expect(verifyRuntimeAccess).not.toHaveBeenCalled();
      expect(existsSync(join(project.root, ".auggy"))).toBe(false);
      expect(statSync(project.env).isFIFO()).toBe(true);
      expect(readFileSync(project.config, "utf8")).toBe(project.before);
    });

  for (const augments of [
    [{ name: "renamed", type: "agentMail" }],
    [
      { name: "agentMail", type: "agentMail" },
      { name: "second", type: "agentMail" },
    ],
    [
      { name: "agentMail", type: "agentMail" },
      { name: "visitor", type: "visitorAuth" },
    ],
  ])
    test(`refuses ambiguous shared credential consumers: ${augments.map((entry) => entry.name).join(",")}`, async () => {
      const project = fixture(augments);
      const verifyRuntimeAccess = mock(async () => verification());
      await expect(setup(project, { verifyRuntimeAccess })).rejects.toThrow(/custom|multiple/);
      expect(verifyRuntimeAccess).not.toHaveBeenCalled();
      expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
      expect(readFileSync(project.config, "utf8")).toBe(project.before);
    });

  test("keeps canonical shared-inbox ordering and upgrades only the default console rate limit", async () => {
    const project = fixture([
      { type: "agentMail" },
      {
        type: "visitorAuth",
        options: {
          agentMail: { transport: "console" },
          rateLimit: VISITOR_AUTH_LOCAL_RATE_LIMIT_DEFAULT,
          custom: "preserved",
        },
      },
    ]);
    await expect(
      runAgentMailSetup(
        "visitorAuth",
        { config: project.config, mode: "manual", apiKey: KEY, inboxId: "owned@agentmail.to" },
        { cwd: project.root, interactive: false },
      ),
    ).rejects.toThrow("Configure agentMail first");
    await setup(project);
    const env = readFileSync(project.env, "utf8");
    const beforeVisitor = parse(readFileSync(project.config, "utf8")).augments[0];
    const verifyRuntimeAccess = mock(async (_input, permissions) => {
      expect(permissions).toEqual({ messageRead: false, draftRead: false });
      return verification();
    });
    await runAgentMailSetup(
      "visitorAuth",
      { config: project.config, mode: "env" },
      { cwd: project.root, interactive: false, verifyRuntimeAccess },
    );
    const doc = parse(readFileSync(project.config, "utf8"));
    expect(doc.augments[0]).toEqual(beforeVisitor);
    expect(doc.augments[1].options).toMatchObject({
      agentMail: {
        transport: "agentmail",
        apiKey: "${AGENTMAIL_API_KEY}",
        inboxId: "${AGENTMAIL_INBOX_ID}",
      },
      rateLimit: VISITOR_AUTH_AGENTMAIL_RATE_LIMIT_DEFAULT,
      custom: "preserved",
    });
    expect(readFileSync(project.env, "utf8")).toBe(env);
    await expect(setup(project)).rejects.toThrow("already uses the shared AgentMail");
  });

  test("holds both leases through verification and releases them on failure", async () => {
    const project = fixture();
    await expect(
      setup(project, {
        verifyRuntimeAccess: async () => {
          expect(() => acquireProjectMutationLease(project.root)).toThrow();
          expect(() => acquireAgentEnvMutationLock(project.root)).toThrow(
            "another Auggy operation",
          );
          throw new Error(KEY);
        },
      }),
    ).rejects.toThrow("Could not verify");
    const lease = acquireProjectMutationLease(project.root);
    const envLease = acquireAgentEnvMutationLock(project.root);
    envLease.release();
    lease.release();
    expect(readFileSync(project.config, "utf8")).toBe(project.before);
    expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
  });

  for (const target of ["config", "env", "ignore"] as const)
    test(`preserves a concurrent ${target} edit observed after provider verification`, async () => {
      const project = fixture();
      const path =
        target === "config"
          ? project.config
          : target === "env"
            ? project.env
            : join(project.root, ".gitignore");
      const changed = target === "config" ? `${project.before}# concurrent\n` : "# concurrent\n";
      await expect(
        setup(project, {
          verifyRuntimeAccess: async () => {
            writeFileSync(path, changed);
            return verification();
          },
        }),
      ).rejects.toThrow("changed while AgentMail setup was running");
      expect(readFileSync(path, "utf8")).toBe(changed);
      if (target !== "config") expect(readFileSync(project.config, "utf8")).toBe(project.before);
      if (target !== "env") expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
    });

  for (const kind of ["fifo", "symlink", "utf8", "oversize"] as const)
    test(`rejects ${kind} credential input before network access`, async () => {
      const project = fixture();
      if (kind === "fifo" || kind === "symlink") rmSync(project.env);
      if (kind === "fifo") expect(spawnSync("mkfifo", [project.env]).status).toBe(0);
      if (kind === "symlink") symlinkSync(project.config, project.env);
      if (kind === "utf8") writeFileSync(project.env, new Uint8Array([0xff]));
      if (kind === "oversize")
        writeFileSync(project.env, "#".repeat(AUTHORING_LIMITS.documentBytes + 1));
      const verifyRuntimeAccess = mock(async () => verification());
      await expect(setup(project, { verifyRuntimeAccess })).rejects.toThrow();
      expect(verifyRuntimeAccess).not.toHaveBeenCalled();
      expect(readFileSync(project.config, "utf8")).toBe(project.before);
    });

  test("bounds additional dotenv discovery without leaking raw values", async () => {
    const project = fixture();
    const path = join(project.root, ".env.local");
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    const verifyRuntimeAccess = mock(async () => verification());
    await expect(setup(project, { verifyRuntimeAccess })).rejects.toThrow("regular file");
    expect(verifyRuntimeAccess).not.toHaveBeenCalled();
    expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
  });

  test("bounds named configuration selection before any credential or provider action", async () => {
    const project = fixture();
    rmSync(project.config);
    expect(spawnSync("mkfifo", [project.config]).status).toBe(0);
    const verifyRuntimeAccess = mock(async () => verification());
    await expect(
      runAgentMailSetup(
        "agentMail",
        { agent: "mail-agent", mode: "env" },
        { cwd: project.root, verifyRuntimeAccess },
      ),
    ).rejects.toThrow("regular file");
    expect(verifyRuntimeAccess).not.toHaveBeenCalled();
    expect(existsSync(join(project.root, ".auggy"))).toBe(false);
  });

  test("refuses production plaintext transport before sending runtime credentials", async () => {
    const project = fixture();
    const priorFetch = globalThis.fetch;
    const priorNodeEnv = process.env.NODE_ENV;
    const fetchTrap = mock(async () => new Response(null, { status: 403 }));
    globalThis.fetch = fetchTrap as unknown as typeof fetch;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        runAgentMailSetup(
          "agentMail",
          {
            config: project.config,
            mode: "manual",
            apiKey: KEY,
            inboxId: "owned@agentmail.to",
            baseUrl: "http://provider.example/v0",
            allowInsecureHttpWithCredentials: true,
          },
          { cwd: project.root, interactive: false },
        ),
      ).rejects.toThrow("Could not verify");
      expect(fetchTrap).not.toHaveBeenCalled();
      expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
      expect(readFileSync(project.config, "utf8")).toBe(project.before);
    } finally {
      globalThis.fetch = priorFetch;
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test("compensates credentials on a thrown publication preflight failure", async () => {
    const project = fixture();
    await expect(
      setup(project, {
        verifyRuntimeAccess: async () => {
          const operation = join(
            project.root,
            ".auggy",
            "operations",
            "00000000-0000-4000-8000-000000000000",
          );
          mkdirSync(operation, { recursive: true, mode: 0o700 });
          writeFileSync(
            join(operation, "receipt.json"),
            '{"malformed":"private-receipt-sentinel"}',
            { mode: 0o600 },
          );
          return verification();
        },
      }),
    ).rejects.toThrow("failed before activation. Previous credentials were restored");
    expect(readFileSync(project.config, "utf8")).toBe(project.before);
    expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
  });

  for (const boundary of ["before-file", "after-activation", "before-sensitive-cleanup"] as const)
    test(`restores prior credentials only after original activation is verified: ${boundary}`, async () => {
      const project = fixture();
      await expect(
        setup(project, {
          publicationFault(event) {
            if (
              (boundary === "before-file" &&
                event.boundary === boundary &&
                event.path === "agent.yaml") ||
              (boundary === "after-activation" && event.boundary === boundary) ||
              (boundary === "before-sensitive-cleanup" &&
                ["after-activation", "before-sensitive-cleanup"].includes(event.boundary))
            )
              throw new Error("fixture interruption");
          },
        }),
      ).rejects.toThrow("Previous credentials were restored");
      expect(readFileSync(project.config, "utf8")).toBe(project.before);
      expect(readFileSync(project.env, "utf8")).toBe(OLD_ENV);
    });

  test("removes a newly created credential file only after verified rollback", async () => {
    const project = fixture();
    rmSync(project.env);
    await expect(
      setup(project, {
        publicationFault(event) {
          if (event.boundary === "after-activation") throw new Error("fixture interruption");
        },
      }),
    ).rejects.toThrow("Previous credentials were restored");
    expect(existsSync(project.env)).toBe(false);
    expect(readFileSync(project.config, "utf8")).toBe(project.before);
  });

  test("retains verified credentials when activation remains output after failed rollback", async () => {
    const project = fixture();
    await expect(
      setup(project, {
        publicationFault(event) {
          if (["after-activation", "before-rollback-file"].includes(event.boundary))
            throw new Error("fixture interruption");
        },
      }),
    ).rejects.toThrow("Configuration is output. Credentials were retained");
    expect(readFileSync(project.env, "utf8")).toContain(KEY);
    expect(parse(readFileSync(project.config, "utf8")).augments[0].options.apiKey).toBe(
      "${AGENTMAIL_API_KEY}",
    );
  });

  test("retains credentials and an operator edit when activation becomes unknown", async () => {
    const project = fixture();
    const edited = "# operator changed config during activation\n";
    await expect(
      setup(project, {
        publicationFault(event) {
          if (event.boundary === "after-activation") {
            writeFileSync(project.config, edited);
            throw new Error("fixture interruption");
          }
        },
      }),
    ).rejects.toThrow("Configuration is unknown. Credentials were retained");
    expect(readFileSync(project.env, "utf8")).toContain(KEY);
    expect(readFileSync(project.config, "utf8")).toBe(edited);
  });

  test("never restores over a newer credential postimage after configuration rollback", async () => {
    const project = fixture();
    await expect(
      setup(project, {
        publicationFault(event) {
          if (event.boundary === "after-activation") {
            writeFileSync(project.env, "OPERATOR=keep\n");
            throw new Error("fixture interruption");
          }
        },
      }),
    ).rejects.toThrow("Credentials were retained");
    expect(readFileSync(project.env, "utf8")).toBe("OPERATOR=keep\n");
    expect(readFileSync(project.config, "utf8")).toBe(project.before);
  });

  test("does not report success after a concurrent credential edit during completed publication", async () => {
    const project = fixture();
    await expect(
      setup(project, {
        publicationFault(event) {
          if (event.boundary === "after-activation") writeFileSync(project.env, "OPERATOR=keep\n");
        },
      }),
    ).rejects.toThrow(".env changed before completion");
    expect(readFileSync(project.env, "utf8")).toBe("OPERATOR=keep\n");
    expect(readFileSync(project.config, "utf8")).not.toBe(project.before);
  });
});
