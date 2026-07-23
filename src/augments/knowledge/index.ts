/**
 * Knowledge augment — read-only registry of information endpoints the agent
 * can access (files, URLs, etc.).
 *
 * Connects an Auggy agent to an organization's knowledge API. Two stages of
 * progressive disclosure:
 *   1. Manifest (always in context, ~200 tokens) — org identity + endpoint list
 *   2. Endpoint content (on demand via knowledge_fetch) — full docs, fetched when relevant
 *
 * Outbound messaging (org_escalate, rate limits) moved to the notify augment
 * in roadmap item 6 (2026-04-28). For escalation, mount the notify augment
 * alongside this one.
 *
 * Boot is graceful: if the org API is unreachable, the agent starts without
 * manifest and logs a warning. knowledge_fetch will fail with clear errors until
 * the API is reachable.
 *
 * URL schemes (per α-6 / spec §Decision 8):
 *   - http:// or https://  — fetch via shared HTTP client (existing behavior)
 *   - file://              — read from local filesystem with realpath-based
 *                            traversal safety. Relative `file://./...` URLs
 *                            are resolved by the augment-resolver against the
 *                            agent dir BEFORE construction; the augment itself
 *                            only handles absolute file:// URLs (per ADR-024:
 *                            no new kernel surface, no agent-dir construction
 *                            parameter).
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, normalize, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import type { Augment, ContextBlock } from "../../types";
import { defineTool } from "../../helpers";
import { createHttpClient } from "../../http";
import type { HttpClient } from "../../http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestOptions {
  /**
   * Base URL of the org's knowledge source. Three schemes accepted:
   *
   *   - `http://...` / `https://...` — manifest + endpoint content fetched
   *     over HTTP via the shared http client
   *   - `file:///<absolute-path>`    — manifest + endpoint content read from
   *     the local filesystem. Path-traversal safety is enforced via realpath
   *     (any resolved path that escapes the configured base dir is rejected).
   *
   * Relative `file://./...` URLs MUST be resolved against the agent dir by
   * the caller (the augment-resolver does this); the augment itself only
   * accepts absolute file:// URLs to keep the construction surface flat.
   */
  baseUrl: string;
  /** Optional auth token for the org API (HTTP scheme only). */
  token?: string;
  /** Manifest cache TTL in milliseconds. Default 1 hour. */
  cacheTtlMs?: number;
  /** Optional pre-built HTTP client (for sharing across augments or testing). */
  client?: HttpClient;
}

export interface KnowledgeRootOptions {
  /** Absolute path to the knowledge directory containing sources.json. */
  root: string;
  /** Optional pre-built HTTP client shared by HTTP sources, mostly for tests. */
  client?: HttpClient;
  /** Default manifest cache TTL in milliseconds. Default 1 hour. */
  cacheTtlMs?: number;
}

interface KnowledgeSourceConfig {
  name: string;
  description?: string;
  baseUrl: string;
  token?: string;
  tokenEnv?: string;
  cacheTtlMs?: number;
}

interface KnowledgeSourcesFile {
  sources: KnowledgeSourceConfig[];
}

interface ManifestEndpoint {
  path: string;
  description: string;
  method?: string;
}

export function knowledgeRoot(opts: KnowledgeRootOptions): Augment {
  let cachedSources: Array<KnowledgeSourceConfig & { augment: Augment }> | null = null;

  async function loadSources(): Promise<Array<KnowledgeSourceConfig & { augment: Augment }>> {
    if (cachedSources) return cachedSources;

    const sourcePath = resolve(opts.root, "sources.json");
    const raw = await readFile(sourcePath, "utf-8");
    const parsed = validateSourcesFile(JSON.parse(raw));

    cachedSources = parsed.sources.map((source) => {
      const baseUrl = resolveKnowledgeSourceBaseUrl(source.baseUrl, opts.root);
      const token = source.token ?? (source.tokenEnv ? process.env[source.tokenEnv] : undefined);
      return {
        ...source,
        baseUrl,
        token,
        augment: knowledge({
          baseUrl,
          token,
          cacheTtlMs: source.cacheTtlMs ?? opts.cacheTtlMs,
          client: opts.client,
        }),
      };
    });

    return cachedSources;
  }

  const fetchTool = defineTool({
    name: "knowledge_fetch",
    description: "Fetch knowledge from one of the configured knowledge sources.",
    category: "search",
    input: z.object({
      source: z.string().describe("The knowledge source name from the context block"),
      endpoint: z.string().describe("The endpoint path listed by that source"),
      prompt: z.string().optional().describe("Optional: what you want to know from the content"),
    }),
    execute: async ({ source, endpoint, prompt }) => {
      const sources = await loadSources();
      const selected = sources.find((s) => s.name === source);
      if (!selected) {
        return JSON.stringify({
          error: `Knowledge source not found: ${JSON.stringify(source)}`,
          availableSources: sources.map((s) => s.name),
        });
      }

      const tool = selected.augment.tools?.find((t) => t.name === "knowledge_fetch");
      if (!tool) {
        return JSON.stringify({ error: `Knowledge source ${source} has no fetch tool` });
      }

      const content = await tool.execute({ endpoint, prompt });
      try {
        const parsed = JSON.parse(content as string) as Record<string, unknown>;
        return JSON.stringify({ source, ...parsed });
      } catch {
        return JSON.stringify({ source, endpoint, content });
      }
    },
  });

  return {
    name: "knowledge",
    type: "knowledge",
    tools: [fetchTool],
    async context(turn, budget) {
      const sources = await loadSources();
      const blocks: string[] = ["# Knowledge", ""];

      for (const source of sources) {
        const childContext = await source.augment.context?.(turn, budget);
        const childBlocks =
          typeof childContext === "string" ? [{ content: childContext }] : (childContext ?? []);
        const content = childBlocks[0]?.content;
        if (!content) continue;
        blocks.push(`## ${source.name}${source.description ? ` — ${source.description}` : ""}`);
        blocks.push("");
        blocks.push(
          content.replace(
            /Use `knowledge_fetch` to retrieve any of these when relevant to the conversation:/g,
            `Use \`knowledge_fetch({ source: "${source.name}", endpoint })\` to retrieve any of these when relevant to the conversation:`,
          ),
        );
        blocks.push("");
      }

      if (blocks.length <= 2) return [];
      return [
        {
          source: "knowledge",
          content: blocks.join("\n").trim(),
          priority: "high",
          placement: "system",
          eviction: "drop",
          provenance: "augment",
          origin: "operator",
        },
      ];
    },
    async onBoot() {
      try {
        const sources = await loadSources();
        for (const source of sources) {
          await source.augment.onBoot?.();
        }
      } catch (err) {
        console.warn(
          `[knowledge] sources.json unavailable at ${opts.root}: ${(err as Error).message}`,
        );
      }
    },
  };
}

function validateSourcesFile(raw: unknown): KnowledgeSourcesFile {
  if (raw === null || typeof raw !== "object") {
    throw new Error("knowledge/sources.json must be an object");
  }
  const sources = (raw as Record<string, unknown>).sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("knowledge/sources.json must contain a non-empty sources array");
  }

  const out: KnowledgeSourceConfig[] = [];
  const names = new Set<string>();
  for (const source of sources) {
    if (source === null || typeof source !== "object") {
      throw new Error("knowledge source entries must be objects");
    }
    const s = source as Record<string, unknown>;
    if (typeof s.name !== "string" || !s.name.trim()) {
      throw new Error("knowledge source name must be a non-empty string");
    }
    if (names.has(s.name)) {
      throw new Error(`duplicate knowledge source name: ${s.name}`);
    }
    names.add(s.name);
    if (typeof s.baseUrl !== "string" || !s.baseUrl.trim()) {
      throw new Error(`knowledge source ${s.name} baseUrl must be a non-empty string`);
    }
    out.push({
      name: s.name,
      description: typeof s.description === "string" ? s.description : undefined,
      baseUrl: s.baseUrl,
      token: typeof s.token === "string" ? s.token : undefined,
      tokenEnv: typeof s.tokenEnv === "string" ? s.tokenEnv : undefined,
      cacheTtlMs: typeof s.cacheTtlMs === "number" ? s.cacheTtlMs : undefined,
    });
  }

  return { sources: out };
}

function resolveKnowledgeSourceBaseUrl(baseUrl: string, root: string): string {
  if (!/^file:/i.test(baseUrl)) return baseUrl;

  const afterScheme = baseUrl.replace(/^file:/i, "");
  const isAbsoluteFileUrl =
    afterScheme.startsWith("///") || (afterScheme.startsWith("/") && !afterScheme.startsWith("//"));
  if (isAbsoluteFileUrl) return baseUrl;

  const relPath = afterScheme.replace(/^\/+/, "");
  return pathToFileURL(resolve(root, relPath)).href;
}

interface Manifest {
  org: string;
  purpose: string;
  creator?: string;
  phase?: string;
  endpoints: ManifestEndpoint[];
}

/**
 * Validate that parsed JSON has the Manifest shape. Returns the manifest
 * cast to Manifest if valid, null if not. Hand-rolled (not zod) to avoid
 * a runtime-validation dependency for a single shape; the schema is small.
 *
 * Rationale: `JSON.parse(body) as Manifest` is a TypeScript cast that
 * lies at runtime — a body of `{}` or `{"endpoints": null}` parses
 * successfully but breaks downstream (the allowlist check throws on
 * `undefined.endpoints`; `onBoot` crashes on `manifest.endpoints.length`).
 * Validating at the cache boundary is the natural fail-closed point: if
 * the manifest doesn't match the contract, treat it as "no manifest
 * loaded" (warn + return prior cache, keeping the augment's graceful-boot
 * contract intact).
 */
function validateManifest(raw: unknown): Manifest | null {
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.org !== "string") return null;
  if (typeof m.purpose !== "string") return null;
  if (!Array.isArray(m.endpoints)) return null;
  for (const ep of m.endpoints) {
    if (ep === null || typeof ep !== "object") return null;
    const e = ep as Record<string, unknown>;
    if (typeof e.path !== "string") return null;
    if (typeof e.description !== "string") return null;
    if (e.method !== undefined && typeof e.method !== "string") return null;
  }
  if (m.creator !== undefined && typeof m.creator !== "string") return null;
  if (m.phase !== undefined && typeof m.phase !== "string") return null;
  return m as unknown as Manifest;
}

// ---------------------------------------------------------------------------
// URL scheme handling
// ---------------------------------------------------------------------------

const FILE_SCHEME_RE = /^file:/i;

/**
 * Parse a `file://...` URL into an absolute filesystem base directory.
 *
 * Accepts only absolute forms:
 *   - `file:///abs/path`   (POSIX, three slashes)
 *   - `file:/abs/path`     (uncommon but valid)
 * Rejects relative `file://./...` shapes — the augment-resolver is expected
 * to resolve those against the agent dir before construction. Keeping the
 * augment surface absolute-only avoids threading agent-dir context into the
 * augment factory (per ADR-024 — no new kernel surface).
 */
function parseFileBaseUrl(baseUrl: string): string {
  // Strip any trailing slash for consistent join semantics.
  const trimmed = baseUrl.replace(/\/+$/, "");
  let absPath: string;
  try {
    absPath = fileURLToPath(trimmed);
  } catch (err) {
    throw new Error(
      `knowledge: invalid file:// URL "${baseUrl}" — must be absolute (file:///abs/path). ` +
        `Relative file:// URLs must be resolved by the augment-resolver against the agent dir before construction. ` +
        `(${(err as Error).message})`,
    );
  }
  if (!isAbsolute(absPath)) {
    throw new Error(
      `knowledge: file:// URL "${baseUrl}" did not resolve to an absolute path (got "${absPath}").`,
    );
  }
  return absPath;
}

// ---------------------------------------------------------------------------
// Path-traversal safety
// ---------------------------------------------------------------------------

/**
 * Decode a percent-encoded path segment EXACTLY ONCE.
 *
 * Critical: do not loop or recurse. Double-decoding turns `%252e%252e` into
 * `..` (after two passes), defeating the normalize-then-resolve check below.
 * One-shot decode followed by normalize+resolve+realpath catches both
 * single-encoded and double-encoded traversal attempts: single-encoded
 * collapses to `..` and gets normalized away by `path.normalize`; double-
 * encoded stays as a literal `%2e%2e` that does not match `..` and either
 * (a) doesn't exist on disk (clean ENOENT) or (b) exists as a literal-named
 * file under the base dir (no escape).
 */
function decodeOnce(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    // Malformed percent-encoding — return the raw input. The downstream
    // null-byte / absolute-path / realpath checks will still apply.
    return input;
  }
}

/**
 * Boundary check via `path.relative()` — same shape used by the filesystem
 * augment's `isWithinMount`. Rejects targets that escape the base dir
 * (the relative path starts with `..`) and targets on a different filesystem
 * root (Windows cross-drive — `relative()` returns an absolute path).
 *
 * Chose `relative()` over `startsWith(base + sep)` because the separator-
 * suffix form breaks when the base is itself a filesystem root (`/` on
 * POSIX → `base + sep` becomes `//`, which never matches a real child).
 * The relative-based check also avoids the `realBase + "-attacker"` false
 * positive of a naive prefix check.
 *
 * Exported only for testability; not part of the augment's public API.
 */
export function isWithinBase(realTarget: string, realBase: string): boolean {
  const rel = relative(realBase, realTarget);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Resolve a model-supplied endpoint path safely under an absolute base dir.
 *
 * Defense layers (each adds a different attack class):
 *   1. Reject null bytes — file APIs treat `\0` as a string terminator and
 *      can be tricked into reading a different path than the validator saw.
 *   2. Decode percent-encoding ONCE — single-encoded `%2e%2e` collapses to
 *      `..`; double-encoded `%252e%252e` stays as a literal that won't
 *      match `..` after one decode.
 *   3. Fail-closed traversal rejection — explicitly reject any input whose
 *      decoded form contains `..` segments, a doubled leading slash, or a
 *      surviving `%2e`/`%2E` marker (a double-encoding attempt). Spec's
 *      §fail-closed contract: traversal-shaped inputs MUST be rejected at
 *      validation time, not silently re-rooted under base. This makes
 *      attempts visible in operator logs (rejection class is in the error
 *      message) instead of disappearing into ENOENTs.
 *   4. Normalize the requested path — defensive only; layer 3 has already
 *      caught the canonical traversal shapes. Normalize remains for any
 *      benign `./` segments that survived layer 3.
 *   5. Strip a leading slash before joining — endpoint paths are always
 *      treated as relative-under-base. A request that looks absolute is
 *      a strong attack signal in this context.
 *   6. realpath both base AND candidate (when candidate exists) — symlink
 *      hops are followed; a symlink inside the base pointing to /etc is
 *      caught here.
 *   7. Confirm the realpath'd candidate is still under the realpath'd base
 *      (via `relative()` boundary check, not naive `startsWith`).
 *
 * If the candidate doesn't exist on disk, we still validate the resolved
 * path (without realpath) against the realpath'd base — the file read that
 * follows will surface a clean ENOENT, but we never read outside the base.
 *
 * Throws on any traversal attempt. Caller wraps the throw into a tool result
 * envelope so the model sees a non-fatal error.
 */
async function safeResolveUnderBase(realBaseDir: string, requestedPath: string): Promise<string> {
  // Layer 1: null-byte rejection.
  if (requestedPath.includes("\0")) {
    throw new Error(
      `knowledge: rejected path containing null byte: ${JSON.stringify(requestedPath)}`,
    );
  }

  // Layer 2: decode-once (no recursion / no looping).
  const decoded = decodeOnce(requestedPath);
  if (decoded.includes("\0")) {
    // Re-check after decode — `%00` decodes to `\0`.
    throw new Error(
      `knowledge: rejected path containing null byte after decode: ${JSON.stringify(requestedPath)}`,
    );
  }

  // Layer 3: fail-closed traversal rejection. Each rejection class throws a
  // distinct message so the operator can see in logs which defense fired.
  // 3a: `..` segment — `^..` or `/../` or trailing `/..`.
  if (/(?:^|\/)\.\.(?:\/|$)/.test(decoded)) {
    throw new Error(
      `knowledge: rejected traversal — path contains '..' segment: ${JSON.stringify(requestedPath)}`,
    );
  }
  // 3b: doubled leading slash — `//foo` is an attempt to disturb root semantics.
  if (decoded.startsWith("//")) {
    throw new Error(
      `knowledge: rejected traversal — path begins with doubled slash: ${JSON.stringify(requestedPath)}`,
    );
  }
  // 3c: surviving encoded traversal marker. After decode-once, any literal
  // `%2e` / `%2E` left in the string is a double-encoded `.` — a clear
  // double-encoding attempt that must not be silently accepted.
  if (/%2[eE]/.test(decoded)) {
    throw new Error(
      `knowledge: rejected traversal — path contains encoded traversal marker that survived decode: ${JSON.stringify(requestedPath)}`,
    );
  }

  // Layer 4: normalize (defensive — layer 3 has caught the canonical traversals).
  const normalized = normalize(decoded);

  // Layer 5: strip leading slashes — endpoint paths are always relative-
  // under-base in this augment. An absolute-looking input is an attack signal.
  // We strip rather than reject because the manifest convention is that
  // endpoint paths begin with `/` ("/mission", "/team"); stripping the lead
  // converts that to a relative join target.
  const stripped = normalized.replace(/^\/+/, "");

  // After stripping, an isAbsolute() check catches Windows drive letters
  // (e.g. "C:\\Windows\\..."), UNC paths, and any other absolute shape that
  // shouldn't escape relative-join semantics.
  if (isAbsolute(stripped)) {
    throw new Error(`knowledge: rejected absolute-looking path: ${JSON.stringify(requestedPath)}`);
  }

  // Layer 6+7: resolve under base, realpath, boundary check.
  const candidate = resolve(realBaseDir, stripped);

  let realCandidate: string;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    // Path doesn't exist yet — fall back to the resolved (non-realpath'd)
    // path. We still validate the boundary; the read that follows will
    // surface a clean ENOENT. This means: a path like `/no-such-file` under
    // a valid base is allowed to reach the read step (which fails cleanly),
    // but a path like `/../etc/passwd` is rejected here BEFORE the read,
    // because resolve() already collapsed it outside the base.
    realCandidate = candidate;
  }

  if (!isWithinBase(realCandidate, realBaseDir)) {
    throw new Error(
      `knowledge: rejected traversal — ${JSON.stringify(requestedPath)} resolves outside base ${realBaseDir}`,
    );
  }

  return realCandidate;
}

// ---------------------------------------------------------------------------
// Augment factory
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export function knowledge(opts: ManifestOptions): Augment {
  const isFile = FILE_SCHEME_RE.test(opts.baseUrl);

  // For HTTP/HTTPS: keep existing behavior (trim trailing slash, init client).
  // For file://: parse to an absolute filesystem path; the http client is
  // unused. realBaseDir is resolved (and cached) at first manifest fetch.
  const httpBaseUrl = isFile ? "" : opts.baseUrl.replace(/\/+$/, "");
  const fileBasePath = isFile ? parseFileBaseUrl(opts.baseUrl) : "";

  const client =
    isFile || opts.client
      ? (opts.client ??
        // file:// path doesn't need a real client; placeholder to keep types
        // narrow. Never actually called when isFile is true.
        createHttpClient({
          timeoutMs: 10_000,
          userAgent: "auggy-knowledge/0.2",
          urlPolicy: "operator-configured",
          defaultHeaders: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        }))
      : createHttpClient({
          timeoutMs: 10_000,
          userAgent: "auggy-knowledge/0.2",
          urlPolicy: "operator-configured",
          defaultHeaders: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        });
  const cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL;

  let cachedManifest: Manifest | null = null;
  let cacheExpiresAt = 0;
  // Cached realpath of the file:// base dir. Populated on first manifest
  // fetch (or first knowledge_fetch if the manifest hadn't been read). Stays
  // null until then; subsequent calls reuse the cached value.
  let cachedRealBase: string | null = null;

  // ---------------------------------------------------------------------------
  // file:// helpers
  // ---------------------------------------------------------------------------

  async function resolveRealBase(): Promise<string> {
    if (cachedRealBase) return cachedRealBase;
    // Validate the base dir exists and is a directory — fail fast with a
    // clean error if the operator pointed baseUrl at something invalid.
    const baseStat = await stat(fileBasePath).catch((err: unknown) => {
      throw new Error(
        `knowledge: file:// base "${fileBasePath}" not accessible: ${(err as Error).message}`,
      );
    });
    if (!baseStat.isDirectory()) {
      throw new Error(`knowledge: file:// base "${fileBasePath}" is not a directory`);
    }
    cachedRealBase = await realpath(fileBasePath);
    return cachedRealBase;
  }

  // ---------------------------------------------------------------------------
  // Manifest fetching (HTTP or file)
  // ---------------------------------------------------------------------------

  async function fetchManifest(force = false): Promise<Manifest | null> {
    if (!force && cachedManifest && Date.now() < cacheExpiresAt) {
      return cachedManifest;
    }

    if (isFile) {
      try {
        const realBase = await resolveRealBase();
        const manifestPath = await safeResolveUnderBase(realBase, "manifest");
        const body = await readFile(manifestPath, "utf-8");
        const parsed: unknown = JSON.parse(body);
        const validated = validateManifest(parsed);
        if (validated === null) {
          console.warn(
            `[knowledge] manifest at ${fileBasePath}/manifest has invalid shape — running without a loaded manifest. Will retry on next fetch.`,
          );
          return cachedManifest;
        }
        cachedManifest = validated;
        cacheExpiresAt = Date.now() + cacheTtl;
        return cachedManifest;
      } catch (err) {
        console.warn(
          `[knowledge] failed to read file:// manifest from ${fileBasePath}: ${(err as Error).message}`,
        );
        return cachedManifest;
      }
    }

    try {
      const res = await client.get(`${httpBaseUrl}/manifest`);
      if (res.status !== 200) {
        console.warn(`[knowledge] manifest returned ${res.status}: ${res.body.slice(0, 200)}`);
        return cachedManifest;
      }
      const parsed: unknown = JSON.parse(res.body);
      const validated = validateManifest(parsed);
      if (validated === null) {
        console.warn(
          `[knowledge] manifest at ${httpBaseUrl}/manifest has invalid shape — running without a loaded manifest. Will retry on next fetch.`,
        );
        return cachedManifest;
      }
      cachedManifest = validated;
      cacheExpiresAt = Date.now() + cacheTtl;
      return cachedManifest;
    } catch (err) {
      console.warn(`[knowledge] failed to fetch manifest: ${(err as Error).message}`);
      return cachedManifest;
    }
  }

  // ---------------------------------------------------------------------------
  // Context block
  // ---------------------------------------------------------------------------

  function buildContextBlock(manifest: Manifest): string {
    const lines = [`# ${manifest.org} — Organization Context`, "", manifest.purpose, ""];

    if (manifest.creator) {
      lines.push(`**Creator:** ${manifest.creator}`);
    }
    if (manifest.phase) {
      lines.push(`**Current phase:** ${manifest.phase}`);
    }

    lines.push("");
    lines.push("## Available org knowledge");
    lines.push("");
    lines.push("Use `knowledge_fetch` to retrieve any of these when relevant to the conversation:");
    lines.push("");

    for (const ep of manifest.endpoints) {
      if (ep.method === "POST") {
        lines.push(`- **${ep.path}** (action) — ${ep.description}`);
      } else {
        lines.push(`- **${ep.path}** — ${ep.description}`);
      }
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Manifest allowlist (Codex High-1)
  //
  // The manifest is the authoritative endpoint contract per spec §Decision 9.
  // Without an allowlist, any in-base file (file://) or HTTP route could be
  // reached regardless of whether it was advertised. Force-load the manifest
  // before every fetch (cached call — no extra IO/HTTP after first load) and
  // require strict equality between the requested path and one of
  // `manifest.endpoints[].path`. Strict equality (no prefix matching) is
  // intentional: `/mission` and `/mission/extra` are distinct endpoints and
  // must both be advertised explicitly to be reachable.
  // ---------------------------------------------------------------------------

  async function checkManifestAllowlist(requestedPath: string): Promise<string | null> {
    // Use cached manifest if fresh; otherwise force a reload (caller-side
    // side-effect: also populates cachedManifest for subsequent context()).
    const manifest = await fetchManifest();
    if (!manifest) {
      return JSON.stringify({
        error:
          "Manifest unavailable: no manifest loaded — cannot validate endpoint allowlist. " +
          "The manifest is the authoritative contract for advertised endpoints.",
        hint: "Check that the org base is reachable and the manifest is present and well-formed.",
      });
    }
    const allowed = manifest.endpoints.some((ep) => ep.path === requestedPath);
    if (!allowed) {
      return JSON.stringify({
        error: `Manifest endpoint refused: ${JSON.stringify(requestedPath)} is not in the manifest's advertised endpoints`,
        hint: "The model may only fetch paths advertised by the manifest. Inspect the manifest block for the listed paths.",
      });
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // knowledge_fetch tool — file:// branch
  // ---------------------------------------------------------------------------

  async function fetchFromFile(endpoint: string, prompt?: string): Promise<string> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    // High-1: allowlist runs first (simple, single-pass per fetch). Traversal
    // rejection lives in safeResolveUnderBase as defense-in-depth.
    const allowlistError = await checkManifestAllowlist(path);
    if (allowlistError) return allowlistError;

    let realBase: string;
    try {
      realBase = await resolveRealBase();
    } catch (err) {
      return JSON.stringify({
        error: `Failed to resolve manifest base: ${(err as Error).message}`,
        hint: "Check the file:// baseUrl in agent.yaml and that the directory exists.",
      });
    }

    let resolved: string;
    try {
      resolved = await safeResolveUnderBase(realBase, path);
    } catch (err) {
      // Traversal-rejection or null-byte path. Surface as a clean error
      // envelope (NOT a thrown exception) so the model sees a recoverable
      // tool failure rather than a crash.
      return JSON.stringify({
        error: (err as Error).message,
      });
    }

    let body: string;
    try {
      // Try the literal path first; if it doesn't exist, try `<path>.md`
      // (matches the scaffolded example dir convention where `/mission` is
      // backed by `mission.md`). This is a convenience for file://-mode
      // operators; HTTP-mode behavior is unchanged.
      body = await readFile(resolved, "utf-8").catch(async (err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT" || e.code === "EISDIR") {
          // Try .md fallback under the same boundary check.
          const mdResolved = await safeResolveUnderBase(realBase, `${path}.md`);
          return await readFile(mdResolved, "utf-8");
        }
        throw err;
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return JSON.stringify({
          error: `Org content for ${path} not found under ${fileBasePath}`,
        });
      }
      if (e.code === "EISDIR") {
        return JSON.stringify({
          error: `Org content for ${path} is a directory, not a file`,
        });
      }
      return JSON.stringify({
        error: `Failed to read ${path}: ${(err as Error).message}`,
      });
    }

    const maxChars = 20_000;
    const truncated =
      body.length > maxChars
        ? `${body.slice(0, maxChars)}\n\n[truncated — ${body.length} total chars]`
        : body;

    return JSON.stringify({
      endpoint: path,
      content: truncated,
      ...(prompt ? { prompt } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // knowledge_fetch tool — HTTP branch (unchanged)
  // ---------------------------------------------------------------------------

  async function fetchFromHttp(endpoint: string, prompt?: string): Promise<string> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    // High-1: allowlist runs first. Same shape as the file:// branch — manifest
    // is the authoritative endpoint contract regardless of transport.
    const allowlistError = await checkManifestAllowlist(path);
    if (allowlistError) return allowlistError;

    try {
      const res = await client.get(`${httpBaseUrl}${path}`);
      if (res.status !== 200) {
        return JSON.stringify({
          error: `Org API returned ${res.status} for ${path}`,
        });
      }

      try {
        const data = JSON.parse(res.body) as { files?: Array<{ name: string; content: string }> };
        if (data.files && Array.isArray(data.files)) {
          const content = data.files.map((f) => `## ${f.name}\n\n${f.content}`).join("\n\n---\n\n");

          const maxChars = 20_000;
          const truncated =
            content.length > maxChars
              ? `${content.slice(0, maxChars)}\n\n[truncated — ${content.length} total chars]`
              : content;

          return JSON.stringify({
            endpoint: path,
            fileCount: data.files.length,
            content: truncated,
            ...(prompt ? { prompt } : {}),
          });
        }
      } catch {
        // Not JSON or not the expected format — return raw body.
      }

      return JSON.stringify({
        endpoint: path,
        content: res.body.slice(0, 20_000),
      });
    } catch (err) {
      return JSON.stringify({
        error: `Failed to fetch ${path}: ${(err as Error).message}`,
        hint: "The org API may be temporarily unreachable.",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // knowledge_fetch tool
  // ---------------------------------------------------------------------------

  const manifestFetchTool = defineTool({
    name: "knowledge_fetch",
    description:
      "Fetch knowledge from the organization's API. Use the endpoint paths from the manifest.",
    category: "search",
    input: z.object({
      endpoint: z
        .string()
        .describe("The endpoint path (e.g. '/vision', '/initiatives', '/solutions/architecture')"),
      prompt: z.string().optional().describe("Optional: what you want to know from the content"),
    }),
    execute: async ({ endpoint, prompt }) => {
      if (isFile) {
        return fetchFromFile(endpoint, prompt);
      }
      return fetchFromHttp(endpoint, prompt);
    },
  });

  // ---------------------------------------------------------------------------
  // Augment
  // ---------------------------------------------------------------------------

  const adminInfo = async (): Promise<import("../../types").AdminInfoBlock> => {
    const manifest = await fetchManifest().catch(() => null);
    const scheme = isFile ? "file://" : opts.baseUrl.startsWith("https") ? "https" : "http";
    return {
      augmentName: "org-context",
      title: "Org context",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Base URL", value: opts.baseUrl },
            { label: "Scheme", value: scheme },
            { label: "Token configured", value: opts.token ? "yes" : "no" },
            { label: "Cache TTL (ms)", value: String(opts.cacheTtlMs ?? 60 * 60 * 1000) },
          ],
        },
        manifest
          ? {
              kind: "keyValue" as const,
              rows: [
                { label: "Org", value: manifest.org },
                { label: "Purpose", value: manifest.purpose },
                ...(manifest.creator ? [{ label: "Creator", value: manifest.creator }] : []),
                ...(manifest.phase ? [{ label: "Phase", value: manifest.phase }] : []),
                { label: "Endpoints", value: String(manifest.endpoints.length) },
              ],
            }
          : {
              kind: "status" as const,
              level: "warn" as const,
              message: "Manifest not currently loaded — will retry on next org_fetch call.",
            },
        ...(manifest
          ? [
              {
                kind: "table" as const,
                columns: ["Path", "Method", "Description"],
                rows: manifest.endpoints.map((e) => [e.path, e.method ?? "GET", e.description]),
              },
            ]
          : []),
      ],
    };
  };

  return {
    name: "knowledge",
    type: "knowledge",
    category: "memory",
    tools: [manifestFetchTool],
    adminInfo,

    context: async () => {
      const manifest = await fetchManifest();
      if (!manifest) return [];

      const block: ContextBlock = {
        source: "knowledge",
        content: buildContextBlock(manifest),
        placement: "system",
        priority: "required",
        eviction: "never",
        origin: "operator",
        provenance: "augment",
        ttl: "persistent",
      };

      return [block];
    },

    onBoot: async () => {
      // file:// scheme: single attempt — no retry, the disk doesn't need
      // network warmup. HTTP scheme: existing 0/2/5 second retry.
      if (isFile) {
        const manifest = await fetchManifest(true);
        if (manifest) {
          console.log(
            `[knowledge] loaded local knowledge for ${manifest.org} (${manifest.endpoints.length} endpoints)`,
          );
        } else {
          console.warn(
            `[knowledge] file:// manifest at ${fileBasePath}/manifest unreadable — running without a loaded manifest. Will retry on first knowledge_fetch call.`,
          );
        }
        return;
      }

      const delays = [0, 2000, 5000];
      let manifest: Manifest | null = null;

      for (let i = 0; i < delays.length; i++) {
        if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
        manifest = await fetchManifest(true);
        if (manifest) break;
        if (i < delays.length - 1) {
          console.warn(
            `[knowledge] manifest fetch failed, retrying in ${delays[i + 1]! / 1000}s...`,
          );
        }
      }

      if (manifest) {
        console.log(
          `[knowledge] loaded remote knowledge for ${manifest.org} (${manifest.endpoints.length} endpoints)`,
        );
      } else {
        console.warn(
          "[knowledge] org API unreachable — running without a loaded manifest. Will retry on first knowledge_fetch call.",
        );
      }
    },
  };
}
