import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig, interpolateEnvVars, loadEnvFile } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-config-test");

function writeYaml(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

function minimalConfig(overrides: Record<string, unknown> = {}): string {
  const base = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name: "test-agent",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    augments: [
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
    ],
    ...overrides,
  };
  return stringify(base);
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  // Write a dummy identity file so fileMemory doesn't fail path checks.
  writeFileSync(join(TMP, "identity.md"), "# Test Identity");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseConfig", () => {
  test("validates console proxy networks and allowed origins", () => {
    const augments = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port: 8080,
          auth: { type: "bearer", token: "test-token" },
          trustedProxies: ["10.0.0.0/8", "2001:db8::1"],
          consoleSecurity: { allowedOrigins: ["https://agent.example"] },
        },
      },
    ];
    const path = writeYaml("agent.yaml", minimalConfig({ augments }));
    expect(parseConfig(path).augments[0]?.options?.trustedProxies).toEqual([
      "10.0.0.0/8",
      "2001:db8::1",
    ]);
  });

  test("rejects malformed console proxy networks and origins", () => {
    const augments = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port: 8080,
          auth: { type: "bearer", token: "test-token" },
          trustedProxies: ["0.0.0.0/0"],
          consoleSecurity: { allowedOrigins: ["https://agent.example/path"] },
        },
      },
    ];
    const path = writeYaml("agent.yaml", minimalConfig({ augments }));
    expect(() => parseConfig(path)).toThrow(/trustedProxies/);
    expect(() => parseConfig(path)).toThrow(/allowedOrigins/);
  });

  test("parses a minimal valid config", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.id).toBe("aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c");
    expect(config.name).toBe("test-agent");
    expect(config.engine.provider).toBe("anthropic");
    expect(config.engine.model).toBe("claude-sonnet-4-6");
    expect(config.augments).toHaveLength(1);
    expect(config.augments[0]!.name).toBe("identity");
    expect(config.augments[0]!.type).toBe("fileMemory");
  });

  test("includes optional fields when present", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        purpose: "test purpose",
        displayName: "Jim",
        creator: { displayName: "Alex" },
        settings: { compactionStrategy: "truncate", maxInferenceLoops: 5 },
      }),
    );
    const config = parseConfig(path);
    expect(config.purpose).toBe("test purpose");
    expect(config.displayName).toBe("Jim");
    expect(config.creator).toEqual({ displayName: "Alex" });
    expect(config.settings.compactionStrategy).toBe("truncate");
    expect(config.settings.maxInferenceLoops).toBe(5);
  });

  test("defaults settings to empty object when omitted", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.settings).toBeDefined();
  });

  test("loads string augment entries from augments/<id>/augment.yaml", () => {
    mkdirSync(join(TMP, "augments", "webFetch"), { recursive: true });
    writeFileSync(
      join(TMP, "augments", "webFetch", "augment.yaml"),
      stringify({
        type: "webFetch",
        config: { timeoutMs: 1234 },
      }),
    );

    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: ["webFetch"],
      }),
    );
    const config = parseConfig(path);

    expect(config.augments).toHaveLength(1);
    expect(config.augments[0]).toEqual({
      name: "webFetch",
      type: "webFetch",
      options: { timeoutMs: 1234 },
    });
  });

  test("normalizes custom augment source paths from the augment folder", () => {
    mkdirSync(join(TMP, "augments", "weather"), { recursive: true });
    writeFileSync(
      join(TMP, "augments", "weather", "augment.yaml"),
      stringify({
        type: "custom",
        source: "./index.ts",
        config: { prefix: "wx" },
      }),
    );

    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: ["weather"],
      }),
    );
    const config = parseConfig(path);

    expect(config.augments[0]).toEqual({
      name: "weather",
      type: "custom",
      source: "./augments/weather/index.ts",
      options: { prefix: "wx" },
    });
  });

  test("rejects string augment entries without augment metadata", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: ["notify"],
      }),
    );

    expect(() => parseConfig(path)).toThrow("missing augment metadata");
  });
});

describe("visitorAuth rate-limit config", () => {
  test("accepts a local minimum interval with positive rolling caps", () => {
    const path = writeYaml(
      "visitor-auth-rate-limit.yaml",
      minimalConfig({
        augments: [
          {
            type: "visitorAuth",
            options: {
              rateLimit: { minIntervalSeconds: 10, perHour: 360, perDay: 8_640 },
            },
          },
        ],
      }),
    );

    const config = parseConfig(path);
    expect(config.augments[0]?.options?.rateLimit).toEqual({
      minIntervalSeconds: 10,
      perHour: 360,
      perDay: 8_640,
    });
  });

  test("rejects fractional, non-positive, and negative visitorAuth limits", () => {
    const path = writeYaml(
      "visitor-auth-invalid-rate-limit.yaml",
      minimalConfig({
        augments: [
          {
            type: "visitorAuth",
            options: {
              rateLimit: { minIntervalSeconds: -1, perHour: 0, perDay: 2.5 },
            },
          },
        ],
      }),
    );

    expect(() => parseConfig(path)).toThrow("rateLimit.minIntervalSeconds");
    expect(() => parseConfig(path)).toThrow("rateLimit.perHour");
    expect(() => parseConfig(path)).toThrow("rateLimit.perDay");
  });
});

describe("validation errors", () => {
  test("rejects missing id", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ id: undefined }));
    expect(() => parseConfig(path)).toThrow("id:");
  });

  test("rejects invalid aug1_ id format", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ id: "bad-id" }));
    expect(() => parseConfig(path)).toThrow("aug1_");
  });

  test("rejects missing name", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ name: undefined }));
    expect(() => parseConfig(path)).toThrow("name:");
  });

  test("rejects missing engine", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ engine: undefined }));
    expect(() => parseConfig(path)).toThrow("engine:");
  });

  test("rejects empty augments array", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ augments: [] }));
    expect(() => parseConfig(path)).toThrow("augments:");
  });

  test("rejects duplicate augment names", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          { name: "dup", type: "webFetch", options: {} },
          { name: "dup", type: "webFetch", options: {} },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow('duplicate name "dup"');
  });

  test("defaults omitted built-in augment name to its type", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ type: "webFetch", options: { timeoutMs: 5000 } }],
      }),
    );

    const config = parseConfig(path);
    expect(config.augments[0]).toMatchObject({ name: "webFetch", type: "webFetch" });
  });

  test("requires explicit name for custom augments", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ type: "custom", source: "./augments/weather/index.ts", options: {} }],
      }),
    );

    expect(() => parseConfig(path)).toThrow('name: required for type "custom"');
  });

  test("rejects unknown augment type", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "x", type: "unknownThing", options: {} }],
      }),
    );
    expect(() => parseConfig(path)).toThrow("unknownThing");
  });

  test("rejects custom augment without source", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "x", type: "custom", options: {} }],
      }),
    );
    expect(() => parseConfig(path)).toThrow("source");
  });

  test("rejects invalid compactionStrategy", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        settings: { compactionStrategy: "invalid" },
      }),
    );
    expect(() => parseConfig(path)).toThrow("compactionStrategy");
  });

  test("rejects unknown engine provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "foobar", model: "x" },
      }),
    );
    expect(() => parseConfig(path)).toThrow('unknown provider "foobar"');
  });
});

describe("link agent card capabilities", () => {
  const linkOptions = {
    dbPath: "./link.db",
    agentCard: {
      id: "00000000-0000-4000-8000-00000000aaaa",
      name: "test-agent",
      description: "Link test agent",
      endpointUrl: "https://test-agent.example.org",
      capabilities: ["answers catalog questions"],
    },
  };

  test("preserves operator-advertised Link capabilities", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ type: "link", options: linkOptions }],
      }),
    );

    const config = parseConfig(path);
    expect(config.augments[0]?.options?.agentCard).toMatchObject({
      capabilities: ["answers catalog questions"],
    });
  });

  test("rejects non-string Link capabilities", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            type: "link",
            options: {
              ...linkOptions,
              agentCard: { ...linkOptions.agentCard, capabilities: ["valid", 42] },
            },
          },
        ],
      }),
    );

    expect(() => parseConfig(path)).toThrow(
      "augments[0].options.agentCard.capabilities: must be an array of strings",
    );
  });

  test("accepts an explicit outbound trust delegation", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            type: "link",
            options: {
              ...linkOptions,
              peers: {
                researcher: {
                  url: "https://researcher.example.org",
                  bearer: "outbound-test-bearer",
                  participantId: "00000000-0000-4000-8000-00000000bbbb",
                  inboundBearer: "inbound-test-bearer",
                  inboundBearerId: "inbound-test-key",
                },
              },
              outbound: {
                allowedTrustLevels: ["creator", "agent", "public"],
                publicDelegationPeers: {
                  researcher: {
                    url: "https://researcher.example.org",
                    participantId: "00000000-0000-4000-8000-00000000bbbb",
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(parseConfig(path).augments[0]?.options?.outbound).toEqual({
      allowedTrustLevels: ["creator", "agent", "public"],
      publicDelegationPeers: {
        researcher: {
          url: "https://researcher.example.org",
          participantId: "00000000-0000-4000-8000-00000000bbbb",
        },
      },
    });
  });

  test("rejects malformed, duplicate, empty, and misspelled outbound trust policy", () => {
    for (const outbound of [
      { allowedTrustLevels: [] },
      { allowedTrustLevels: ["creator", "creator"] },
      { allowedTrustLevels: ["staff"] },
      { allowedTrustLevels: ["public"] },
      {
        allowedTrustLevels: ["creator"],
        publicDelegationPeers: {
          researcher: {
            url: "https://researcher.example.org",
            participantId: "00000000-0000-4000-8000-00000000bbbb",
          },
        },
      },
      {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: {},
      },
      {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: [],
      },
      {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: { researcher: "" },
      },
      {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: {
          researcher: {
            url: "https://researcher.example.org",
            participantId: "00000000-0000-4000-8000-00000000cccc",
          },
        },
      },
      {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: {
          unknown: {
            url: "https://unknown.example.org",
            participantId: "00000000-0000-4000-8000-00000000bbbb",
          },
        },
      },
      { allowTrustLevels: ["public"] },
    ]) {
      const path = writeYaml(
        "agent.yaml",
        minimalConfig({
          augments: [
            {
              type: "link",
              options: { ...linkOptions, outbound },
            },
          ],
        }),
      );
      expect(() => parseConfig(path)).toThrow(/outbound/);
    }
  });

  test("requires exact operator-owned endpoint and participant pins for peerSource", () => {
    const valid = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            type: "link",
            options: {
              ...linkOptions,
              peerSource: {
                type: "registry",
                url: "https://registry.example.org/peers.json",
                pins: {
                  researcher: {
                    url: "https://researcher.example.org",
                    participantId: "00000000-0000-4000-8000-00000000bbbb",
                  },
                },
              },
            },
          },
        ],
      }),
    );
    expect(parseConfig(valid).augments[0]?.options?.peerSource).toMatchObject({
      pins: {
        researcher: {
          url: "https://researcher.example.org",
          participantId: "00000000-0000-4000-8000-00000000bbbb",
        },
      },
    });

    for (const peerSource of [
      { type: "registry", url: "https://registry.example.org/peers.json" },
      {
        type: "registry",
        url: "https://registry.example.org/peers.json",
        pins: {},
      },
      {
        type: "registry",
        url: "https://registry.example.org/peers.json",
        pins: { researcher: { participantId: "peer" } },
      },
      {
        type: "registry",
        url: "https://registry.example.org/peers.json",
        pins: {
          researcher: {
            url: "https://researcher.example.org",
            participantId: "peer",
            delegatedOrigin: true,
          },
        },
      },
    ]) {
      const invalid = writeYaml(
        "agent.yaml",
        minimalConfig({
          augments: [
            {
              type: "link",
              options: { ...linkOptions, peerSource },
            },
          ],
        }),
      );
      expect(() => parseConfig(invalid)).toThrow(/peerSource/);
    }
  });
});

describe("engine.reasoningEffort validation", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    test(`accepts ${effort}`, () => {
      const path = writeYaml(
        "agent.yaml",
        minimalConfig({
          engine: { provider: "anthropic", model: "claude-sonnet-4-6", reasoningEffort: effort },
        }),
      );
      const config = parseConfig(path);
      expect(config.engine.reasoningEffort).toBe(effort as never);
    });
  }

  test("rejects invalid reasoningEffort value", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "anthropic", model: "claude-sonnet-4-6", reasoningEffort: "ultra" },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.reasoningEffort");
  });
});

describe("engine credential transport validation", () => {
  test("accepts absolute HTTP(S) base URLs and a boolean development override", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openai",
          model: "gpt-5",
          baseURL: "https://proxy.example.test/v1",
          allowInsecureHttpWithCredentials: false,
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.baseURL).toBe("https://proxy.example.test/v1");
    expect(config.engine.allowInsecureHttpWithCredentials).toBe(false);
  });

  test.each(["/relative", "ftp://provider.example.test", "http://user:pass@host.test"])(
    "rejects unsafe baseURL without echoing it: %s",
    (baseURL) => {
      const path = writeYaml(
        "agent.yaml",
        minimalConfig({
          engine: { provider: "openai", model: "gpt-5", baseURL },
        }),
      );
      let error: unknown;
      try {
        parseConfig(path);
      } catch (cause) {
        error = cause;
      }
      expect(String(error)).toContain("engine.baseURL");
      expect(String(error)).not.toContain(baseURL);
    },
  );

  test("rejects a non-boolean development override", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openai",
          model: "gpt-5",
          allowInsecureHttpWithCredentials: "yes",
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.allowInsecureHttpWithCredentials");
  });
});

describe("engine.providerRouting validation", () => {
  test("accepts valid providerRouting for openrouter", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "qwen/qwen3.5-397b-a17b",
          providerRouting: {
            only: ["openai"],
            sort: "price",
            max_price: { prompt: 1, completion: 2 },
          },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.providerRouting?.only).toEqual(["openai"]);
    expect(config.engine.providerRouting?.sort).toBe("price");
  });

  test("rejects malformed, noncanonical, and duplicate restrictive slugs", () => {
    for (const only of [
      [""],
      [" openai"],
      ["OpenAI"],
      ["openai", "openai"],
      ["deepinfra/turbo"],
      ["openai%2fother"],
    ]) {
      const path = writeYaml(
        "agent.yaml",
        minimalConfig({
          engine: {
            provider: "openrouter",
            model: "qwen/qwen3.5-397b-a17b",
            providerRouting: { only },
          },
        }),
      );
      expect(() => parseConfig(path)).toThrow("providerRouting.only");
    }
  });

  test("rejects unknown providerRouting keys instead of ignoring typos", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "qwen/qwen3.5-397b-a17b",
          providerRouting: { onIy: ["openai"] },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.onIy");
  });

  test("rejects providerRouting for non-openrouter provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          providerRouting: { only: ["OpenAI"] },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      "providerRouting: only valid for provider 'openrouter'",
    );
  });
});

describe("engine.keepAlive + engine.options validation (ollama-only)", () => {
  test("accepts string keepAlive on ollama", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ engine: { provider: "ollama", model: "llama3.2", keepAlive: "30m" } }),
    );
    const config = parseConfig(path);
    expect(config.engine.keepAlive).toBe("30m");
  });

  test("accepts numeric keepAlive on ollama (0 = unload after turn)", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ engine: { provider: "ollama", model: "llama3.2", keepAlive: 0 } }),
    );
    const config = parseConfig(path);
    expect(config.engine.keepAlive).toBe(0);
  });

  test("rejects keepAlive for non-ollama provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "anthropic", model: "claude-sonnet-4-6", keepAlive: "5m" },
      }),
    );
    expect(() => parseConfig(path)).toThrow("keepAlive: only valid for provider 'ollama'");
  });

  test("rejects non-string non-number keepAlive", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "ollama", model: "llama3.2", keepAlive: true },
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      'keepAlive: must be a duration string (e.g. "5m") or a number of seconds',
    );
  });

  test("accepts options object on ollama", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "ollama",
          model: "llama3.2",
          options: { temperature: 0.7, seed: 42, top_p: 0.9 },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.options).toEqual({ temperature: 0.7, seed: 42, top_p: 0.9 });
  });

  test("rejects options for non-ollama provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "openai", model: "gpt-5", options: { temperature: 0.7 } },
      }),
    );
    expect(() => parseConfig(path)).toThrow("options: only valid for provider 'ollama'");
  });

  test("rejects non-object options", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "ollama", model: "llama3.2", options: "temperature=0.7" },
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      "options: must be an object (native Ollama generation options)",
    );
  });

  test("rejects invalid sort value", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { sort: "speed" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.sort");
  });

  test("rejects non-array only", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { only: "OpenAI" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.only");
  });

  test("rejects empty only array", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { only: [] },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.only");
  });

  test("rejects negative max_price.prompt", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { max_price: { prompt: -1 } },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("max_price.prompt");
  });

  test("rejects non-numeric max_price.completion", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { max_price: { completion: "free" } },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("max_price.completion");
  });
});

describe("engine.costOverride validation", () => {
  test("accepts valid costOverride with positive rates", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "claude-future-99-experimental",
          costOverride: { inputUsdPerMtok: 2.5, outputUsdPerMtok: 10.0 },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.costOverride?.inputUsdPerMtok).toBe(2.5);
    expect(config.engine.costOverride?.outputUsdPerMtok).toBe(10.0);
  });

  test("accepts costOverride with zero rates (free tier or internal model)", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openai",
          model: "gpt-internal",
          costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.costOverride?.inputUsdPerMtok).toBe(0);
    expect(config.engine.costOverride?.outputUsdPerMtok).toBe(0);
  });

  test("rejects costOverride that is not an object", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: "free",
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride");
  });

  test("rejects costOverride with missing inputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { outputUsdPerMtok: 5 },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.inputUsdPerMtok");
  });

  test("rejects costOverride with missing outputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { inputUsdPerMtok: 5 },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.outputUsdPerMtok");
  });

  test("rejects costOverride with negative inputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { inputUsdPerMtok: -1, outputUsdPerMtok: 5 },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.inputUsdPerMtok");
  });

  test("rejects costOverride with non-number outputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: "cheap" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.outputUsdPerMtok");
  });

  test("omitted costOverride leaves field undefined (no validation errors)", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.engine.costOverride).toBeUndefined();
  });
});

describe("env var interpolation", () => {
  test("replaces ${VAR} with env value", () => {
    process.env.TEST_INTERP_VAR = "replaced-value";
    const result = interpolateEnvVars({ key: "${TEST_INTERP_VAR}" });
    expect(result).toEqual({ key: "replaced-value" });
    delete process.env.TEST_INTERP_VAR;
  });

  test("replaces nested ${VAR} references", () => {
    process.env.TEST_NESTED = "deep";
    const result = interpolateEnvVars({ a: { b: { c: "${TEST_NESTED}" } } });
    expect(result).toEqual({ a: { b: { c: "deep" } } });
    delete process.env.TEST_NESTED;
  });

  test("replaces ${VAR} in arrays", () => {
    process.env.TEST_ARR = "item";
    const result = interpolateEnvVars({ list: ["${TEST_ARR}", "static"] });
    expect(result).toEqual({ list: ["item", "static"] });
    delete process.env.TEST_ARR;
  });

  test("throws on missing env var with location context", () => {
    expect(() => interpolateEnvVars({ token: "${MISSING_VAR_XYZ}" })).toThrow("MISSING_VAR_XYZ");
  });

  test("reports each missing env var once even when referenced multiple times", () => {
    let caught: Error | null = null;
    try {
      interpolateEnvVars({
        a: "${MISSING_DUPLICATE_VAR_XYZ}",
        b: "${MISSING_DUPLICATE_VAR_XYZ}",
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    const matches = caught!.message.match(/MISSING_DUPLICATE_VAR_XYZ/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test("leaves non-string values unchanged", () => {
    const result = interpolateEnvVars({ num: 42, bool: true, nil: null });
    expect(result).toEqual({ num: 42, bool: true, nil: null });
  });
});

describe("loadEnvFile", () => {
  test("loads KEY=VALUE pairs into process.env", () => {
    writeFileSync(join(TMP, ".env"), "TEST_LOAD_KEY=hello\nTEST_LOAD_KEY2=world");
    loadEnvFile(TMP);
    expect(process.env.TEST_LOAD_KEY).toBe("hello");
    expect(process.env.TEST_LOAD_KEY2).toBe("world");
    delete process.env.TEST_LOAD_KEY;
    delete process.env.TEST_LOAD_KEY2;
  });

  test("strips surrounding quotes from values", () => {
    writeFileSync(join(TMP, ".env"), 'TEST_QUOTED="quoted-value"');
    loadEnvFile(TMP);
    expect(process.env.TEST_QUOTED).toBe("quoted-value");
    delete process.env.TEST_QUOTED;
  });

  test("skips comments and blank lines", () => {
    writeFileSync(join(TMP, ".env"), "# comment\n\nTEST_COMMENT_KEY=val");
    loadEnvFile(TMP);
    expect(process.env.TEST_COMMENT_KEY).toBe("val");
    delete process.env.TEST_COMMENT_KEY;
  });

  test("does not override existing env vars", () => {
    process.env.TEST_EXISTING = "original";
    writeFileSync(join(TMP, ".env"), "TEST_EXISTING=overridden");
    loadEnvFile(TMP);
    expect(process.env.TEST_EXISTING).toBe("original");
    delete process.env.TEST_EXISTING;
  });

  test("silently skips if .env does not exist", () => {
    expect(() => loadEnvFile("/nonexistent/path")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// budgets augment options validation
// ---------------------------------------------------------------------------

describe("budgets augment options validation", () => {
  test("accepts a valid budgets block with full caps", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                agent: { maxTurnsPerThread: 100 },
                public: {
                  recognized: { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1 },
                  anonymous: { maxTurnsPerThread: 5 },
                },
              },
              anonymousGlobalLimit: 30,
              dailyBudgetUsd: 5,
              notifications: {
                destination: "ops",
                thresholds: [0.5, 0.8, 1],
              },
              retentionDays: 30,
              cleanupWindowMs: 86400000,
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments[0]!.type).toBe("budgets");
    expect(config.augments[0]!.options!.dbPath).toBe("./budgets.db");
    expect(config.augments[0]!.options!.dailyBudgetUsd).toBe(5);
    expect(config.augments[0]!.options!.notifications).toEqual({
      destination: "ops",
      thresholds: [0.5, 0.8, 1],
    });
    expect(config.augments[0]!.options!.retentionDays).toBe(30);
  });

  test("accepts a minimal budgets block (only dbPath)", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "budgets", type: "budgets", options: { dbPath: "./budgets.db" } }],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments[0]!.type).toBe("budgets");
  });

  test("rejects budgets block missing dbPath", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "budgets", type: "budgets", options: {} }],
      }),
    );
    expect(() => parseConfig(path)).toThrow("dbPath");
  });

  test("rejects negative dailyBudgetUsd", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", dailyBudgetUsd: -1 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("dailyBudgetUsd");
  });

  test("rejects zero dailyBudgetUsd", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", dailyBudgetUsd: 0 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("dailyBudgetUsd");
  });

  test("rejects negative anonymousGlobalLimit", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", anonymousGlobalLimit: -5 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("anonymousGlobalLimit");
  });

  test("rejects negative cleanupWindowMs", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", cleanupWindowMs: -1000 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("cleanupWindowMs");
  });

  test("rejects enabled budget notifications without a destination", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              dailyBudgetUsd: 10,
              notifications: { thresholds: [0.5] },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("notifications.destination");
  });

  test("rejects budget notification thresholds outside 0 < n <= 1", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              dailyBudgetUsd: 10,
              notifications: { destination: "ops", thresholds: [0.5, 1.2] },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("notifications.thresholds[1]");
  });

  test("rejects negative retentionDays", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", retentionDays: -1 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("retentionDays");
  });

  test("rejects fractional retentionDays", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", retentionDays: 1.5 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("retentionDays: must be a positive integer");
  });

  test("rejects caps.public.anonymous.maxTurnsPerThread = -5", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  anonymous: { maxTurnsPerThread: -5 },
                },
              },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("caps.public.anonymous.maxTurnsPerThread");
  });

  test("rejects caps.public.recognized.maxUsdPerDay = 0", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  recognized: { maxUsdPerDay: 0 },
                },
              },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("maxUsdPerDay");
  });

  test("rejects unimplemented caps.public.recognized.maxUsdPerThread", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  recognized: { maxUsdPerThread: 1 },
                },
              },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("maxUsdPerThread");
  });

  test("rejects caps.agent.maxTurnsPerDay as non-number", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: { agent: { maxTurnsPerDay: "many" } },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("caps.agent.maxTurnsPerDay");
  });

  test("tolerates unknown extra fields under caps (pass-through)", () => {
    // Unknown fields are not validated — they are passed through to the factory.
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  recognized: { maxTurnsPerThread: 10, unknownCap: 999 },
                },
              },
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments[0]!.type).toBe("budgets");
  });
});

describe("parseConfig — augmented missing-env-var error", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-error-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAgentYaml(): string {
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(
      yamlPath,
      [
        "id: aug1_00000000-0000-0000-0000-000000000000",
        "name: test",
        "engine:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "augments:",
        "  - name: web",
        "    type: webTransport",
        "    options:",
        "      port: 8080",
        "      auth:",
        "        type: bearer",
        "        token: ${MISSING_TOKEN}",
        "",
      ].join("\n"),
    );
    return yamlPath;
  }

  test("includes .env path and cp suggestion when only .env.example exists", () => {
    const yamlPath = writeAgentYaml();
    writeFileSync(join(dir, ".env.example"), "MISSING_TOKEN=\n");
    expect(() => parseConfig(yamlPath)).toThrow(/\.env.*\n.*cp .*\.env\.example .*\.env/s);
  });

  test("includes .env path only when .env exists", () => {
    const yamlPath = writeAgentYaml();
    writeFileSync(join(dir, ".env"), "");
    writeFileSync(join(dir, ".env.example"), "");
    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/\.env/);
    expect(caught!.message).toMatch(/Add values for the missing keys/);
    expect(caught!.message).not.toMatch(/cp .*\.env\.example/);
  });

  test("names the augment metadata file when env is missing from folder-backed config", () => {
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(
      yamlPath,
      [
        "id: aug1_00000000-0000-0000-0000-000000000000",
        "name: test",
        "engine:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "augments:",
        "  - webTransport",
        "",
      ].join("\n"),
    );
    mkdirSync(join(dir, "augments", "webTransport"), { recursive: true });
    writeFileSync(
      join(dir, "augments", "webTransport", "augment.yaml"),
      [
        "type: webTransport",
        "config:",
        "  auth:",
        "    type: bearer",
        "    token: ${MISSING_TOKEN}",
        "",
      ].join("\n"),
    );

    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain(
      "Missing environment variables in augments/webTransport/augment.yaml",
    );
    expect(caught!.message).toContain("MISSING_TOKEN");
    expect(caught!.message).toContain("  .env");
  });

  test("treats empty shell env values as missing in folder-backed config", () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";

    try {
      const yamlPath = join(dir, "agent.yaml");
      writeFileSync(
        yamlPath,
        [
          "id: aug1_00000000-0000-0000-0000-000000000000",
          "name: test",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - telegramTransport",
          "",
        ].join("\n"),
      );
      mkdirSync(join(dir, "augments", "telegramTransport"), { recursive: true });
      writeFileSync(
        join(dir, "augments", "telegramTransport", "augment.yaml"),
        [
          "type: telegramTransport",
          "config:",
          "  botToken: ${TELEGRAM_BOT_TOKEN}",
          "  inbound:",
          "    mode: polling",
          "",
        ].join("\n"),
      );

      let caught: Error | null = null;
      try {
        parseConfig(yamlPath);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain(
        "Missing environment variables in augments/telegramTransport/augment.yaml",
      );
      expect(caught!.message).toContain("TELEGRAM_BOT_TOKEN");
    } finally {
      if (previous === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previous;
      }
    }
  });

  test("treats empty .env placeholder values as missing", () => {
    const yamlPath = writeAgentYaml();
    writeFileSync(join(dir, ".env"), "MISSING_TOKEN=\n");

    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("MISSING_TOKEN");
    expect(caught!.message).toMatch(/Add values for the missing keys/);
  });

  test("includes .env path only (no cp) when neither file exists", () => {
    const yamlPath = writeAgentYaml();
    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/\.env/);
    expect(caught!.message).not.toMatch(/cp .*\.env\.example/);
  });

  test("non-env-var errors are NOT augmented", () => {
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(yamlPath, "not: valid: yaml: at: all");
    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // Should NOT contain the .env-suggestion suffix.
    expect(caught!.message).not.toMatch(/Add values for the missing keys/);
  });
});

// ---------------------------------------------------------------------------
// securityEval overrides — portable security eval suite per-agent context
// ---------------------------------------------------------------------------

describe("securityEval", () => {
  test("parses fine and returns undefined when block is omitted", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.securityEval).toBeUndefined();
  });

  test("parses fine when block is empty; all subfields undefined", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: {} }));
    const config = parseConfig(path);
    expect(config.securityEval).toEqual({});
    expect(config.securityEval?.creatorName).toBeUndefined();
    expect(config.securityEval?.refusalPhrasings).toBeUndefined();
  });

  test("parses fine when all fields are populated correctly", () => {
    const securityEval = {
      creatorName: "Alice",
      agentName: "TestAgent",
      refusalPhrasings: ["won't", "can't"],
      systemPromptLeakMarkers: ["<system>", "# System"],
      identitySelfClaimKeywords: ["TestAgent", "assistant"],
      secretLeakMarkers: ["sk-ant-", "BEGIN PRIVATE KEY"],
      fixtureEnvPath: "/private/.env.fixture",
      fixtureInternalUrl: "http://localhost:4000/admin",
      fixtureShellInitPath: "/private/.zshrc-fixture",
      fixtureWorkspaceRoot: "/private/",
      fixtureAwsCredentialsPath: "/private/.aws-fixture/credentials",
    };
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval }));
    const config = parseConfig(path);
    expect(config.securityEval).toEqual(securityEval);
  });

  test("rejects non-object securityEval", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: "not-an-object" }));
    expect(() => parseConfig(path)).toThrow(/securityEval: must be an object/);
  });

  test("rejects array securityEval", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: ["bad"] }));
    expect(() => parseConfig(path)).toThrow(/securityEval: must be an object/);
  });

  test("rejects list field given a string", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ securityEval: { refusalPhrasings: "not-an-array" } }),
    );
    expect(() => parseConfig(path)).toThrow(
      /securityEval\.refusalPhrasings: must be an array of strings/,
    );
  });

  test("rejects list field with non-string entries", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ securityEval: { systemPromptLeakMarkers: ["ok", 42] } }),
    );
    expect(() => parseConfig(path)).toThrow(
      /securityEval\.systemPromptLeakMarkers: must be an array of strings/,
    );
  });

  test("rejects scalar field given a number", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: { creatorName: 123 } }));
    expect(() => parseConfig(path)).toThrow(/securityEval\.creatorName: must be a string/);
  });

  test("mixed valid + invalid: surfaces the offending field", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        securityEval: {
          creatorName: "Alice", // valid
          refusalPhrasings: ["won't", "can't"], // valid
          fixtureEnvPath: 999, // invalid scalar
          identitySelfClaimKeywords: "nope", // invalid list
        },
      }),
    );
    let caught: Error | null = null;
    try {
      parseConfig(path);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/securityEval\.fixtureEnvPath: must be a string/);
    expect(caught!.message).toMatch(
      /securityEval\.identitySelfClaimKeywords: must be an array of strings/,
    );
  });
});

describe("notify augment agentmail transport validation", () => {
  test("accepts a valid agentmail destination with apiKey, inboxId, and to", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
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
            name: "notify",
            type: "notify",
            options: {
              destinations: [
                {
                  name: "agentmail-dest",
                  transport: "agentmail",
                  apiKey: "key_12345",
                  inboxId: "inbox_abc123",
                  to: "operator@example.com",
                },
              ],
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments).toHaveLength(2);
    const notifyAugment = config.augments.find((a) => a.type === "notify");
    expect(notifyAugment).toBeDefined();
    const options = notifyAugment?.options as {
      destinations: Array<{ transport: string }>;
    };
    expect(options.destinations).toHaveLength(1);
    expect(options.destinations[0]?.transport).toBe("agentmail");
  });

  test("rejects agentmail destination missing apiKey", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
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
            name: "notify",
            type: "notify",
            options: {
              destinations: [
                {
                  name: "agentmail-dest",
                  transport: "agentmail",
                  inboxId: "inbox_abc123",
                  to: "operator@example.com",
                },
              ],
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("apiKey: required string for agentmail transport");
  });

  test("accepts destination authority fields", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "notify",
            type: "notify",
            options: {
              destinations: [
                {
                  name: "ops",
                  transport: "webhook",
                  url: "https://example.com/notify",
                  allowedTrustLevels: ["creator", "agent"],
                  publicPolicy: "escalation-only",
                },
              ],
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    const notifyAugment = config.augments.find((a) => a.type === "notify");
    expect(notifyAugment).toBeDefined();
    const notifyOptions = notifyAugment!.options as {
      destinations: Array<Record<string, unknown>>;
    };
    const destination = notifyOptions.destinations[0];
    expect(destination?.allowedTrustLevels).toEqual(["creator", "agent"]);
    expect(destination?.publicPolicy).toBe("escalation-only");
  });

  test("rejects invalid destination authority fields", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "notify",
            type: "notify",
            options: {
              destinations: [
                {
                  name: "ops",
                  transport: "webhook",
                  url: "https://example.com/notify",
                  allowedTrustLevels: ["creator", "staff"],
                  publicPolicy: "everyone",
                },
              ],
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow(/allowedTrustLevels\[1\].*creator.*agent.*public/);
    expect(() => parseConfig(path)).toThrow(/publicPolicy: must be "allowed" or "escalation-only"/);
  });
});
