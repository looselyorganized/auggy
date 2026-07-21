import { join } from "node:path";

const root = import.meta.dir;
const build = await Bun.build({
  entrypoints: [join(root, "app.ts")],
  outdir: join(root, "dist"),
  naming: "app.js",
  target: "browser",
  minify: false,
});

if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error("Storefront browser build failed.");
}

const server = Bun.serve({
  port: 3000,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/index.html") {
      return fileResponse(join(root, "index.html"), "text/html; charset=utf-8");
    }
    if (path === "/styles.css") {
      return fileResponse(join(root, "styles.css"), "text/css; charset=utf-8");
    }
    if (path === "/app.js") {
      return fileResponse(join(root, "dist", "app.js"), "text/javascript; charset=utf-8");
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Storefront frontend: ${server.url}`);
console.log("Auggy backend: http://localhost:8088");

function fileResponse(path: string, contentType: string): Response {
  return new Response(Bun.file(path), {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
