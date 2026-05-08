import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
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
// C1 wiring: visitorAuth revocation check survives operator rename (fix F17)
// ---------------------------------------------------------------------------

describe("resolveAugments — C1 wiring (fix F17)", () => {
  test("C1 wiring survives operator-renamed visitorAuth augment", async () => {
    // Operator uses a custom name for visitorAuth in agent.yaml.
    // Before F17, `augments.find(a => a.name === "visitor-auth")` would
    // return undefined (name was overwritten to "my-custom-auth"), leaving
    // lateBindings.revocationCheck null and revocation silently disabled.
    // After F17, lookup uses index correspondence with configs[] by type.
    const augments = await resolveAugments(
      [
        {
          type: "visitorAuth",
          name: "my-custom-auth", // operator-chosen name, not "visitor-auth"
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
    // The augment must carry isVisitorRevoked (a VisitorAuthAugmentExtras
    // method) so C1 wiring can populate lateBindings.revocationCheck.
    // If the type-based lookup failed, the augment at index 0 would be
    // looked up by name and missed — lateBindings would stay null.
    const va = augments[0] as typeof augments[0] & { isVisitorRevoked?: (id: string) => boolean };
    expect(typeof va?.isVisitorRevoked).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Multi-instance visitorAuth warning (fix F18)
// ---------------------------------------------------------------------------

describe("resolveAugments — multi-instance visitorAuth warning (fix F18)", () => {
  test("warns when multiple visitorAuth augments declared", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Two visitorAuth blocks — unsupported; only first is wired into
      // webTransport's revocation check. Resolver must warn loudly.
      const augments = await resolveAugments(
        [
          {
            type: "visitorAuth",
            name: "auth-1",
            options: {
              publicUrl: "https://zip.test",
              agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
              signingKey: "sig-x",
              layeredMemoryDbPath: null,
            },
          },
          {
            type: "visitorAuth",
            name: "auth-2",
            options: {
              publicUrl: "https://zip.test",
              agentMail: { apiKey: "am_y", inboxId: "ibx_y" },
              signingKey: "sig-y",
              layeredMemoryDbPath: null,
            },
          },
        ],
        TMP,
      );
      expect(augments).toHaveLength(2);
      // console.warn must have been called at least once with a message
      // containing "Multiple visitorAuth augments".
      const warnCalls = warnSpy.mock.calls;
      const multiWarnCall = warnCalls.find(
        (args) =>
          typeof args[0] === "string" && args[0].includes("Multiple visitorAuth augments"),
      );
      expect(multiWarnCall).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
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

// ---------------------------------------------------------------------------
// F2: single-source signingKey + auto-disable visitor tokens when absent
// ---------------------------------------------------------------------------

describe("resolveAugments — single-source signingKey injection (fix F2)", () => {
  function vaConfigWithKey(signingKey: string): AugmentConfig {
    return {
      type: "visitorAuth",
      name: "visitor-auth",
      options: {
        publicUrl: "https://zip.test",
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey,
        layeredMemoryDbPath: null,
      },
    };
  }

  function wtConfigBase(extra?: Record<string, unknown>): AugmentConfig {
    return {
      type: "webTransport",
      name: "web",
      options: {
        port: 9124,
        auth: { type: "bearer", token: "tok" },
        ...extra,
      },
    };
  }

  test("auto-disables visitorTokens when visitorAuth is absent and enabled is unset", async () => {
    // webTransport with no explicit enabled setting and no visitorAuth mounted.
    // The resolver must auto-disable visitor tokens so webTransport's onBoot
    // does not throw (signingKey would be absent otherwise).
    const configs: AugmentConfig[] = [
      wtConfigBase({ visitorTokens: {} }),
    ];
    // Should resolve without throwing (the force-disabled flag prevents the
    // onBoot signingKey guard from firing).
    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    // The injected flag is on the config object (mutated in place before loop).
    // Verify indirectly: resolution did not throw, meaning enabled was set to false.
    const wtCfg = configs[0]!;
    const vt = ((wtCfg.options as Record<string, unknown>).visitorTokens ?? {}) as Record<
      string,
      unknown
    >;
    expect(vt.enabled).toBe(false);
  });

  test("respects explicit visitorTokens.enabled: true when visitorAuth is absent (custom minter scenario)", async () => {
    // Operator explicitly set enabled: true without mounting visitorAuth.
    // The resolver must NOT force-disable — this is the custom-minter scenario.
    // Instead it should warn but leave enabled: true in place.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const configs: AugmentConfig[] = [
        wtConfigBase({ visitorTokens: { enabled: true, signingKey: "custom-minter-key" } }),
      ];
      const augments = await resolveAugments(configs, TMP);
      expect(augments).toHaveLength(1);
      // enabled must remain true — resolver should not override explicit setting.
      const wtCfg = configs[0]!;
      const vt = ((wtCfg.options as Record<string, unknown>).visitorTokens ?? {}) as Record<
        string,
        unknown
      >;
      expect(vt.enabled).toBe(true);
      // Must warn about no visitorAuth mounted.
      const warnCalls = warnSpy.mock.calls;
      const hasWarn = warnCalls.some(
        (args) => typeof args[0] === "string" && /no visitorAuth augment is mounted/.test(args[0]),
      );
      expect(hasWarn).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("respects explicit visitorTokens.enabled: false when visitorAuth is mounted", async () => {
    // Operator explicitly set enabled: false even though visitorAuth is mounted.
    // The resolver must NOT force-enable — respect operator intent and warn.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const vaKey = "my-signing-key";
      const configs: AugmentConfig[] = [
        vaConfigWithKey(vaKey),
        wtConfigBase({ visitorTokens: { enabled: false } }),
      ];
      const augments = await resolveAugments(configs, TMP);
      expect(augments).toHaveLength(2);
      // enabled must remain false.
      const wtCfg = configs[1]!;
      const vt = ((wtCfg.options as Record<string, unknown>).visitorTokens ?? {}) as Record<
        string,
        unknown
      >;
      expect(vt.enabled).toBe(false);
      // Must warn about this unusual config.
      const warnCalls = warnSpy.mock.calls;
      const hasWarn = warnCalls.some(
        (args) =>
          typeof args[0] === "string" &&
          /visitorAuth is mounted but.*enabled is explicitly false/.test(args[0]),
      );
      expect(hasWarn).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("iterates all webTransport configs — both get signingKey injection", async () => {
    // Two webTransport blocks: both should receive the injected signingKey.
    const vaKey = "shared-signing-key";
    const configs: AugmentConfig[] = [
      vaConfigWithKey(vaKey),
      {
        type: "webTransport",
        name: "web-a",
        options: { port: 9124, auth: { type: "bearer", token: "tok-a" } },
      },
      {
        type: "webTransport",
        name: "web-b",
        options: { port: 9125, auth: { type: "bearer", token: "tok-b" } },
      },
    ];
    await resolveAugments(configs, TMP);
    for (const wtCfg of configs.filter((c) => c.type === "webTransport")) {
      const vt = ((wtCfg.options as Record<string, unknown>).visitorTokens ?? {}) as Record<
        string,
        unknown
      >;
      expect(vt.signingKey).toBe(vaKey);
      expect(vt.enabled).toBe(true);
    }
  });

  test("auto-injects signingKey from visitorAuth into webTransport", async () => {
    // When both are mounted, visitorAuth's signingKey must be injected into
    // webTransport's visitorTokens so operators don't have to set it twice.
    const vaKey = "my-secret-signing-key";
    const configs: AugmentConfig[] = [
      vaConfigWithKey(vaKey),
      wtConfigBase(), // no signingKey — should be injected
    ];
    await resolveAugments(configs, TMP);
    const wtCfg = configs[1]!;
    const vt = ((wtCfg.options as Record<string, unknown>).visitorTokens ?? {}) as Record<
      string,
      unknown
    >;
    expect(vt.signingKey).toBe(vaKey);
    expect(vt.enabled).toBe(true);
  });

  test("warns when both augments specify a different signingKey", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const configs: AugmentConfig[] = [
        vaConfigWithKey("key-from-va"),
        wtConfigBase({ visitorTokens: { signingKey: "key-from-wt" } }), // different key
      ];
      await resolveAugments(configs, TMP);
      const warnCalls = warnSpy.mock.calls;
      const signingKeyWarn = warnCalls.find(
        (args) => typeof args[0] === "string" && /signingKey/.test(args[0]),
      );
      expect(signingKeyWarn).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
