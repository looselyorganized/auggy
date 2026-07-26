import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveAugments } from "../../src/cli/augment-resolver";
import type { AugmentConfig } from "../../src/cli/types";
import type { AdminOverrides } from "../../src/lib/admin-overrides";
import { createVisitorToken, deriveSigningKey } from "../../src/transports/visitor-token";
import { generateCsrfToken } from "../../src/transports/admin/admin-csrf";
import { createSqliteVisitorAuthStore } from "../../src/augments/visitorAuth/storage/sqlite-store";
import { defineAgent } from "../../src/agent";
import { createMockModel } from "../fixtures/mock-model";
import type { AgentHandle } from "../../src/types";
import { asStringTool } from "../fixtures/tool-helpers";

const TMP = join(import.meta.dir, ".tmp-resolver-test");
const AGENT_ID = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function getLikelyFreePort(): number {
  return 20_000 + Math.floor(Math.random() * 30_000);
}

function agentMailConfig(name: string, dbPath?: string): AugmentConfig {
  return {
    name,
    type: "agentMail",
    options: {
      apiKey: "am_resolver_test",
      inboxId: `inbox_${name}`,
      apiBaseUrl: "http://127.0.0.1:1/v0",
      ...(dbPath === undefined ? {} : { dbPath }),
      inbound: {
        mode: "polling",
        allowedSenders: ["*@example.com"],
      },
    },
  };
}

async function bootAgentMailAugments(augments: Awaited<ReturnType<typeof resolveAugments>>) {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const augment of augments) await augment.onBoot?.();
  } finally {
    warn.mockRestore();
  }
}

async function startAgentIfSocketsAvailable(agent: AgentHandle): Promise<boolean> {
  try {
    await agent.start();
    return true;
  } catch (err) {
    if (String((err as Error).message).includes("Failed to start server")) {
      console.warn(`[test] skipping socket assertion: ${(err as Error).message}`);
      return false;
    }
    throw err;
  }
}

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

  test("rejects the unsupported learned.md source with migration guidance", async () => {
    writeFileSync(join(TMP, "learned.md"), "legacy");

    const configs: AugmentConfig[] = [
      {
        name: "fileMemory",
        type: "fileMemory",
        options: {
          label: "learned",
          source: "./learned.md",
          mutable: true,
          origin: "agent",
          writeTrustLevels: ["public"],
          priority: "high",
          placement: "preamble",
          eviction: "drop",
        },
      },
    ];

    await expect(resolveAugments(configs, TMP)).rejects.toThrow(
      /learned\.md is no longer supported.*rename it to learned-behaviors\.md/i,
    );
  });

  test("hardens canonical learned-behaviors.md config metadata", async () => {
    writeFileSync(join(TMP, "learned-behaviors.md"), "canonical");

    const configs: AugmentConfig[] = [
      {
        name: "learned-behaviors",
        type: "fileMemory",
        options: {
          label: "learned",
          source: "./learned-behaviors.md",
          mutable: true,
          origin: "peer-derived",
          writeTrustLevels: ["public", "agent"],
          priority: "high",
          placement: "preamble",
          eviction: "drop",
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);

    expect(augments[0]!.memory!.defaults.origin).toBe("operator");
    expect(augments[0]!.memory!.writeTrustLevels).toEqual(["creator"]);
  });

  test("seeds mutable file memory into the Railway runtime volume and resumes from it", async () => {
    writeFileSync(join(TMP, "learned-behaviors.md"), "image seed");
    const runtimeDataRoot = join(TMP, "railway-data");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const configs: AugmentConfig[] = [
      {
        name: "learned-behaviors",
        type: "fileMemory",
        options: {
          label: "learned",
          source: "./learned-behaviors.md",
          mutable: true,
          origin: "operator",
          priority: "high",
          placement: "preamble",
          eviction: "drop",
        },
      },
    ];

    let [augment] = await resolveAugments(configs, TMP, { runtimeDataRoot });
    await augment!.onBoot?.();
    expect(await augment!.memory!.read!("learned")).toMatchObject({ content: "image seed" });
    await augment!.memory!.write?.("learned", "durable update");
    expect(readFileSync(join(runtimeDataRoot, "file-memory", "learned-behaviors.md"), "utf8")).toBe(
      "durable update",
    );

    writeFileSync(join(TMP, "learned-behaviors.md"), "new image seed");
    [augment] = await resolveAugments(configs, TMP, { runtimeDataRoot });
    await augment!.onBoot?.();
    expect(await augment!.memory!.read!("learned")).toMatchObject({ content: "durable update" });
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
          workspaceAwareness: { enabled: false },
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    // skills/ exists, so the auto-mount synth fires too → 2 augments.
    // Assert specifically on the filesystem one rather than the array length
    // so the test stays robust against future synth additions.
    const files = augments.find((a) => a.name === "files");
    expect(files).toBeDefined();
    expect(files!.tools).toBeDefined();
    expect(files!.tools!.length).toBe(6);
    expect(files!.context).toBeUndefined();
  });
});

describe("resolveAugments — supabaseMemory", () => {
  test("rejects a Supabase key over non-loopback plaintext HTTP", async () => {
    await expect(
      resolveAugments(
        [
          {
            name: "episodes",
            type: "supabaseMemory",
            options: {
              namespace: "episode",
              scope: "peer",
              supabaseUrl: "http://provider.example.test",
              supabaseKey: "GROUP9_SUPABASE_SENTINEL",
              table: "agent_memories",
              mutable: true,
              origin: "peer-derived",
              priority: "normal",
              placement: "preamble",
              eviction: "drop",
            },
          },
        ],
        TMP,
      ),
    ).rejects.toThrow(/plaintext HTTP/);
  });

  test("requires an explicit peer or shared scope", async () => {
    await expect(
      resolveAugments(
        [
          {
            name: "episodes",
            type: "supabaseMemory",
            options: {
              namespace: "episode",
              supabaseUrl: "https://example.supabase.co",
              supabaseKey: "test-key",
              table: "agent_memories",
              mutable: true,
              origin: "peer-derived",
              priority: "normal",
              placement: "preamble",
              eviction: "drop",
            },
          },
        ],
        TMP,
      ),
    ).rejects.toThrow(/requires explicit scope/);
  });

  test("forwards the configured Supabase ownership column to validation", async () => {
    await expect(
      resolveAugments(
        [
          {
            name: "episodes",
            type: "supabaseMemory",
            options: {
              namespace: "episode",
              namespaceColumn: "invalid-owner-column",
              scope: "peer",
              supabaseUrl: "https://example.supabase.co",
              supabaseKey: "test-key",
              table: "agent_memories",
              mutable: true,
              origin: "peer-derived",
              priority: "normal",
              placement: "preamble",
              eviction: "drop",
            },
          },
        ],
        TMP,
      ),
    ).rejects.toThrow(/namespaceColumn.*SQL identifier/i);
  });

  test("keeps exact reads unavailable for peer-scoped memory", async () => {
    const [augment] = await resolveAugments(
      [
        {
          name: "episodes",
          type: "supabaseMemory",
          options: {
            namespace: "episode",
            scope: "peer",
            supabaseUrl: "https://example.supabase.co",
            supabaseKey: "test-key",
            table: "agent_memories",
            mutable: true,
            origin: "peer-derived",
            priority: "normal",
            placement: "preamble",
            eviction: "drop",
          },
        },
      ],
      TMP,
    );
    expect(augment?.memory?.read).toBeUndefined();
  });

  test("rejects Supabase redirects before custom API-key headers can follow", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ input: string; redirect?: "error" | "follow" | "manual" }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        input: input instanceof Request ? input.url : String(input),
        redirect: init?.redirect,
      });
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example.test/collect" },
      });
    }) as typeof fetch;
    try {
      const [augment] = await resolveAugments(
        [
          {
            name: "episodes",
            type: "supabaseMemory",
            options: {
              namespace: "episode",
              scope: "peer",
              supabaseUrl: "https://example.supabase.co",
              supabaseKey: "GROUP9_SUPABASE_SENTINEL",
              table: "agent_memories",
              mutable: true,
              origin: "peer-derived",
              priority: "normal",
              placement: "preamble",
              eviction: "drop",
            },
          },
        ],
        TMP,
      );

      const memory = augment?.memory;
      if (!memory || !("search" in memory)) throw new Error("dynamic memory provider required");
      await expect(memory.search("needle", { peerId: "peer-1" })).rejects.toThrow(
        /redirects are disabled/,
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.input.includes("example.supabase.co"))).toBe(true);
      expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});

describe("resolveAugments — mcp", () => {
  test("resolves the MCP augment with lifecycle-managed tools", async () => {
    const augments = await resolveAugments([{ name: "mcp", type: "mcp", options: {} }], TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("mcp");
    expect(augments[0]!.tools).toEqual([]);
    expect(augments[0]!.onBoot).toBeDefined();
    expect(augments[0]!.onShutdown).toBeDefined();
    expect(augments[0]!.adminInfo).toBeDefined();
  });
});

describe("resolveAugments — link", () => {
  test("forwards outbound trust policy and peer routing metadata", async () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ name: "link-resolver-test", dependencies: { "@auggy/link": "^0.1.2" } }),
    );
    mkdirSync(join(TMP, "node_modules", "@auggy"), { recursive: true });
    symlinkSync(
      join(process.cwd(), "node_modules", "@auggy", "link"),
      join(TMP, "node_modules", "@auggy", "link"),
      "dir",
    );
    const [augment] = await resolveAugments(
      [
        {
          name: "mesh",
          type: "link",
          options: {
            dbPath: "./link.db",
            agentCard: {
              id: "00000000-0000-4000-8000-00000000aaaa",
              name: "resolver-agent",
              description: "Resolver test",
              endpointUrl: "https://resolver.example.org",
            },
            outbound: {
              allowedTrustLevels: ["public"],
              publicDelegationPeers: {
                researcher: {
                  url: "https://researcher.example.org",
                  participantId: "00000000-0000-4000-8000-00000000bbbb",
                },
              },
            },
            peers: {
              researcher: {
                url: "https://researcher.example.org",
                bearer: "outbound",
                participantId: "00000000-0000-4000-8000-00000000bbbb",
                inboundBearer: "inbound",
                inboundBearerId: "inbound-id",
                purpose: "Research specialist",
                examples: ["Find a paper"],
              },
            },
          },
        },
      ],
      TMP,
    );

    expect(augment?.constraints?.perTrustLevel?.creator?.neverExpose).toEqual([
      "link_send",
      "link_list",
    ]);
    expect(augment?.constraints?.perTrustLevel?.agent?.neverExpose).toEqual([
      "link_send",
      "link_list",
    ]);
    expect(augment?.constraints?.perTrustLevel?.public).toBeUndefined();
    const list = augment?.tools?.find((tool) => tool.name === "link_list");
    expect(list).toBeDefined();
    const result = JSON.parse(
      await asStringTool(list!).execute(
        {},
        {
          turnId: "public-turn",
          threadId: "public-thread",
          peer: {
            id: "visitor",
            kind: "human",
            trustLevel: "public",
            publicSubstate: "recognized",
            sourceAugment: "web",
          },
        },
      ),
    );
    expect(result.peers).toEqual([
      {
        name: "researcher",
        purpose: "Research specialist",
        examples: ["Find a paper"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// layeredMemory
// ---------------------------------------------------------------------------

describe("resolveAugments — layeredMemory", () => {
  test("rejects a Supabase backend key over non-loopback plaintext HTTP", async () => {
    await expect(
      resolveAugments(
        [
          {
            name: "memory",
            type: "layeredMemory",
            options: {
              backend: "supabase",
              namespace: "test",
              supabaseUrl: "http://provider.example.test",
              supabaseKey: "GROUP9_LAYERED_SUPABASE_SENTINEL",
            },
          },
        ],
        TMP,
      ),
    ).rejects.toThrow(/plaintext HTTP/);
  });

  test("passes autoSave options through to the layeredMemory augment", async () => {
    const augments = await resolveAugments(
      [
        {
          name: "memory",
          type: "layeredMemory",
          options: {
            backend: "sqlite",
            dbPath: "./memory.sqlite",
            namespace: "test",
            autoSave: { enabled: false },
          },
        },
      ],
      TMP,
    );

    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("memory");
    expect(augments[0]!.type).toBe("layeredMemory");
    expect(augments[0]!.memory?.owns).toEqual({ kind: "namespace", prefix: "test:" });
    expect(augments[0]!.scheduleAfterTurn).toBeUndefined();
    expect(augments[0]!.handleInternalTurn).toBeUndefined();
  });

  test("binds the configured namespace to the immutable agent id", async () => {
    const [augment] = await resolveAugments(
      [
        {
          name: "memory",
          type: "layeredMemory",
          options: {
            backend: "sqlite",
            dbPath: "./scoped-memory.sqlite",
            namespace: "episodes",
            autoSave: { enabled: false },
          },
        },
      ],
      TMP,
      { agentId: AGENT_ID },
    );

    expect(augment!.memory?.owns).toEqual({
      kind: "namespace",
      prefix: `${AGENT_ID}:episodes:`,
    });
    await augment!.onShutdown?.();
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

  test("forwards externalAuth and fails closed when replay has no explicit store", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port: 9999,
          auth: { type: "bearer", token: "test-token" },
          externalAuth: {
            secret: "app-secret",
            audience: "agent-test",
            replayProtection: { enabled: true },
          },
        },
      },
    ];

    const [web] = await resolveAugments(configs, TMP);
    await expect(web?.onBoot?.()).rejects.toThrow(/replayProtection.*store/);
  });

  test("passes creator displayName to webTransport creator identity", async () => {
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

    const augments = await resolveAugments(configs, TMP, {
      creator: { displayName: "Michael" },
    });
    const peer = augments[0]!.transport!.identify?.({
      headers: {},
      __bearerValidated: true,
      __threadId: "thread-1",
    });
    expect(peer?.id).toBe("creator");
    expect(peer?.trustLevel).toBe("creator");
    expect(peer?.displayName).toBe("Michael");
  });

  test("forwards publicIntegration from yaml options to webTransport", async () => {
    const port = getLikelyFreePort();
    const configs: AugmentConfig[] = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port,
          auth: { type: "bearer", token: "test-token" },
          publicIntegration: true,
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    const model = createMockModel();
    const agent = defineAgent({ name: "test", model: "mock", augments }, model);
    if (!(await startAgentIfSocketsAvailable(agent))) return;
    try {
      const resp = await fetch(`http://localhost:${port}/agent`, { redirect: "manual" });
      expect(resp.status).toBe(200);
    } finally {
      await agent.stop();
    }
  });

  test("forwards publicFrontendUrl from yaml options to the root redirect", async () => {
    const port = getLikelyFreePort();
    const configs: AugmentConfig[] = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port,
          auth: { type: "bearer", token: "test-token" },
          publicFrontendUrl: "https://store.example.com/",
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    const model = createMockModel();
    const agent = defineAgent({ name: "test", model: "mock", augments }, model);
    if (!(await startAgentIfSocketsAvailable(agent))) return;
    try {
      const response = await fetch(`http://localhost:${port}/`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://store.example.com/");
    } finally {
      await agent.stop();
    }
  });

  // G3 + codex adversarial finding #2: allowAnonymous in agent.yaml MUST be
  // forwarded by the resolver to webTransport, otherwise the documented
  // yaml > env > default precedence is broken end-to-end. This test exercises
  // the full pipeline (yaml options → resolveAugments → defineAgent →
  // listening server) and proves yaml=false rejects no-bearer requests even
  // when NODE_ENV is unset (which would otherwise default-allow anonymous).
  test("allowAnonymous=false from yaml options overrides env-based default", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAnon = process.env.AUGGY_ALLOW_ANONYMOUS;
    // Force the default rule to "allow" so a passthrough bug would let
    // anonymous requests succeed; yaml=false must still gate them.
    delete process.env.NODE_ENV;
    delete process.env.AUGGY_ALLOW_ANONYMOUS;

    const port = getLikelyFreePort();
    try {
      const configs: AugmentConfig[] = [
        {
          name: "web",
          type: "webTransport",
          options: {
            port,
            auth: { type: "bearer", token: "test-token" },
            allowAnonymous: false,
          },
        },
      ];
      const augments = await resolveAugments(configs, TMP);
      const model = createMockModel();
      const agent = defineAgent({ name: "test", model: "mock", augments }, model);
      if (!(await startAgentIfSocketsAvailable(agent))) return;
      try {
        const resp = await fetch(`http://localhost:${port}/agent/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        // Without the resolver forwarding allowAnonymous, env-default would
        // make this 200; with the fix it correctly stays 401.
        expect(resp.status).toBe(401);
      } finally {
        await agent.stop();
      }
    } finally {
      if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
      if (originalAnon !== undefined) process.env.AUGGY_ALLOW_ANONYMOUS = originalAnon;
    }
  });

  // Regression: agentDir must flow through resolveWebTransport →
  // webTransport(...) so the /console module can read .env + identity.md.
  // Without this, the Credentials and Identity tabs render
  // "agent directory not configured" / "agent directory or identity path not
  // configured" errors. End-to-end: scaffold a .env file, hit
  // /console/api/credentials with explicit console auth, assert it returns
  // the parsed entries (not the "not configured" error).
  test("forwards agentDir to webTransport so /console can read .env", async () => {
    const { writeFileSync } = await import("node:fs");
    const port = getLikelyFreePort();
    writeFileSync(`${TMP}/.env`, "FOO=bar\nBAZ=qux\n", "utf-8");
    writeFileSync(
      `${TMP}/agent.yaml`,
      "name: test\nidentity: ./identity.md\nengine:\n  provider: anthropic\n  model: claude-sonnet-4-6\naugments: []\n",
      "utf-8",
    );

    const configs: AugmentConfig[] = [
      {
        name: "web",
        type: "webTransport",
        options: {
          port,
          auth: { type: "bearer", token: "test-token" },
        },
      },
    ];
    const augments = await resolveAugments(configs, TMP);
    const model = createMockModel();
    const agent = defineAgent({ name: "test", model: "mock", augments }, model);
    if (!(await startAgentIfSocketsAvailable(agent))) return;
    try {
      const authorization = `Basic ${Buffer.from(":test-token").toString("base64")}`;
      const resp = await fetch(`http://127.0.0.1:${port}/console/api/credentials`, {
        headers: { authorization },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { error?: string; entries?: unknown[] };
      // The bug surfaced as `{ error: "agent directory not configured" }`.
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.entries)).toBe(true);
      // Auto-generated entries (ANTHROPIC_API_KEY etc.) plus the two we wrote.
      expect((body.entries as Array<{ key: string }>).map((e) => e.key)).toEqual(
        expect.arrayContaining(["FOO", "BAZ"]),
      );
    } finally {
      await agent.stop();
    }
  });

  test("allowAnonymous=true from yaml options admits no-bearer requests even with NODE_ENV=production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAnon = process.env.AUGGY_ALLOW_ANONYMOUS;
    // Force the default rule to "reject"; yaml=true must override.
    process.env.NODE_ENV = "production";
    delete process.env.AUGGY_ALLOW_ANONYMOUS;

    const port = getLikelyFreePort();
    try {
      const configs: AugmentConfig[] = [
        {
          name: "web",
          type: "webTransport",
          options: {
            port,
            auth: { type: "bearer", token: "test-token" },
            allowAnonymous: true,
          },
        },
      ];
      const augments = await resolveAugments(configs, TMP);
      const model = createMockModel({ response: "ok" });
      const agent = defineAgent({ name: "test", model: "mock", augments }, model);
      if (!(await startAgentIfSocketsAvailable(agent))) return;
      try {
        const url = `http://localhost:${port}/agent/run`;
        const init = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        } satisfies RequestInit;
        const bootstrap = await fetch(url, init);
        const session = bootstrap.headers.get("x-auggy-anonymous-session");
        expect(bootstrap.status).toBe(428);
        expect(session).toBeTruthy();
        expect(await bootstrap.json()).toEqual({ error: "anonymous_session_required" });
        expect(model.calls).toHaveLength(0);

        const headers = new Headers(init.headers);
        headers.set("x-auggy-anonymous-session", session ?? "");
        const resp = await fetch(url, { ...init, headers });
        expect(resp.status).toBe(200);
        await resp.text();
        expect(model.calls).toHaveLength(1);
      } finally {
        await agent.stop();
      }
    } finally {
      if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
      else delete process.env.NODE_ENV;
      if (originalAnon !== undefined) process.env.AUGGY_ALLOW_ANONYMOUS = originalAnon;
    }
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

  test("rejects legacy global webFetch headers", async () => {
    await expect(
      resolveAugments(
        [
          {
            name: "fetch",
            type: "webFetch",
            options: {
              defaultHeaders: { authorization: "Bearer GROUP9_WEBFETCH_SENTINEL" },
            },
          },
        ],
        TMP,
      ),
    ).rejects.toThrow(/headersByOrigin/);
  });
});

// ---------------------------------------------------------------------------
// skills (ADR-030)
// ---------------------------------------------------------------------------

describe("resolveAugments — skills", () => {
  test("resolves the skills augment with a relative dir against agentDir", async () => {
    mkdirSync(join(TMP, "skills", "filesystem"), { recursive: true });
    writeFileSync(
      join(TMP, "skills", "filesystem", "SKILL.md"),
      `---\nname: filesystem\ndescription: File operations.\n---\n# body`,
    );

    const configs: AugmentConfig[] = [
      {
        name: "skills",
        type: "skills",
        options: { dir: "./skills" },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("skills");
    expect(augments[0]!.tools ?? []).toHaveLength(0);
    expect(augments[0]!.context).toBeDefined();
  });

  test("defaults dir to ./skills when not specified", async () => {
    mkdirSync(join(TMP, "skills", "memory"), { recursive: true });
    writeFileSync(
      join(TMP, "skills", "memory", "SKILL.md"),
      `---\nname: memory\ndescription: Memory operations.\n---\n# body`,
    );

    const configs: AugmentConfig[] = [
      {
        name: "skills",
        type: "skills",
        options: {},
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("skills");
  });

  test("accepts an absolute dir path unchanged", async () => {
    const abs = join(TMP, "external-skills");
    mkdirSync(join(abs, "demo"), { recursive: true });
    writeFileSync(
      join(abs, "demo", "SKILL.md"),
      `---\nname: demo\ndescription: A demo skill.\n---\n# body`,
    );

    const configs: AugmentConfig[] = [
      {
        name: "skills",
        type: "skills",
        options: { dir: abs },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// synthetic self-inspection
// ---------------------------------------------------------------------------

describe("resolveAugments — self inspection", () => {
  test("appends synthetic creator-only self-inspection only when runtime metadata is provided", async () => {
    let augments = await resolveAugments([], TMP);
    expect(augments.some((augment) => augment.name === "auggySelf")).toBe(false);

    augments = await resolveAugments([], TMP, {
      selfInspection: {
        name: "demo",
        displayName: "Demo",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
        creator: { displayName: "Creator" },
      },
    });

    const self = augments.find((augment) => augment.name === "auggySelf");
    expect(self).toBeDefined();
    expect(self?.synthetic).toBe(true);
    expect(self?.tools?.map((tool) => tool.name)).toEqual([
      "auggy_self_info",
      "auggy_self_catalog",
      "auggy_self_recommend",
    ]);
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
    try {
      expect(augments).toHaveLength(1);
      expect(augments[0]!.name).toBe("budgets");
      expect(augments[0]!.turnGate).toBeDefined();
      // Budgets is not a memory provider.
      expect(augments[0]!.memory).toBeUndefined();
      expect(augments[0]!.onShutdown).toBeDefined();
      expect(augments[0]!.context).toBeDefined();
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
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
    try {
      expect(augments).toHaveLength(1);
      expect(augments[0]!.name).toBe("budgets");
      expect(augments[0]!.turnGate).toBeDefined();
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });

  test("passes agentDir so budgets admin overrides can persist", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: { dbPath: "./budgets-admin.db", dailyBudgetUsd: 5 },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    const budgetAugment = augments[0]!;

    try {
      const result = await budgetAugment.adminActions?.["budget-cap-adjust"]?.({ value: "9" });
      expect(result?.ok).toBe(true);
      const overrideFile = join(TMP, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(overrideFile, "utf-8"));
      expect(parsed.overrides.budgets.dailyBudgetUsd).toBe(9);
    } finally {
      await budgetAugment.onShutdown?.();
    }
  });

  test("routes all runtime overrides to one Railway volume file", async () => {
    const runtimeDataRoot = join(TMP, "railway-overrides");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: { dbPath: "./railway-budgets.db", dailyBudgetUsd: 5 },
      },
      { name: "notify", type: "notify", options: { destinations: [] } },
      {
        name: "mail",
        type: "agentMail",
        options: { apiKey: "am_test", inboxId: "inbox_test" },
      },
      {
        name: "web",
        type: "webTransport",
        options: {
          port: getLikelyFreePort(),
          auth: { type: "bearer", token: "test-token" },
          visitorTokens: { enabled: false },
        },
      },
    ];
    const augments = await resolveAugments(configs, TMP, { runtimeDataRoot });
    const budgets = augments.find((augment) => augment.name === "budgets")!;
    const notify = augments.find((augment) => augment.name === "notify")!;
    const mail = augments.find((augment) => augment.name === "mail")!;
    const web = augments.find((augment) => augment.name === "web")!;

    try {
      expect(await budgets.adminActions?.["budget-cap-adjust"]?.({ value: "9" })).toMatchObject({
        ok: true,
      });
      expect(await notify.adminActions?.["notify-cap-adjust"]?.({ value: "11" })).toMatchObject({
        ok: true,
      });
      expect(await mail.adminActions?.["agentmail-cap-adjust"]?.({ value: "13" })).toMatchObject({
        ok: true,
      });
      expect(await web.adminActions?.["posture-flip"]?.({ value: "true" })).toMatchObject({
        ok: true,
      });

      const volumeOverride = join(runtimeDataRoot, "admin-overrides.json");
      expect(existsSync(join(TMP, "admin-overrides.json"))).toBe(false);
      const fd = openSync(volumeOverride, "r");
      let parsed: AdminOverrides;
      try {
        expect(fstatSync(fd).isFile()).toBe(true);
        parsed = JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
      expect(parsed.overrides.budgets?.dailyBudgetUsd).toBe(9);
      expect(parsed.overrides.notify?.globalMaxPerHour).toBe(11);
      expect(parsed.overrides.agentMail?.globalMaxPerHour).toBe(13);
      expect(parsed.overrides.webTransport?.allowAnonymous).toBe(true);
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });

  test("routes log-to-file notifications into the Railway runtime volume", async () => {
    const runtimeDataRoot = join(TMP, "railway-notify");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const [augment] = await resolveAugments(
      [
        {
          name: "notify",
          type: "notify",
          options: {
            destinations: [
              {
                name: "creator",
                transport: "log-to-file",
                path: "./notifications.jsonl",
                allowedTrustLevels: ["creator"],
              },
            ],
          },
        },
      ],
      TMP,
      { runtimeDataRoot },
    );
    const tool = augment!.tools!.find((candidate) => candidate.name === "notify")!;
    const result = JSON.parse(
      await asStringTool(tool).execute(
        { to: "creator", summary: "durable event" },
        {
          turnId: "notify-turn",
          threadId: "notify-thread",
          peer: {
            id: "creator",
            kind: "human",
            trustLevel: "creator",
            sourceAugment: "console",
          },
        },
      ),
    );
    expect(result.status).toBe("sent");
    expect(readFileSync(join(runtimeDataRoot, "notifications.jsonl"), "utf8")).toContain(
      "durable event",
    );
    expect(existsSync(join(runtimeDataRoot, "notify-notify.db"))).toBe(true);
    expect(existsSync(join(TMP, "notifications.jsonl"))).toBe(false);
    await augment!.onShutdown?.();
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

  test("rejects budgets threshold notifications without a matching notify destination", async () => {
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: {
          dbPath: "./budgets.db",
          dailyBudgetUsd: 1,
          notifications: { destination: "ops", thresholds: [0.8] },
        },
      },
    ];

    await expect(resolveAugments(configs, TMP)).rejects.toThrow(
      'budgets.notifications.destination "ops"',
    );
  });

  test("routes budgets threshold notifications through a notify destination", async () => {
    const logPath = join(TMP, "notifications.jsonl");
    const configs: AugmentConfig[] = [
      {
        name: "budgets",
        type: "budgets",
        options: {
          dbPath: "./budgets-thresholds.db",
          dailyBudgetUsd: 1,
          caps: { public: { recognized: { maxTurnsPerThread: 10 } } },
          notifications: { destination: "ops", thresholds: [0.5, 0.8, 1] },
        },
      },
      {
        name: "notify",
        type: "notify",
        options: {
          destinations: [{ name: "ops", transport: "log-to-file", path: logPath }],
          rateLimit: { enabled: false },
        },
      },
    ];

    const augments = await resolveAugments(configs, TMP);
    const budgetAugment = augments.find((augment) => augment.name === "budgets");
    expect(budgetAugment?.turnGate).toBeDefined();
    const peer = {
      id: "vis-threshold",
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web-transport",
    } as const;
    const threadId = "thread-threshold";
    const turnId = "turn-threshold";

    try {
      const ticket = await budgetAugment!.turnGate!.prepare({
        turnId,
        peer,
        threadId,
        trigger: {
          type: "message",
          turnId,
          threadId,
          timestamp: Date.now(),
          payload: { parts: [], sourceAugment: "web-transport", peer, timestamp: Date.now() },
        },
      });
      expect(ticket.decision.allow).toBe(true);
      await ticket.confirm();
      await budgetAugment!.turnGate!.commit!({
        turnId,
        peer,
        threadId,
        cost: { priced: true, costUsd: 0.85 },
      });

      const record = JSON.parse(readFileSync(logPath, "utf8").trim()) as {
        destination: string;
        summary: string;
        reason: string;
      };
      expect(record.destination).toBe("ops");
      expect(record.summary).toContain("80%");
      expect(record.reason).toContain("$0.85 of $1.00");
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });
});

// ---------------------------------------------------------------------------
// agentMail runtime state paths
// ---------------------------------------------------------------------------

describe("resolveAugments — agentMail runtime state paths", () => {
  test("rejects a relative runtime data root", async () => {
    await expect(
      resolveAugments([agentMailConfig("support")], TMP, {
        runtimeDataRoot: "./railway-data",
      }),
    ).rejects.toThrow(/runtimeDataRoot must be an absolute path/i);
  });

  test("rejects an unsafe instance namespace even when config parsing is bypassed", async () => {
    await expect(
      resolveAugments([agentMailConfig("../support")], TMP, {
        runtimeDataRoot: join(TMP, "railway-data"),
      }),
    ).rejects.toThrow(/not a safe state namespace/i);
  });

  test("resolves scaffold ./agent-mail.db inside the Railway instance state directory", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const augments = await resolveAugments([agentMailConfig("support", "./agent-mail.db")], TMP, {
      runtimeDataRoot,
    });

    try {
      await bootAgentMailAugments(augments);
      expect(existsSync(join(runtimeDataRoot, "agent-mail", "support", "agent-mail.db"))).toBe(
        true,
      );
      expect(existsSync(join(TMP, "agent-mail.db"))).toBe(false);
    } finally {
      await augments[0]?.onShutdown?.();
    }
  });

  test("uses the augment name to isolate two Railway AgentMail ledgers", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const augments = await resolveAugments(
      [agentMailConfig("support"), agentMailConfig("billing")],
      TMP,
      { runtimeDataRoot },
    );

    try {
      await bootAgentMailAugments(augments);
      expect(existsSync(join(runtimeDataRoot, "agent-mail", "support", "agent-mail.db"))).toBe(
        true,
      );
      expect(existsSync(join(runtimeDataRoot, "agent-mail", "billing", "agent-mail.db"))).toBe(
        true,
      );
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });

  test("rejects two inbound AgentMail instances consuming the same inbox", async () => {
    const first = agentMailConfig("support");
    const second = agentMailConfig("billing");
    second.options!.inboxId = first.options!.inboxId;

    await expect(resolveAugments([first, second], TMP)).rejects.toThrow(
      /one inbox may have only one inbound ledger/,
    );
  });

  test("rejects an absolute AgentMail dbPath when a Railway runtime root is active", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    await expect(
      resolveAugments([agentMailConfig("support", join(TMP, "escaped.db"))], TMP, {
        runtimeDataRoot,
      }),
    ).rejects.toThrow(/agentMail.*dbPath.*relative/i);
  });

  test("rejects an AgentMail dbPath that traverses above its Railway namespace", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    await expect(
      resolveAugments([agentMailConfig("support", "../../escaped.db")], TMP, {
        runtimeDataRoot,
      }),
    ).rejects.toThrow(/agentMail.*dbPath.*state directory/i);
  });

  test("rejects an AgentMail dbPath that enters a sibling instance namespace", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    await expect(
      resolveAugments([agentMailConfig("support", "../billing/agent-mail.db")], TMP, {
        runtimeDataRoot,
      }),
    ).rejects.toThrow(/agentMail.*dbPath.*state directory/i);
  });

  test("rejects symlinked directories inside a Railway AgentMail database path", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    const stateDir = join(runtimeDataRoot, "agent-mail", "support");
    const external = join(TMP, "external-mail-state");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(stateDir, "nested"));

    await expect(
      resolveAugments([agentMailConfig("support", "nested/mail.bin")], TMP, {
        runtimeDataRoot,
      }),
    ).rejects.toThrow(/missing or unsafe|must not contain symlinked directories/);
    expect(existsSync(join(external, "mail.bin"))).toBe(false);
    expect(existsSync(join(external, "mail.bin-wal"))).toBe(false);
    expect(existsSync(join(external, "mail.bin-shm"))).toBe(false);
  });

  test("keeps local relative AgentMail dbPath resolution anchored to agentDir", async () => {
    const augments = await resolveAugments(
      [agentMailConfig("support", "./local-state/agent-mail.db")],
      TMP,
    );

    try {
      await bootAgentMailAugments(augments);
      expect(existsSync(join(TMP, "local-state", "agent-mail.db"))).toBe(true);
    } finally {
      await augments[0]?.onShutdown?.();
    }
  });

  test("keeps the local default AgentMail dbPath beside agent.yaml", async () => {
    const augments = await resolveAugments([agentMailConfig("support")], TMP);

    try {
      await bootAgentMailAugments(augments);
      expect(existsSync(join(TMP, "agent-mail.db"))).toBe(true);
    } finally {
      await augments[0]?.onShutdown?.();
    }
  });
});

// ---------------------------------------------------------------------------
// core SQLite runtime state paths
// ---------------------------------------------------------------------------

describe("resolveAugments — core SQLite runtime state paths", () => {
  test("preserves ./data and contained absolute paths without double-rebasing", async () => {
    const runtimeDataRoot = join(TMP, "data");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const augments = await resolveAugments(
      [
        {
          name: "memory",
          type: "layeredMemory",
          options: { backend: "sqlite", dbPath: "./data/memory.db", namespace: "test" },
        },
        {
          name: "budgets",
          type: "budgets",
          options: { dbPath: join(runtimeDataRoot, "budgets.db") },
        },
        {
          name: "visitor-auth",
          type: "visitorAuth",
          options: {
            publicUrl: "https://zip.test",
            dbPath: "./data/visitor-auth.db",
            agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
            signingKey: "sig-x",
            layeredMemoryDbPath: "./data/memory.db",
          },
        },
      ],
      TMP,
      { runtimeDataRoot },
    );

    try {
      expect(existsSync(join(runtimeDataRoot, "memory.db"))).toBe(true);
      expect(existsSync(join(runtimeDataRoot, "budgets.db"))).toBe(true);
      expect(existsSync(join(runtimeDataRoot, "visitor-auth.db"))).toBe(true);
      expect(existsSync(join(runtimeDataRoot, "data"))).toBe(false);
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });

  test("maps ordinary local defaults directly under the runtime root", async () => {
    const runtimeDataRoot = join(TMP, "railway-data");
    mkdirSync(runtimeDataRoot, { recursive: true });
    const augments = await resolveAugments(
      [
        {
          name: "memory",
          type: "layeredMemory",
          options: { backend: "sqlite", namespace: "test" },
        },
        { name: "budgets", type: "budgets", options: {} },
      ],
      TMP,
      { runtimeDataRoot },
    );

    try {
      expect(existsSync(join(runtimeDataRoot, "memory.db"))).toBe(true);
      expect(existsSync(join(runtimeDataRoot, "budgets.db"))).toBe(true);
      expect(existsSync(join(TMP, "memory.db"))).toBe(false);
      expect(existsSync(join(TMP, "budgets.db"))).toBe(false);
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });

  test("rejects a core SQLite absolute path outside the runtime root", async () => {
    const runtimeDataRoot = join(TMP, "data");
    mkdirSync(runtimeDataRoot, { recursive: true });
    await expect(
      resolveAugments(
        [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: join(TMP, "escaped.db") },
          },
        ],
        TMP,
        { runtimeDataRoot },
      ),
    ).rejects.toThrow(/budgets dbPath.*runtime data root/i);
  });

  test("rejects an owned state path outside the local agent directory", async () => {
    const escapedPath = join(TMP, "..", ".tmp-other-agent-budget.db");
    try {
      await expect(
        resolveAugments(
          [
            {
              name: "budgets",
              type: "budgets",
              options: { dbPath: escapedPath },
            },
          ],
          TMP,
          { agentId: AGENT_ID },
        ),
      ).rejects.toThrow(/budgets dbPath.*state directory/i);
    } finally {
      rmSync(escapedPath, { force: true });
      rmSync(`${escapedPath}-shm`, { force: true });
      rmSync(`${escapedPath}-wal`, { force: true });
    }
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

  test("wires protected console identity summary lookup into webTransport", async () => {
    const port = getLikelyFreePort();
    const signingKey = "resolver-visitor-summary-signing-key";
    const agentBinding = "resolver-visitor-summary";
    const visitorId = "vis_resolver_summary";
    const bearer = "resolver-visitor-summary-bearer";
    const dbPath = join(TMP, "visitor-summary.db");
    const augments = await resolveAugments(
      [
        {
          type: "visitorAuth",
          name: "custom-visitor-auth",
          options: {
            publicUrl: `http://127.0.0.1:${port}`,
            dbPath,
            agentMail: { transport: "console" },
            signingKey,
            agentBinding,
            layeredMemoryDbPath: null,
            allowConsoleInProduction: true,
          },
        },
        {
          type: "webTransport",
          name: "web",
          options: {
            port,
            auth: { type: "bearer", token: bearer },
            visitorTokens: { agentBinding },
          },
        },
      ],
      TMP,
    );

    const store = createSqliteVisitorAuthStore({ dbPath });
    store.initialize();
    store.recordVerifiedVisitor({
      visitorId,
      email: "resolver@example.com",
      verifiedAt: Date.now(),
      lastSeenAt: Date.now(),
      reverifyDueAt: Date.now() + 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    store.close();

    const model = createMockModel();
    const agent = defineAgent({ name: agentBinding, model: "mock", augments }, model);
    if (!(await startAgentIfSocketsAvailable(agent))) return;
    try {
      const key = await deriveSigningKey(signingKey);
      const visitorToken = await createVisitorToken(key, agentBinding, 3_600, visitorId);
      const csrf = await generateCsrfToken({
        bearer,
        agentName: agentBinding,
        actionId: "console-chat",
      });
      const response = await fetch(`http://127.0.0.1:${port}/console/api/visitor-identity`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrf, visitorToken: visitorToken.token }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        identity: {
          status: "verified",
          email: "resolver@example.com",
          expiresAt: visitorToken.payload.expiresAt,
        },
      });
    } finally {
      await agent.stop();
    }
  });

  // G34: agentMail.transport flows through opts.agentMail without resolver
  // change; allowConsoleInProduction must be explicitly forwarded. This test
  // proves the full yaml → resolver → factory wiring of both fields by
  // setting NODE_ENV=production and observing that the factory succeeds
  // (operator opted in) rather than throwing (which would happen if
  // allowConsoleInProduction was silently dropped).
  test("forwards agentMail.transport='console' and allowConsoleInProduction through to the factory", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const augments = await resolveAugments(
        [
          {
            type: "visitorAuth",
            name: "visitor-auth",
            options: {
              publicUrl: "https://demo.test",
              agentMail: { transport: "console" },
              signingKey: "sig-x",
              layeredMemoryDbPath: null,
              allowConsoleInProduction: true,
            },
          },
        ],
        TMP,
      );
      expect(augments).toHaveLength(1);
      expect(augments[0]?.name).toBe("visitor-auth");
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("dropping allowConsoleInProduction in the resolver would surface as a factory throw under NODE_ENV=production", async () => {
    // Regression guard: prove the production safeguard fires when the override
    // is absent. If the resolver ever silently swallowed the field, this test
    // would still throw (factory-level check), but it documents the contract.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        resolveAugments(
          [
            {
              type: "visitorAuth",
              name: "visitor-auth",
              options: {
                publicUrl: "https://demo.test",
                agentMail: { transport: "console" },
                signingKey: "sig-x",
                layeredMemoryDbPath: null,
                // allowConsoleInProduction intentionally omitted
              },
            },
          ],
          TMP,
        ),
      ).rejects.toThrow(/transport="console" is rejected at boot because/);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// C1 wiring: visitorAuth revocation check survives operator rename (fix F17)
// ---------------------------------------------------------------------------

describe("resolveAugments — C1 wiring (fix F17)", () => {
  test("C1 wiring survives operator-renamed visitorAuth augment — revocation closure actually works", async () => {
    // Before F17: `augments.find(a => a.name === "visitor-auth")` returns undefined
    // for a renamed augment, leaving lateBindings.revocationCheck null. The closure
    // passed to webTransport always returns false. Revoked visitors still authenticate.
    //
    // After F17: lookup uses type-index correspondence. lateBindings.revocationCheck
    // is set to va.isVisitorRevoked. Revoked visitors return 401 / stay anonymous.
    //
    // This test mints a real visitor token, starts an agent, makes an HTTP request
    // with that token, and asserts that revocation is enforced. If F17 is reverted,
    // the revocationCheck closure is null → revoked visitors still get recognized →
    // no new x-visitor-token is issued → the assertion at the end fails.
    const SIGNING_KEY = "f17-regression-test-signing-key";
    const PORT = getLikelyFreePort();

    // Mint a visitor token using the shared signing key.
    const cryptoKey = await deriveSigningKey(SIGNING_KEY);
    const VISITOR_ID = `vis_f17_regression_${Date.now()}`;
    const { token: visitorToken } = await createVisitorToken(
      cryptoKey,
      "f17-test",
      86_400, // 24h TTL
      VISITOR_ID,
    );

    const configs: AugmentConfig[] = [
      {
        type: "visitorAuth",
        name: "my-custom-auth", // operator-chosen name — NOT "visitor-auth"
        options: {
          publicUrl: "https://zip.test",
          // Point AgentMail at a closed port so the boot healthcheck (F9) hits
          // a network-error path (no httpStatus) and warn-and-continues, rather
          // than reaching the real api.agentmail.to and getting a 403 (which
          // F9 escalates to a hard error). The healthcheck is incidental to
          // what this test exercises (F17 closure wiring).
          agentMail: {
            apiKey: "am_x",
            inboxId: "ibx_x",
            apiBaseUrl: "http://127.0.0.1:1/agentmail-unreachable",
          },
          signingKey: SIGNING_KEY,
          agentBinding: "f17-test",
          layeredMemoryDbPath: null,
          // Use the test's TMP dir for the VA DB.
          dbPath: join(TMP, "f17-va.db"),
        },
      },
      {
        type: "webTransport",
        name: "web",
        options: {
          port: PORT,
          auth: { type: "bearer", token: "tok-f17" },
          // visitorTokens.enabled is intentionally left unset → auto-enabled
          // by the resolver when visitorAuth is present.
        },
      },
    ];

    const resolvedAugments = await resolveAugments(configs, TMP);
    expect(resolvedAugments).toHaveLength(2);

    // Get the resolved visitorAuth augment to call isVisitorRevoked.
    const va = resolvedAugments[0] as (typeof resolvedAugments)[0] & {
      isVisitorRevoked: (id: string) => boolean;
    };
    expect(typeof va.isVisitorRevoked).toBe("function");

    // The VISITOR_ID is NOT in the va DB yet → isVisitorRevoked returns false.
    // (No row = unknown visitor = not revoked.)
    expect(va.isVisitorRevoked(VISITOR_ID)).toBe(false);

    const model = createMockModel({ response: "hello" });
    const agent = defineAgent(
      { name: "f17-test", model: "mock", augments: resolvedAugments },
      model,
    );
    if (!(await startAgentIfSocketsAvailable(agent))) return;

    try {
      // Request with a valid visitor token for VISITOR_ID (not yet revoked).
      // A recognized visitor does NOT get a new x-visitor-token header.
      // No bearer — under codex R6 fix, the mint logic is suppressed for
      // bearer-credentialed requests (closes the creator-to-visitor demotion
      // loop). allowAnonymous defaults true in test env, and the valid
      // visitor token routes to Path 3 (recognized) on its own.
      const recognizedResp = await fetch(`http://localhost:${PORT}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": visitorToken,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      });
      expect(recognizedResp.status).toBe(200);
      // A recognized visitor does NOT get a new token (no new issuance on recognized path).
      const _tokenOnRecognized = recognizedResp.headers.get("x-visitor-token");
      // We can't assert exact null here because issuance rules depend on config,
      // but we CAN assert va.isVisitorRevoked was NOT returning true at this point.
      await recognizedResp.text();

      // Now spy on isVisitorRevoked to force it to return true for VISITOR_ID.
      // This simulates the visitor being revoked (e.g., via `auggy visitors --revoke`).
      // The spy MUST be called by the closure IF F17 wiring is correct.
      const _originalIsRevoked = va.isVisitorRevoked.bind(va);
      const _wasCalledWithVisitorId = false;
      // Temporarily replace isVisitorRevoked on the va object to track calls.
      // Note: the bound function in lateBindings captures `va.isVisitorRevoked.bind(va)`,
      // NOT a getter — so we can't spy post-binding. Instead we verify behavior:
      // with F17's fix, the revocationCheck closure calls the va method via lateBindings.
      // We test this indirectly: for a REVOKED visitor, an HTTP request must treat
      // them as anonymous (428 session bootstrap = anonymous path).
      //
      // To revoke, we use a second va instance backed by the SAME DB file and call
      // its isVisitorRevoked to verify the revoking works — but for the HTTP assertion,
      // we rely on the actual revocation being persisted to the DB. Since VISITOR_ID
      // was never inserted into the verified_visitors table (we minted the token
      // directly, bypassing the magic-link flow), visitorAuth's isVisitorRevoked
      // reads from the DB and finds no row → returns false → visitor is recognized.
      //
      // The key assertion for F17: the revocationCheck closure was wired (not null).
      // We confirm this via the first request above succeeding with recognized path.
      // If F17 was reverted (lateBindings.revocationCheck is null), the revocation
      // check would be skipped entirely — same behavior as "not revoked".
      //
      // For a definitive gate: insert the visitor into the DB as revoked, then make
      // a second request, and assert the anonymous-session bootstrap is required.
      // This requires DB-level access. Use createSqliteVisitorAuthStore from the store.
      const { createSqliteVisitorAuthStore } = await import(
        "../../src/augments/visitorAuth/storage/sqlite-store"
      );
      const seedStore = createSqliteVisitorAuthStore({
        dbPath: join(TMP, "f17-va.db"),
      });
      seedStore.initialize();
      // Insert and immediately revoke the visitor row.
      const now = Date.now();
      seedStore.recordVerifiedVisitor({
        email: "f17-test@example.com",
        visitorId: VISITOR_ID,
        verifiedAt: now,
        lastSeenAt: now,
        reverifyDueAt: now + 86_400_000 * 90,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      seedStore.revokeByEmail("f17-test@example.com", "test", now);
      seedStore.close();

      // VISITOR_ID is now revoked in the DB. isVisitorRevoked must return true.
      expect(va.isVisitorRevoked(VISITOR_ID)).toBe(true);

      // Second request with the same token for REVOKED visitor.
      // With F17 wired: revocationCheck returns true → visitorPayload = null →
      //   visitor stays anonymous → 428 + x-auggy-anonymous-session.
      // Without F17 wired (reverted): revocationCheck is null → visitor is
      //   STILL recognized (wrong!) → 200 execution → assertion fails.
      const revokedResp = await fetch(`http://localhost:${PORT}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-visitor-token": visitorToken,
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "revoked" }] }),
      });
      expect(revokedResp.status).toBe(428);
      expect(revokedResp.headers.get("x-visitor-token")).toBeNull();
      expect(revokedResp.headers.get("x-auggy-anonymous-session")).toBeTruthy();
      expect(await revokedResp.json()).toEqual({ error: "anonymous_session_required" });
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-instance visitorAuth hard error (fix F18)
// ---------------------------------------------------------------------------

describe("resolveAugments — multi-instance visitorAuth hard error (fix F18)", () => {
  test("throws when multiple visitorAuth augments declared", async () => {
    // Two visitorAuth blocks — unsupported. Both would register GET/POST
    // /visitor-auth/verify routes (route-collector would reject the duplicate),
    // so the resolver must throw a hard error before runtime begins.
    await expect(
      resolveAugments(
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
      ),
    ).rejects.toThrow(/Multiple visitorAuth/);
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

  test("replaces mutable visitor audiences with the immutable agent id", async () => {
    const configs = [vaConfig("copied-name"), wtConfig("copied-name")];
    const augments = await resolveAugments(configs, TMP, { agentId: AGENT_ID });

    expect(augments).toHaveLength(2);
    expect((configs[0]!.options as Record<string, unknown>).agentBinding).toBe(AGENT_ID);
    const webOptions = configs[1]!.options as Record<string, unknown>;
    expect(webOptions.securityNamespace).toBe(AGENT_ID);
    expect((webOptions.visitorTokens as Record<string, unknown>).agentBinding).toBe(AGENT_ID);
  });

  test("injects an explicit visitorAuth binding into webTransport when omitted", async () => {
    const configs = [vaConfig("agent-A"), wtConfig(undefined)];
    const augments = await resolveAugments(configs, TMP);
    expect(augments).toHaveLength(2);
    expect(
      ((configs[1]!.options as Record<string, unknown>).visitorTokens as Record<string, unknown>)
        .agentBinding,
    ).toBe("agent-A");
  });

  test("checks every webTransport for an agentBinding mismatch", async () => {
    const first = wtConfig("agent-A");
    first.name = "web-primary";
    const second = wtConfig("agent-B");
    second.name = "web-secondary";
    await expect(resolveAugments([vaConfig("agent-A"), first, second], TMP)).rejects.toThrow(
      /web-secondary.*agentBinding/,
    );
  });

  test("rejects a securityNamespace that overrides the visitor binding", async () => {
    const web = wtConfig("agent-A");
    web.options = { ...web.options, securityNamespace: "agent-B" };
    await expect(resolveAugments([vaConfig("agent-A"), web], TMP)).rejects.toThrow(
      /securityNamespace.*agent-B/,
    );
  });

  test("requires explicit matching bindings instead of a shared default", async () => {
    await expect(resolveAugments([vaConfig(undefined), wtConfig(undefined)], TMP)).rejects.toThrow(
      /explicitly configured/,
    );
    const injected = [vaConfig("auggy"), wtConfig(undefined)];
    await expect(resolveAugments(injected, TMP)).resolves.toHaveLength(2);
    expect(
      ((injected[1]!.options as Record<string, unknown>).visitorTokens as Record<string, unknown>)
        .agentBinding,
    ).toBe("auggy");
    await expect(resolveAugments([vaConfig(undefined), wtConfig("auggy")], TMP)).rejects.toThrow(
      /explicitly configured/,
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
        agentBinding: "resolver-test-agent",
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
    const configs: AugmentConfig[] = [wtConfigBase({ visitorTokens: {} })];
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

// ---------------------------------------------------------------------------
// Fix 7 (Opus F5): identity-loss visibility when visitorAuth is removed but
// webTransport's visitorTokens.signingKey is still set
// ---------------------------------------------------------------------------

describe("resolveAugments — identity-loss warning when visitorAuth removed (fix F5/Opus)", () => {
  test("warns when webTransport has signingKey set but visitorAuth is absent", async () => {
    // Scenario: operator previously had visitorAuth mounted and removed it from
    // agent.yaml between boots, but forgot to remove signingKey from webTransport's
    // visitorTokens block. Previously-issued tokens would stop verifying (no minter
    // registered, and webTransport can't verify tokens it didn't issue), but the
    // operator gets no signal about this identity loss.
    //
    // The resolver must warn loudly so the operator can take corrective action
    // (either re-mount visitorAuth or remove the stale signingKey).
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const configs: AugmentConfig[] = [
        {
          type: "webTransport",
          name: "web",
          options: {
            port: 9124,
            auth: { type: "bearer", token: "tok" },
            visitorTokens: {
              // signingKey is set (operator had visitorAuth before) but no visitorAuth
              // is mounted in this boot — all previously-issued tokens are stranded.
              signingKey: "orphaned-signing-key",
            },
          },
        },
      ];
      await resolveAugments(configs, TMP);
      const warnCalls = warnSpy.mock.calls;
      const identityLossWarn = warnCalls.find(
        (args) => typeof args[0] === "string" && /no visitorAuth augment is mounted/.test(args[0]),
      );
      expect(identityLossWarn).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
