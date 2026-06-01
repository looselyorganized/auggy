/**
 * Tests for the knowledge augment.
 *
 * Coverage map (per α-6 spec / Codex review focus #3):
 *   - Positive cases: file:// (absolute + relative-via-resolver) manifest read,
 *     knowledge_fetch under file:// (literal + .md fallback), HTTP backward compat
 *   - Path-traversal attacks (must REJECT): `..`, double-`..`, deep-`..`,
 *     URL-encoded `..`, double-encoded `..`, absolute-looking path,
 *     mid-path `..`, double slash, null byte, symlink escape
 *   - Edge cases: missing file, directory-instead-of-file, malformed manifest JSON
 *   - End-to-end: scaffolded manifest/ dir + file://./manifest resolution
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { knowledge, isWithinBase } from "@/augments/knowledge";
import { resolveAugments } from "@/cli/augment-resolver";
import { createTempDir } from "@tests/fixtures/temp-dir";
import { asStringTool } from "@tests/fixtures/tool-helpers";
import type { Augment, ContextBlock, TurnState } from "@/types";
import type { HttpClient, HttpResponse } from "@/http";

// ---------------------------------------------------------------------------
// Test stubs
// ---------------------------------------------------------------------------

const stubTurn: TurnState = {
  turnId: "t1",
  threadId: "th1",
  trigger: {
    type: "message",
    turnId: "t1",
    timestamp: Date.now(),
    payload: {} as never,
  },
  peer: null,
  toolCallsSoFar: 0,
  turnStartedAt: Date.now(),
  metadata: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run knowledge_fetch on the given augment, returning the parsed JSON envelope. */
async function callManifestFetch(
  aug: Augment,
  endpoint: string,
  prompt?: string,
): Promise<Record<string, unknown>> {
  const tool = aug.tools!.find((t) => t.name === "knowledge_fetch");
  if (!tool) throw new Error("knowledge_fetch tool not found on augment");
  const result = await asStringTool(tool).execute(prompt ? { endpoint, prompt } : { endpoint });
  return JSON.parse(result) as Record<string, unknown>;
}

/** Get the rendered manifest context block (or null if no manifest loaded). */
async function getManifestBlock(aug: Augment): Promise<ContextBlock | null> {
  if (!aug.context) return null;
  const out = await aug.context(stubTurn, undefined);
  if (typeof out === "string") return null;
  return out[0] ?? null;
}

/** Construct a minimal manifest object. */
function defaultManifest(): Record<string, unknown> {
  return {
    org: "Test Org",
    purpose: "for testing only",
    operator: "the operator",
    phase: "active",
    endpoints: [
      { path: "/mission", description: "Org mission and active focus" },
      { path: "/team", description: "People and roles" },
    ],
  };
}

/**
 * Construct a manifest that intentionally lists traversal-shaped /
 * suspicious paths. Used by the High-2 defense-in-depth tests: a manifest
 * that lists `/../etc/passwd` would bypass the High-1 allowlist, so we
 * MUST also reject the path at the safeResolveUnderBase layer.
 */
function suspiciousManifest(extra: ManifestEntry[]): Record<string, unknown> {
  return {
    org: "Test Org",
    purpose: "for testing only",
    operator: "the operator",
    phase: "active",
    endpoints: [
      { path: "/mission", description: "Org mission and active focus" },
      { path: "/team", description: "People and roles" },
      ...extra,
    ],
  };
}

interface ManifestEntry {
  path: string;
  description: string;
  method?: string;
}

/** Write a fully-stocked example manifest dir under `baseDir`. */
async function writeExampleManifest(baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, "manifest"), `${JSON.stringify(defaultManifest(), null, 2)}\n`);
  await writeFile(join(baseDir, "mission.md"), "# Test Org — Mission\n\nfor testing only\n");
  await writeFile(join(baseDir, "team.md"), "# Test Org — Team\n\n- the operator (operator)\n");
}

/**
 * Overwrite the manifest at `<baseDir>/manifest` with the given suspicious
 * entries appended. Used by High-2 defense-in-depth tests to force the
 * allowlist past traversal-shaped paths so the lower-layer rejection fires.
 */
async function writeManifestWithEntries(baseDir: string, extra: ManifestEntry[]): Promise<void> {
  await writeFile(
    join(baseDir, "manifest"),
    `${JSON.stringify(suspiciousManifest(extra), null, 2)}\n`,
  );
}

// ---------------------------------------------------------------------------
// isWithinBase — unit tests for the boundary helper
// ---------------------------------------------------------------------------

describe("isWithinBase", () => {
  it("accepts the base dir itself", () => {
    expect(isWithinBase("/tmp/base", "/tmp/base")).toBe(true);
  });

  it("accepts descendants of the base", () => {
    expect(isWithinBase("/tmp/base/file", "/tmp/base")).toBe(true);
    expect(isWithinBase("/tmp/base/sub/file", "/tmp/base")).toBe(true);
  });

  it("rejects siblings that share a prefix", () => {
    // The classic startsWith() naive-prefix bug: /tmp/base-attacker should
    // NOT match /tmp/base.
    expect(isWithinBase("/tmp/base-attacker", "/tmp/base")).toBe(false);
    expect(isWithinBase("/tmp/base-attacker/secret", "/tmp/base")).toBe(false);
  });

  it("rejects parent escapes", () => {
    expect(isWithinBase("/tmp/other", "/tmp/base")).toBe(false);
    expect(isWithinBase("/etc/passwd", "/tmp/base")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// file:// scheme — positive cases
// ---------------------------------------------------------------------------

describe("manifest file:// scheme", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };
  let baseDir: string;
  let baseUrl: string;

  // Silence the warn output the augment emits on graceful failure paths so
  // the test runner output stays clean. We re-enable per-test where the
  // assertion specifically wants to inspect a warning.
  const originalWarn = console.warn;
  const originalLog = console.log;

  beforeEach(async () => {
    tmp = await createTempDir();
    baseDir = join(tmp.path, "knowledge");
    baseUrl = pathToFileURL(baseDir).href;
    await writeExampleManifest(baseDir);
    console.warn = mock(() => {});
    console.log = mock(() => {});
  });

  afterEach(async () => {
    console.warn = originalWarn;
    console.log = originalLog;
    await tmp.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Positive cases (1-4)
  // ---------------------------------------------------------------------------

  it("reads manifest from file:///<absolute-path>", async () => {
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Test Org");
    expect(block!.content).toContain("for testing only");
    expect(block!.content).toContain("/mission");
    expect(block!.content).toContain("/team");
    expect(block!.placement).toBe("system");
  });

  it("resolves file://./relative paths via the augment-resolver against agentDir", async () => {
    // The resolver turns the configured knowledge root into a mounted
    // knowledge augment; source-local file:// URLs resolve relative to that
    // root before the child augment is constructed.
    await writeFile(
      join(baseDir, "sources.json"),
      `${JSON.stringify({ sources: [{ name: "local", baseUrl: "file://." }] }, null, 2)}\n`,
    );
    const augments = await resolveAugments(
      [
        {
          name: "org",
          type: "knowledge",
          options: { root: "./knowledge" },
        },
      ],
      tmp.path,
    );
    expect(augments).toHaveLength(1);
    const aug = augments[0]!;
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Test Org");
  });

  it("knowledge_fetch reads /mission via the .md fallback", async () => {
    const aug = knowledge({ baseUrl });
    // Prime the manifest so the augment's base-dir cache populates.
    await getManifestBlock(aug);
    const result = await callManifestFetch(aug, "/mission");
    expect(result.endpoint).toBe("/mission");
    expect(result.content).toContain("Test Org — Mission");
  });

  it("HTTP baseUrl path is unchanged (backward compat)", async () => {
    function fakeResponse(body: string, status = 200): HttpResponse {
      return {
        finalUrl: "https://example.com/x",
        status,
        statusText: status === 200 ? "OK" : "Not Found",
        contentType: "application/json",
        headers: new Headers(),
        body,
      };
    }
    const fakeClient: HttpClient = {
      request: async () => fakeResponse(""),
      get: mock(async (url: string) => {
        if (url.endsWith("/manifest")) {
          return fakeResponse(JSON.stringify(defaultManifest()));
        }
        if (url.endsWith("/mission")) {
          return fakeResponse(
            JSON.stringify({ files: [{ name: "mission.md", content: "Mission body" }] }),
          );
        }
        return fakeResponse("not found", 404);
      }),
      post: async () => fakeResponse(""),
      put: async () => fakeResponse(""),
      delete: async () => fakeResponse(""),
      head: async () => fakeResponse(""),
    };
    const aug = knowledge({ baseUrl: "https://example.com", client: fakeClient });
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Test Org");
    const fetched = await callManifestFetch(aug, "/mission");
    expect(fetched.endpoint).toBe("/mission");
    expect(fetched.content).toContain("Mission body");
  });

  // ---------------------------------------------------------------------------
  // Path-traversal attacks (5-14) — all must REJECT
  // ---------------------------------------------------------------------------

  // The augment treats endpoint paths as `/`-rooted under the configured
  // base dir (the URL-style convention the manifest uses: `/mission`,
  // `/team`, etc.). The augment now enforces TWO independent defenses:
  //
  // High-1: manifest allowlist. Every requested path must match
  // `manifest.endpoints[].path` exactly. Unlisted paths (including
  // /etc/passwd, /../etc/passwd, /no-such-endpoint, etc.) are refused
  // before any filesystem call. The default test manifest lists only
  // /mission and /team, so all the traversal-shape inputs in this section
  // hit the allowlist refusal first — and that refusal IS a rejection.
  //
  // High-2: fail-closed traversal rejection inside safeResolveUnderBase.
  // Defense-in-depth in case the manifest ever lists a traversal-shape
  // path. Tests below at "high-2 defense-in-depth" intentionally allowlist
  // suspicious paths so the lower layer fires.
  //
  // Each of these cases asserts the security property directly: the
  // response is an error envelope of rejection class, and no outside-base
  // content leaks into the tool result.

  /** Asserts that the response is a rejection-shaped error envelope with no /etc/passwd leak. */
  function expectNoLeak(res: Record<string, unknown>): void {
    expect(res.error).toBeDefined();
    expect(typeof res.error).toBe("string");
    // The error message must explicitly indicate rejection — either by the
    // High-1 allowlist ("refused") or by the High-2 traversal layer
    // ("rejected" / "traversal"). The test names say "rejects X (no leak)";
    // the assertion now matches the test name.
    expect(res.error as string).toMatch(/refused|rejected|traversal/i);
    // /etc/passwd lines start with "root:" on POSIX — load-bearing canary.
    expect(JSON.stringify(res)).not.toContain("root:");
    // No content field should be present on an error envelope.
    expect(res.content).toBeUndefined();
  }

  it("rejects /../etc/passwd (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /../../etc/passwd (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/../../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /../../../../../etc/passwd deep escape (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/../../../../../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /%2e%2e/etc/passwd URL-encoded `..` (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    // Single-decoded once: "%2e%2e" → ".." → normalize collapses against
    // the leading slash → resolved path is inside the base → ENOENT.
    const res = await callManifestFetch(aug, "/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /%252e%252e/etc/passwd double-encoded (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    // Decode-once policy: "%252e%252e" → "%2e%2e" (NOT "..").
    // Stays as a literal segment under the base → ENOENT, no escape.
    const res = await callManifestFetch(aug, "/%252e%252e/etc/passwd");
    expectNoLeak(res);
  });

  it("rejects an absolute-looking endpoint /etc/passwd (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    // Manifest convention: `/`-prefix means "rooted at base". The leading
    // `/` is stripped before join, so this becomes `<base>/etc/passwd`
    // (which doesn't exist) — read fails cleanly with ENOENT.
    const res = await callManifestFetch(aug, "/etc/passwd");
    expectNoLeak(res);
  });

  it("rejects mid-path traversal /foo/../../etc/passwd (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/foo/../../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects double-slash //etc/passwd (no leak)", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "//etc/passwd");
    expectNoLeak(res);
  });

  it("rejects null-byte injection \\0bad", async () => {
    // Allowlist the path so the High-1 check passes; defense-in-depth at
    // the null-byte layer in safeResolveUnderBase must still fire.
    await writeManifestWithEntries(baseDir, [{ path: "/\0bad", description: "test" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/\0bad");
    expect(res.error as string).toMatch(/null byte/i);
  });

  it("rejects URL-encoded null byte %00", async () => {
    // Same defense-in-depth posture: allowlist the literal request path so
    // the null-byte-after-decode rejection inside safeResolveUnderBase fires.
    await writeManifestWithEntries(baseDir, [{ path: "/safe%00.md", description: "test" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/safe%00.md");
    expect(res.error as string).toMatch(/null byte/i);
  });

  it("rejects symlink escape (symlink inside base pointing outside)", async () => {
    // Build a symlink inside the base dir pointing at /etc. Any request
    // through that symlink must be caught by the realpath boundary check.
    const evilLink = join(baseDir, "evil-link");
    // /etc exists on macOS/Linux; on Windows we'd need a different target.
    // The augment / Auggy targets POSIX-only at v1.0 so this is fine.
    await symlink("/etc", evilLink);
    // Allowlist `/evil-link/passwd` so the High-1 allowlist passes — this
    // test is exercising the realpath boundary check (defense-in-depth).
    await writeManifestWithEntries(baseDir, [
      { path: "/evil-link/passwd", description: "deliberately suspicious" },
    ]);

    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    // The literal request path under the base is `/evil-link/passwd`.
    // safeResolveUnderBase joins to `<base>/evil-link/passwd`, then
    // realpath resolves the symlink → `/etc/passwd`, which is OUTSIDE
    // realBase. The boundary check rejects.
    const res = await callManifestFetch(aug, "/evil-link/passwd");
    expect(res.error as string).toMatch(/rejected|traversal/i);
  });

  // ---------------------------------------------------------------------------
  // High-1: manifest allowlist (file:// branch)
  //
  // Per spec §Decision 9, the manifest is the authoritative endpoint
  // contract. knowledge_fetch must refuse any path that isn't listed in
  // manifest.endpoints[].path (strict equality, no prefix matching). When
  // no manifest is loaded at all (file unreadable / HTTP 404 / network
  // failure) every fetch must be refused with a clear error so the model
  // doesn't fall through to filesystem reads on an undefined contract.
  // ---------------------------------------------------------------------------

  it("allowlist (file://): knowledge_fetch refuses an unlisted path", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/unlisted");
    expect(res.error as string).toMatch(/not in the manifest/i);
    expect(res.content).toBeUndefined();
  });

  it("allowlist (file://): knowledge_fetch allows a listed path", async () => {
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/mission");
    expect(res.error).toBeUndefined();
    expect(res.endpoint).toBe("/mission");
    expect(res.content as string).toContain("Test Org — Mission");
  });

  it("allowlist (file://): knowledge_fetch refuses when no manifest is loaded", async () => {
    // Empty base dir — manifest file doesn't exist; fetchManifest returns null.
    const emptyDir = join(tmp.path, "empty-org");
    await mkdir(emptyDir, { recursive: true });
    const aug = knowledge({ baseUrl: pathToFileURL(emptyDir).href });
    // Don't call getManifestBlock — leave cachedManifest null.
    const res = await callManifestFetch(aug, "/mission");
    expect(res.error as string).toMatch(/no manifest loaded/i);
    expect(res.content).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // High-1: manifest allowlist (HTTP branch)
  // ---------------------------------------------------------------------------

  it("allowlist (HTTP): knowledge_fetch refuses an unlisted path", async () => {
    function fakeResponse(body: string, status = 200): HttpResponse {
      return {
        finalUrl: "https://example.com/x",
        status,
        statusText: status === 200 ? "OK" : "Not Found",
        contentType: "application/json",
        headers: new Headers(),
        body,
      };
    }
    const fakeClient: HttpClient = {
      request: async () => fakeResponse(""),
      get: mock(async (url: string) => {
        if (url.endsWith("/manifest")) {
          return fakeResponse(JSON.stringify(defaultManifest()));
        }
        // Should never reach here for the unlisted path — allowlist refuses
        // before the HTTP call is made. If it does, return a recognizable
        // payload so the assertion can detect the bypass.
        return fakeResponse("LEAK: unlisted reached the HTTP layer", 200);
      }),
      post: async () => fakeResponse(""),
      put: async () => fakeResponse(""),
      delete: async () => fakeResponse(""),
      head: async () => fakeResponse(""),
    };
    const aug = knowledge({ baseUrl: "https://example.com", client: fakeClient });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/unlisted");
    expect(res.error as string).toMatch(/not in the manifest/i);
    expect(JSON.stringify(res)).not.toContain("LEAK");
  });

  it("allowlist (HTTP): knowledge_fetch allows a listed path", async () => {
    function fakeResponse(body: string, status = 200): HttpResponse {
      return {
        finalUrl: "https://example.com/x",
        status,
        statusText: status === 200 ? "OK" : "Not Found",
        contentType: "application/json",
        headers: new Headers(),
        body,
      };
    }
    const fakeClient: HttpClient = {
      request: async () => fakeResponse(""),
      get: mock(async (url: string) => {
        if (url.endsWith("/manifest")) {
          return fakeResponse(JSON.stringify(defaultManifest()));
        }
        if (url.endsWith("/mission")) {
          return fakeResponse(
            JSON.stringify({ files: [{ name: "mission.md", content: "Mission body" }] }),
          );
        }
        return fakeResponse("not found", 404);
      }),
      post: async () => fakeResponse(""),
      put: async () => fakeResponse(""),
      delete: async () => fakeResponse(""),
      head: async () => fakeResponse(""),
    };
    const aug = knowledge({ baseUrl: "https://example.com", client: fakeClient });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/mission");
    expect(res.error).toBeUndefined();
    expect(res.endpoint).toBe("/mission");
    expect(res.content as string).toContain("Mission body");
  });

  it("allowlist (HTTP): knowledge_fetch refuses when no manifest is loaded", async () => {
    // /manifest returns 404 — fetchManifest returns null, allowlist refuses.
    function fakeResponse(body: string, status = 200): HttpResponse {
      return {
        finalUrl: "https://example.com/x",
        status,
        statusText: status === 200 ? "OK" : "Not Found",
        contentType: "application/json",
        headers: new Headers(),
        body,
      };
    }
    const fakeClient: HttpClient = {
      request: async () => fakeResponse(""),
      get: mock(async () => fakeResponse("not found", 404)),
      post: async () => fakeResponse(""),
      put: async () => fakeResponse(""),
      delete: async () => fakeResponse(""),
      head: async () => fakeResponse(""),
    };
    const aug = knowledge({ baseUrl: "https://example.com", client: fakeClient });
    // Don't call getManifestBlock — leave cachedManifest null even after the
    // first allowlist check forces a fetch (which 404s and returns null).
    const res = await callManifestFetch(aug, "/mission");
    expect(res.error as string).toMatch(/no manifest loaded/i);
    expect(res.content).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // High-2: defense-in-depth — traversal rejection inside safeResolveUnderBase
  //
  // Layering: allowlist runs first (in fetchFromFile) so a model-supplied
  // traversal-shape path is normally caught by High-1. These tests
  // INTENTIONALLY allowlist suspicious paths to bypass High-1, exercising
  // the lower-layer rejection. The motivation: in a future code path or
  // misconfiguration where the manifest itself contains a traversal shape,
  // the augment must still refuse.
  // ---------------------------------------------------------------------------

  it("traversal layer: rejects /../etc/passwd even when allowlisted", async () => {
    await writeManifestWithEntries(baseDir, [{ path: "/../etc/passwd", description: "evil" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/../etc/passwd");
    expect(res.error as string).toMatch(/'\.\.' segment/i);
    expect(res.content).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("root:");
  });

  it("traversal layer: rejects //etc/passwd even when allowlisted", async () => {
    await writeManifestWithEntries(baseDir, [{ path: "//etc/passwd", description: "evil" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "//etc/passwd");
    expect(res.error as string).toMatch(/doubled slash/i);
    expect(res.content).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("root:");
  });

  it("traversal layer: rejects surviving %2e marker even when allowlisted", async () => {
    // Allowlist the literal path-with-encoded-marker. After decode-once
    // (which decodes the OUTER `%25` of `%252e` to `%2e`), the resulting
    // string still contains a literal `%2e` — the traversal layer must
    // refuse rather than silently treat it as opaque.
    await writeManifestWithEntries(baseDir, [{ path: "/%252e/foo", description: "evil" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/%252e/foo");
    expect(res.error as string).toMatch(/encoded traversal marker/i);
    expect(res.content).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Edge cases (15-17)
  // ---------------------------------------------------------------------------

  it("returns clean error envelope when endpoint file is missing", async () => {
    // Allowlist the path so the High-1 check passes — the test is exercising
    // the ENOENT path inside fetchFromFile, not the allowlist.
    await writeManifestWithEntries(baseDir, [{ path: "/no-such-endpoint", description: "test" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    const res = await callManifestFetch(aug, "/no-such-endpoint");
    expect(res.error).toBeDefined();
    expect(typeof res.error).toBe("string");
    expect(res.error as string).toMatch(/not found/i);
  });

  it("returns clean error envelope when endpoint is a directory", async () => {
    // Create a sub-directory that the model might try to fetch as content.
    await mkdir(join(baseDir, "subdir"), { recursive: true });
    // Allowlist `/subdir` so the High-1 check passes — the test exercises
    // the directory-handling path inside fetchFromFile.
    await writeManifestWithEntries(baseDir, [{ path: "/subdir", description: "test" }]);
    const aug = knowledge({ baseUrl });
    await getManifestBlock(aug);
    // Hit `/subdir`. The literal path is a directory; readFile gets EISDIR.
    // The .md fallback then tries `/subdir.md`, which doesn't exist → ENOENT.
    const res = await callManifestFetch(aug, "/subdir");
    expect(res.error).toBeDefined();
  });

  it("returns null manifest gracefully when manifest JSON is malformed", async () => {
    // Overwrite manifest with bad JSON.
    await writeFile(join(baseDir, "manifest"), "{not valid json");
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
    // knowledge_fetch should still respond with a structured error.
    const res = await callManifestFetch(aug, "/mission");
    // The base dir is still readable; the .md fallback path works.
    // What matters: the augment didn't crash on bad manifest JSON.
    expect(res).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // End-to-end (18) — α-4's scaffolded example dir + α-6's file:// reader
  // ---------------------------------------------------------------------------

  it("end-to-end: scaffold-shaped knowledge/ dir works through resolveAugments", async () => {
    // Mimic what create writes: knowledge/sources.json + local/manifest +
    // local endpoint files. The CLI config only points at the knowledge root.
    const e2eRoot = join(tmp.path, "e2e-agent");
    const knowledgeDir = join(e2eRoot, "knowledge");
    const orgDir = join(knowledgeDir, "local");
    await mkdir(orgDir, { recursive: true });
    await writeFile(
      join(knowledgeDir, "sources.json"),
      `${JSON.stringify(
        {
          sources: [
            {
              name: "local",
              description: "Local project knowledge",
              baseUrl: "file://./local",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(orgDir, "manifest"),
      `${JSON.stringify(
        {
          org: "E2E Org",
          purpose: "end-to-end test",
          operator: "operator",
          phase: "active",
          endpoints: [
            { path: "/mission", description: "Mission" },
            { path: "/team", description: "Team" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(orgDir, "mission.md"), "# E2E mission body\n");
    await writeFile(join(orgDir, "team.md"), "# E2E team body\n");

    const augments = await resolveAugments(
      [
        {
          name: "org",
          type: "knowledge",
          options: { root: "./knowledge" },
        },
      ],
      e2eRoot,
    );
    expect(augments).toHaveLength(1);
    const aug = augments[0]!;

    // Manifest reads correctly.
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("E2E Org");
    expect(block!.content).toContain("end-to-end test");

    // /mission via .md fallback.
    const tool = aug.tools!.find((t) => t.name === "knowledge_fetch");
    if (!tool) throw new Error("knowledge_fetch tool not found on augment");
    const mission = JSON.parse(
      await asStringTool(tool).execute({ source: "local", endpoint: "/mission" }),
    ) as Record<string, unknown>;
    expect(mission.endpoint).toBe("/mission");
    expect(mission.source).toBe("local");
    expect(mission.content as string).toContain("E2E mission body");

    // /team via .md fallback.
    const team = JSON.parse(
      await asStringTool(tool).execute({ source: "local", endpoint: "/team" }),
    ) as Record<string, unknown>;
    expect(team.endpoint).toBe("/team");
    expect(team.source).toBe("local");
    expect(team.content as string).toContain("E2E team body");
  });
});

// ---------------------------------------------------------------------------
// Construction-time validation
// ---------------------------------------------------------------------------

describe("manifest construction", () => {
  it("throws on relative file:// URL — augment factory accepts only absolute", () => {
    // The augment surface is intentionally absolute-only. Relative file://
    // URLs are the resolver's job. Direct factory construction with a
    // relative form must error so misuse is loud.
    expect(() => knowledge({ baseUrl: "file://./manifest" })).toThrow();
  });

  it("accepts file:///<absolute-path> directly", () => {
    expect(() => knowledge({ baseUrl: "file:///tmp/some/path" })).not.toThrow();
  });

  it("accepts http:// and https:// without parsing as file://", () => {
    expect(() => knowledge({ baseUrl: "http://localhost:3000" })).not.toThrow();
    expect(() => knowledge({ baseUrl: "https://example.com" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Manifest shape validation (Codex 2nd-pass High finding)
// ---------------------------------------------------------------------------
// Per Codex 2nd-pass review: `JSON.parse(body) as Manifest` lies at runtime.
// A body of `{}` or `{"endpoints": null}` parses successfully but breaks
// downstream — allowlist throws on `undefined.endpoints`; onBoot crashes on
// `manifest.endpoints.length`. Validator at the cache boundary fails closed:
// invalid manifests are not cached; warn + treat as "no manifest loaded";
// knowledge_fetch returns a clean refusal envelope.

describe("manifest manifest shape validation", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };
  let baseDir: string;
  let baseUrl: string;

  const originalWarn = console.warn;
  const originalLog = console.log;

  beforeEach(async () => {
    tmp = await createTempDir();
    baseDir = join(tmp.path, "knowledge");
    baseUrl = pathToFileURL(baseDir).href;
    await mkdir(baseDir, { recursive: true });
    console.warn = mock(() => {});
    console.log = mock(() => {});
  });

  afterEach(async () => {
    console.warn = originalWarn;
    console.log = originalLog;
    await tmp.cleanup();
  });

  it("rejects empty-object manifest (no org/purpose/endpoints fields)", async () => {
    await writeFile(join(baseDir, "manifest"), "{}");
    const aug = knowledge({ baseUrl });
    // No manifest = the augment treats it as "no manifest loaded".
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
    // knowledge_fetch should produce the manifest-refusal envelope, not crash.
    const res = await callManifestFetch(aug, "/anything");
    expect(res.error).toBeDefined();
    expect(typeof res.error).toBe("string");
    expect((res.error as string).toLowerCase()).toMatch(/manifest|no manifest|unavailable/);
  });

  it("rejects manifest with endpoints: null (downstream would crash)", async () => {
    await writeFile(
      join(baseDir, "manifest"),
      JSON.stringify({ org: "Test", purpose: "test", endpoints: null }),
    );
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
    const res = await callManifestFetch(aug, "/anything");
    expect(res.error).toBeDefined();
    expect((res.error as string).toLowerCase()).toMatch(/manifest|no manifest|unavailable/);
  });

  it("rejects manifest with endpoint entry missing path", async () => {
    await writeFile(
      join(baseDir, "manifest"),
      JSON.stringify({
        org: "Test",
        purpose: "test",
        endpoints: [{ description: "missing path field" }],
      }),
    );
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
    const res = await callManifestFetch(aug, "/anything");
    expect(res.error).toBeDefined();
    expect((res.error as string).toLowerCase()).toMatch(/manifest|no manifest|unavailable/);
  });

  it("rejects manifest with non-string org field", async () => {
    await writeFile(
      join(baseDir, "manifest"),
      JSON.stringify({ org: 42, purpose: "test", endpoints: [] }),
    );
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
  });

  it("rejects manifest with endpoint entry missing description", async () => {
    await writeFile(
      join(baseDir, "manifest"),
      JSON.stringify({
        org: "Test",
        purpose: "test",
        endpoints: [{ path: "/foo" }],
      }),
    );
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
  });

  it("accepts a valid manifest with optional fields present", async () => {
    await writeFile(
      join(baseDir, "manifest"),
      JSON.stringify({
        org: "Test",
        purpose: "test",
        operator: "the operator",
        phase: "active",
        endpoints: [{ path: "/foo", description: "test", method: "GET" }],
      }),
    );
    await writeFile(join(baseDir, "foo"), "foo-content");
    const aug = knowledge({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Test");
    const res = await callManifestFetch(aug, "/foo");
    expect(res.error).toBeUndefined();
    expect(res.content).toContain("foo-content");
  });
});
