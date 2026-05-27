import { existsSync, readFileSync, statSync } from "node:fs";
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
  woff: "font-woff",
  woff2: "font-woff2",
  map: "application/json",
};

/**
 * Resolve the admin SPA's `dist/` directory. v1 honors the working-copy
 * (`augment-1/admin/dist/`); a future revision will also look in the
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
 * returns a 403 Response on traversal attempts.
 */
export function serveStaticFile(staticDir: string, relativePath: string): Response | null {
  const filePath = join(staticDir, relativePath);
  const dirWithSep = staticDir.endsWith(sep) ? staticDir : staticDir + sep;
  if (!filePath.startsWith(dirWithSep) && filePath !== staticDir) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(filePath)) return null;
  if (!statSync(filePath).isFile()) return null;
  const content = readFileSync(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store, must-revalidate",
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
  <p>The <code>/console</code> surface needs a built SPA in <code>augment-1/admin/dist/</code>.</p>
  <p>Build it from a working copy:</p>
  <pre>cd augment-1/admin
bun install
bun run build</pre>
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
