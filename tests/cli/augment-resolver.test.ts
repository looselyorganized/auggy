import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveAugments } from "../../src/cli/augment-resolver";
import type { AugmentConfig } from "../../src/cli/types";

const TMP = join(import.meta.dir, ".tmp-resolver-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fileMemory
// ---------------------------------------------------------------------------

describe("resolveAugments — fileMemory", () => {
  test("resolves a fileMemory augment with relative source path", async () => {
    writeFileSync(join(TMP, "identity.md"), "# Identity");

    const configs: AugmentConfig[] = [
      {
        name: "identity",
        type: "fileMemory",
        options: {
          label: "self",
          source: "./identity.md",
          mutable: false,
          origin: "operator",
          priority: "required",
          placement: "system",
          eviction: "never",
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("identity");
    expect(augments[0]!.memory).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// filesystem
// ---------------------------------------------------------------------------

describe("resolveAugments — filesystem", () => {
  test("resolves a filesystem augment with mounts", async () => {
    mkdirSync(join(TMP, "skills"), { recursive: true });
    mkdirSync(join(TMP, "workspace"), { recursive: true });

    const configs: AugmentConfig[] = [
      {
        name: "files",
        type: "filesystem",
        options: {
          mounts: [
            { name: "skills", path: "./skills", writable: false },
            { name: "workspace", path: "./workspace", writable: true },
          ],
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("files");
    expect(augments[0]!.tools).toBeDefined();
    expect(augments[0]!.tools!.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// webTransport
// ---------------------------------------------------------------------------

describe("resolveAugments — webTransport", () => {
  test("resolves a webTransport augment", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port: 9999,
          auth: { type: "bearer", token: "test-token" },
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("web");
    expect(augments[0]!.transport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// webFetch
// ---------------------------------------------------------------------------

describe("resolveAugments — webFetch", () => {
  test("resolves a webFetch augment with options", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "fetch",
        type: "webFetch",
        options: { timeoutMs: 10000 },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("fetch");
    expect(augments[0]!.tools).toBeDefined();
    expect(augments[0]!.tools![0]!.name).toBe("web_fetch");
  });
});

// ---------------------------------------------------------------------------
// custom
// ---------------------------------------------------------------------------

describe("resolveAugments — custom", () => {
  test("loads a custom augment from a local .ts file", async () => {
    const customPath = join(TMP, "custom-augment.ts");
    writeFileSync(
      customPath,
      `export default function(opts) {
        return {
          name: "from-factory",
          capabilities: ["tools"],
          tools: [],
        };
      }`,
    );

    const configs: AugmentConfig[] = [
      {
        name: "my-custom",
        type: "custom",
        source: "./custom-augment.ts",
        options: { foo: "bar" },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    // Name should be overridden to the config name.
    expect(augments[0]!.name).toBe("my-custom");
  });

  test("throws for missing source file", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "bad",
        type: "custom",
        source: "./nonexistent.ts",
      },
    ];

    expect(resolveAugments(configs, TMP)).rejects.toThrow("failed to import");
  });

  test("throws when default export is not a function", async () => {
    const customPath = join(TMP, "not-a-function.ts");
    writeFileSync(customPath, `export default { name: "oops" };`);

    const configs: AugmentConfig[] = [
      {
        name: "bad",
        type: "custom",
        source: "./not-a-function.ts",
      },
    ];

    expect(resolveAugments(configs, TMP)).rejects.toThrow(
      "must have a default export that is a function",
    );
  });
});

// ---------------------------------------------------------------------------
// Name override
// ---------------------------------------------------------------------------

describe("resolveAugments — name override", () => {
  test("overrides auto-generated augment name with config name", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "my-custom-fetch-name",
        type: "webFetch",
        options: {},
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    // webFetch normally produces name "web-fetch"; config overrides it.
    expect(augments[0]!.name).toBe("my-custom-fetch-name");
  });
});

// ---------------------------------------------------------------------------
// Multiple augments
// ---------------------------------------------------------------------------

describe("resolveAugments — multiple", () => {
  test("resolves multiple augments in order", async () => {
    writeFileSync(join(TMP, "identity.md"), "# ID");
    mkdirSync(join(TMP, "workspace"), { recursive: true });

    const configs: AugmentConfig[] = [
      {
        name: "identity",
        type: "fileMemory",
        options: {
          label: "self",
          source: "./identity.md",
          mutable: false,
          origin: "operator",
          priority: "required",
          placement: "system",
          eviction: "never",
        },
      },
      {
        name: "fetch",
        type: "webFetch",
        options: {},
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(2);
    expect(augments[0]!.name).toBe("identity");
    expect(augments[1]!.name).toBe("fetch");
  });
});

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

describe("resolveAugments — budgets", () => {
  test("resolves a budgets augment with dbPath resolved against agentDir", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: {
          dbPath: "./budgets.db",
          caps: {
            public: {
              recognized: { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1 },
              anonymous: { maxTurnsPerThread: 5 },
            },
          },
          anonymousGlobalLimit: 30,
          dailyBudgetUsd: 5,
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("budgets");
    expect(augments[0]!.turnGate).toBeDefined();
    // Budgets is not a memory provider.
    expect(augments[0]!.memory).toBeUndefined();
    // Capabilities include lifecycle (for onShutdown) and context.
    expect(augments[0]!.capabilities).toContain("lifecycle");
    expect(augments[0]!.capabilities).toContain("context");
  });

  test("resolves budgets augment with default dbPath when omitted from options", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: {},
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("budgets");
    expect(augments[0]!.turnGate).toBeDefined();
  });

  test("closes the store on shutdown without error", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: { dbPath: "./budgets-shutdown-test.db" },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments[0]!.onShutdown).toBeDefined();
    // Should resolve cleanly without throwing.
    await expect(augments[0]!.onShutdown!()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// visitorAuth
// ---------------------------------------------------------------------------

describe("resolveAugments — visitorAuth", () => {
  test("resolves visitorAuth augment with absolute paths", async () => {
    const augments = await resolveAugments(
      [
        {
          type: "visitorAuth",
          name: "visitor-auth",
          options: {
            publicUrl: "https://zip.test",
            dbPath: "./va.db",
            agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
            signingKey: "sig-x",
            layeredMemoryDbPath: "./mem.db",
          },
        },
      ],
      TMP,
    );
    expect(augments).toHaveLength(1);
    expect(augments[0]?.name).toBe("visitor-auth");
    expect(augments[0]?.httpRoutes?.[0]?.path).toBe("/visitor-auth/verify");
  });

  test("resolveVisitorAuth honors layeredMemoryDbPath: null to disable migration", async () => {
    const augments = await resolveAugments(
      [
        {
          type: "visitorAuth",
          name: "visitor-auth",
          options: {
            publicUrl: "https://zip.test",
            agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
            signingKey: "sig-x",
            layeredMemoryDbPath: null,
          },
        },
      ],
      TMP,
    );
    expect(augments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-augment validation (fix H3): visitorAuth.agentBinding vs
// webTransport.visitorTokens.agentBinding must match
// ---------------------------------------------------------------------------

describe("resolveAugments — cross-augment agentBinding validation (fix H3)", () => {
  function vaConfig(agentBinding: string | undefined): AugmentConfig {
    return {
      type: "visitorAuth",
      name: "visitor-auth",
      options: {
        publicUrl: "https://zip.test",
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig-x",
        ...(agentBinding !== undefined ? { agentBinding } : {}),
      },
    };
  }

  function wtConfig(agentBinding: string | undefined): AugmentConfig {
    return {
      type: "webTransport",
      name: "web",
      options: {
        port: 9123,
        auth: { type: "bearer", token: "tok" },
        visitorTokens: {
          signingKey: "sig-x",
          ...(agentBinding !== undefined ? { agentBinding } : {}),
        },
      },
    };
  }

  test("throws when visitorAuth.agentBinding differs from webTransport.visitorTokens.agentBinding", async () => {
    await expect(resolveAugments([vaConfig("agent-A"), wtConfig("agent-B")], TMP)).rejects.toThrow(
      /agentBinding/,
    );
  });

  test("succeeds when both agentBindings are the same value", async () => {
    const augments = await resolveAugments([vaConfig("same-id"), wtConfig("same-id")], TMP);
    expect(augments).toHaveLength(2);
  });

  test("throws when visitorAuth has agentBinding but webTransport does not", async () => {
    await expect(resolveAugments([vaConfig("agent-A"), wtConfig(undefined)], TMP)).rejects.toThrow(
      /agentBinding/,
    );
  });

  test("does not throw when neither augment is present", async () => {
    // Solo webFetch — no visitorAuth, no webTransport: no validation needed.
    const augments = await resolveAugments([{ type: "webFetch", name: "fetch", options: {} }], TMP);
    expect(augments).toHaveLength(1);
  });

  test("does not throw when only one of visitorAuth/webTransport is present", async () => {
    // visitorAuth alone (no webTransport): no mismatch possible.
    const augments = await resolveAugments([vaConfig("agent-A")], TMP);
    expect(augments).toHaveLength(1);
  });
});
