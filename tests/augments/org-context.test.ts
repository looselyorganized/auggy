/**
 * Tests for the org-context augment.
 *
 * Coverage map (per α-6 spec / Codex review focus #3):
 *   - Positive cases: file:// (absolute + relative-via-resolver) manifest read,
 *     org_fetch under file:// (literal + .md fallback), HTTP backward compat
 *   - Path-traversal attacks (must REJECT): `..`, double-`..`, deep-`..`,
 *     URL-encoded `..`, double-encoded `..`, absolute-looking path,
 *     mid-path `..`, double slash, null byte, symlink escape
 *   - Edge cases: missing file, directory-instead-of-file, malformed manifest JSON
 *   - End-to-end: scaffolded org-context/ dir + file://./org-context resolution
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { orgContext, isWithinBase } from "@/augments/org-context";
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

/** Run org_fetch on the given augment, returning the parsed JSON envelope. */
async function callOrgFetch(
  aug: Augment,
  endpoint: string,
  prompt?: string,
): Promise<Record<string, unknown>> {
  const tool = aug.tools!.find((t) => t.name === "org_fetch");
  if (!tool) throw new Error("org_fetch tool not found on augment");
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

/** Write a fully-stocked example org-context dir under `baseDir`. */
async function writeExampleOrgContext(baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, "manifest"), `${JSON.stringify(defaultManifest(), null, 2)}\n`);
  await writeFile(join(baseDir, "mission.md"), "# Test Org — Mission\n\nfor testing only\n");
  await writeFile(join(baseDir, "team.md"), "# Test Org — Team\n\n- the operator (operator)\n");
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

describe("orgContext file:// scheme", () => {
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
    baseDir = join(tmp.path, "org-context");
    baseUrl = pathToFileURL(baseDir).href;
    await writeExampleOrgContext(baseDir);
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
    const aug = orgContext({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Test Org");
    expect(block!.content).toContain("for testing only");
    expect(block!.content).toContain("/mission");
    expect(block!.content).toContain("/team");
    expect(block!.placement).toBe("system");
  });

  it("resolves file://./relative paths via the augment-resolver against agentDir", async () => {
    // file://./<rel> must be resolved by the resolver against agentDir; the
    // augment receives an absolute file:// URL and reads correctly.
    const augments = await resolveAugments(
      [
        {
          name: "org",
          type: "orgContext",
          options: { baseUrl: "file://./org-context" },
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

  it("org_fetch reads /mission via the .md fallback", async () => {
    const aug = orgContext({ baseUrl });
    // Prime the manifest so the augment's base-dir cache populates.
    await getManifestBlock(aug);
    const result = await callOrgFetch(aug, "/mission");
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
    const aug = orgContext({ baseUrl: "https://example.com", client: fakeClient });
    const block = await getManifestBlock(aug);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Test Org");
    const fetched = await callOrgFetch(aug, "/mission");
    expect(fetched.endpoint).toBe("/mission");
    expect(fetched.content).toContain("Mission body");
  });

  // ---------------------------------------------------------------------------
  // Path-traversal attacks (5-14) — all must REJECT
  // ---------------------------------------------------------------------------

  // The augment treats endpoint paths as `/`-rooted under the configured
  // base dir (the URL-style convention the manifest uses: `/mission`,
  // `/team`, etc.). Inputs that look like absolute traversals
  // (`/../etc/passwd`, `/foo/../../etc/passwd`) are normalized BEFORE
  // resolution: `path.normalize("/../etc/passwd")` collapses to
  // `/etc/passwd`, which then re-roots to `<base>/etc/passwd`. The leak
  // is neutralized at normalize time and the read produces a clean ENOENT
  // — never reading from outside the base.
  //
  // The realpath/relative boundary check is the load-bearing defense for
  // cases that DO escape after normalize: the symlink-escape test below
  // is the canonical one; relative-form requests would also exercise it
  // if the augment ever accepted them (it doesn't — `/`-rooted convention
  // is enforced).
  //
  // Each of these cases asserts the security property directly: no
  // outside-base content leaks into the tool result.

  /** Asserts that the response is an error envelope with no /etc/passwd leak. */
  function expectNoLeak(res: Record<string, unknown>): void {
    expect(res.error).toBeDefined();
    expect(typeof res.error).toBe("string");
    // /etc/passwd lines start with "root:" on POSIX — load-bearing canary.
    expect(JSON.stringify(res)).not.toContain("root:");
    // No content field should be present on an error envelope.
    expect(res.content).toBeUndefined();
  }

  it("rejects /../etc/passwd (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /../../etc/passwd (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/../../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /../../../../../etc/passwd deep escape (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/../../../../../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /%2e%2e/etc/passwd URL-encoded `..` (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    // Single-decoded once: "%2e%2e" → ".." → normalize collapses against
    // the leading slash → resolved path is inside the base → ENOENT.
    const res = await callOrgFetch(aug, "/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
    expectNoLeak(res);
  });

  it("rejects /%252e%252e/etc/passwd double-encoded (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    // Decode-once policy: "%252e%252e" → "%2e%2e" (NOT "..").
    // Stays as a literal segment under the base → ENOENT, no escape.
    const res = await callOrgFetch(aug, "/%252e%252e/etc/passwd");
    expectNoLeak(res);
  });

  it("rejects an absolute-looking endpoint /etc/passwd (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    // Manifest convention: `/`-prefix means "rooted at base". The leading
    // `/` is stripped before join, so this becomes `<base>/etc/passwd`
    // (which doesn't exist) — read fails cleanly with ENOENT.
    const res = await callOrgFetch(aug, "/etc/passwd");
    expectNoLeak(res);
  });

  it("rejects mid-path traversal /foo/../../etc/passwd (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/foo/../../etc/passwd");
    expectNoLeak(res);
  });

  it("rejects double-slash //etc/passwd (no leak)", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "//etc/passwd");
    expectNoLeak(res);
  });

  it("rejects null-byte injection \\0bad", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/\0bad");
    expect(res.error as string).toMatch(/null byte/i);
  });

  it("rejects URL-encoded null byte %00", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/safe%00.md");
    expect(res.error as string).toMatch(/null byte/i);
  });

  it("rejects symlink escape (symlink inside base pointing outside)", async () => {
    // Build a symlink inside the base dir pointing at /etc. Any request
    // through that symlink must be caught by the realpath boundary check.
    const evilLink = join(baseDir, "evil-link");
    // /etc exists on macOS/Linux; on Windows we'd need a different target.
    // The augment / Auggy targets POSIX-only at v1.0 so this is fine.
    await symlink("/etc", evilLink);

    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    // The literal request path under the base is `/evil-link/passwd`.
    // safeResolveUnderBase joins to `<base>/evil-link/passwd`, then
    // realpath resolves the symlink → `/etc/passwd`, which is OUTSIDE
    // realBase. The boundary check rejects.
    const res = await callOrgFetch(aug, "/evil-link/passwd");
    expect(res.error as string).toMatch(/traversal rejected/i);
  });

  // ---------------------------------------------------------------------------
  // Edge cases (15-17)
  // ---------------------------------------------------------------------------

  it("returns clean error envelope when endpoint file is missing", async () => {
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    const res = await callOrgFetch(aug, "/no-such-endpoint");
    expect(res.error).toBeDefined();
    expect(typeof res.error).toBe("string");
    expect(res.error as string).toMatch(/not found/i);
  });

  it("returns clean error envelope when endpoint is a directory", async () => {
    // Create a sub-directory that the model might try to fetch as content.
    await mkdir(join(baseDir, "subdir"), { recursive: true });
    // Also create a `subdir.md` to ensure the .md fallback path is exercised.
    // Actually — to test the directory-handling, we should NOT have a .md
    // fallback; otherwise the read succeeds. So test directly:
    const aug = orgContext({ baseUrl });
    await getManifestBlock(aug);
    // Hit `/subdir`. The literal path is a directory; readFile gets EISDIR.
    // The .md fallback then tries `/subdir.md`, which doesn't exist → ENOENT.
    const res = await callOrgFetch(aug, "/subdir");
    expect(res.error).toBeDefined();
  });

  it("returns null manifest gracefully when manifest JSON is malformed", async () => {
    // Overwrite manifest with bad JSON.
    await writeFile(join(baseDir, "manifest"), "{not valid json");
    const aug = orgContext({ baseUrl });
    const block = await getManifestBlock(aug);
    expect(block).toBeNull();
    // org_fetch should still respond with a structured error.
    const res = await callOrgFetch(aug, "/mission");
    // The base dir is still readable; the .md fallback path works.
    // What matters: the augment didn't crash on bad manifest JSON.
    expect(res).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // End-to-end (18) — α-4's scaffolded example dir + α-6's file:// reader
  // ---------------------------------------------------------------------------

  it("end-to-end: scaffold-shaped org-context/ dir works through resolveAugments", async () => {
    // Mimic what α-4's writeOrgContextExample produces (manifest + mission.md
    // + team.md + README.md), then construct the augment via the same path
    // the CLI uses — resolveAugments with `file://./org-context` and
    // agentDir = the temp dir.
    const e2eRoot = join(tmp.path, "e2e-agent");
    const orgDir = join(e2eRoot, "org-context");
    await mkdir(orgDir, { recursive: true });
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
          type: "orgContext",
          options: { baseUrl: "file://./org-context" },
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
    const mission = await callOrgFetch(aug, "/mission");
    expect(mission.endpoint).toBe("/mission");
    expect(mission.content as string).toContain("E2E mission body");

    // /team via .md fallback.
    const team = await callOrgFetch(aug, "/team");
    expect(team.endpoint).toBe("/team");
    expect(team.content as string).toContain("E2E team body");
  });
});

// ---------------------------------------------------------------------------
// Construction-time validation
// ---------------------------------------------------------------------------

describe("orgContext construction", () => {
  it("throws on relative file:// URL — augment factory accepts only absolute", () => {
    // The augment surface is intentionally absolute-only. Relative file://
    // URLs are the resolver's job. Direct factory construction with a
    // relative form must error so misuse is loud.
    expect(() => orgContext({ baseUrl: "file://./org-context" })).toThrow();
  });

  it("accepts file:///<absolute-path> directly", () => {
    expect(() => orgContext({ baseUrl: "file:///tmp/some/path" })).not.toThrow();
  });

  it("accepts http:// and https:// without parsing as file://", () => {
    expect(() => orgContext({ baseUrl: "http://localhost:3000" })).not.toThrow();
    expect(() => orgContext({ baseUrl: "https://example.com" })).not.toThrow();
  });
});
