import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  map: "application/json",
};

/**
 * Resolve the admin SPA's `dist/` directory. v1 honors the working-copy
 * (`auggy/admin/dist/`); a future revision will also look in the
 * download cache at `~/.auggy/admin/<version>/dist/`. The whole admin
 * transport degrades to a build-required notice if no dist is found.
 */
export function resolveDistDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../../admin/dist");
  if (existsSync(join(candidate, "index.html"))) return candidate;
  return undefined;
}

/**
 * Read a file from `staticDir` if and only if the resolved path stays
 * inside the directory. Returns `null` when the file does not exist;
 * returns 403 on traversal and 503 when the runtime cannot prove the opened
 * descriptor's canonical path.
 */
const STATIC_FILE_OPEN_FLAGS =
  constants.O_RDONLY |
  (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

interface StaticFileTestHooks {
  beforeOpen?: (canonicalFile: string) => void;
  afterOpen?: (descriptor: number, canonicalFile: string) => void;
  resolveOpenedPath?: (descriptor: number) => string | undefined;
  beforeRead?: (descriptor: number, canonicalFile: string) => void;
  afterClose?: (descriptor: number) => void;
}

export function serveStaticFile(staticDir: string, relativePath: string): Response | null {
  return serveStaticFileWithHooks(staticDir, relativePath);
}

/** @internal Deterministic filesystem-race seam for security tests. */
export function serveStaticFileWithHooks(
  staticDir: string,
  relativePath: string,
  hooks: StaticFileTestHooks = {},
): Response | null {
  const rootPath = resolve(staticDir);
  const filePath = resolve(rootPath, relativePath);
  if (!isWithin(rootPath, filePath)) return staticFailureResponse(403, "forbidden");

  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = realpathSync(rootPath);
    canonicalFile = realpathSync(filePath);
  } catch {
    return null;
  }
  if (!isWithin(canonicalRoot, canonicalFile)) {
    return staticFailureResponse(403, "forbidden");
  }

  let descriptor: number;
  try {
    hooks.beforeOpen?.(canonicalFile);
    descriptor = openSync(canonicalFile, STATIC_FILE_OPEN_FLAGS);
  } catch {
    return null;
  }

  let content: Buffer;
  try {
    hooks.afterOpen?.(descriptor, canonicalFile);
    const openedFile = fstatSync(descriptor, { bigint: true });
    if (!openedFile.isFile()) return null;

    const openedPath = hooks.resolveOpenedPath
      ? hooks.resolveOpenedPath(descriptor)
      : resolveOpenedDescriptorPath(descriptor);
    if (!openedPath) return staticFailureResponse(503);
    if (!isWithin(canonicalRoot, openedPath)) {
      return staticFailureResponse(403, "forbidden");
    }

    hooks.beforeRead?.(descriptor, canonicalFile);
    content = readFileSync(descriptor);
  } catch {
    // Treat deletion or replacement during validation as a miss. Static
    // serving must not turn a filesystem race into a 500 or reopen a path.
    return null;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // A successfully opened descriptor is best-effort closed on every path.
    }
    try {
      hooks.afterClose?.(descriptor);
    } catch {
      // Test instrumentation must not affect production failure semantics.
    }
  }
  const ext = canonicalFile.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store, must-revalidate",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function resolveOpenedDescriptorPath(descriptor: number): string | undefined {
  const descriptorPaths =
    process.platform === "linux"
      ? [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${descriptor}`, `/proc/self/fd/${descriptor}`];

  for (const descriptorPath of descriptorPaths) {
    try {
      return realpathSync.native(descriptorPath);
    } catch {
      // Try the next platform convention; the caller fails closed if none work.
    }
  }
  return undefined;
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const rootWithSep = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  return candidatePath === rootPath || candidatePath.startsWith(rootWithSep);
}

export function staticFailureResponse(
  status: 403 | 404 | 503,
  body: string | null = null,
): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

const BUILD_REQUIRED_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Console SPA not built</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
    code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 0.9em; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    .hint { color: #666; }
  </style>
</head>
<body>
  <h1>Console SPA not built</h1>
  <p>The <code>/console</code> surface needs a built SPA in <code>auggy/admin/dist/</code>.</p>
  <p>Build it from a working copy:</p>
  <pre>cd auggy
bun install
bun run build:admin</pre>
  <p class="hint">Once built, refresh this page. POST <code>/console/action/*</code> still works in the meantime.</p>
</body>
</html>`;

export function buildRequiredResponse(): Response {
  return new Response(BUILD_REQUIRED_HTML, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
