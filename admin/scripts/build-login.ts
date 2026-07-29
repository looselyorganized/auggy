import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";
import { LOGIN_VARIANTS } from "../src/LoginPage";
import {
  createLoginArtifactEntry,
  createLoginManifest,
  LOGIN_HTML_PATHS,
  LOGIN_MANIFEST_FILENAME,
  renderLoginDocument,
  serializeLoginManifest,
  verifyLoginArtifactDirectory,
} from "./login-artifacts";

const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(adminRoot, "dist");
const defaultDestination = resolve(distRoot, "login");
const loginCssSource = resolve(adminRoot, "src/login.css");

interface BuildLoginArtifactsOptions {
  destination?: string;
}

export async function buildLoginArtifacts(options: BuildLoginArtifactsOptions = {}): Promise<void> {
  const destination = resolve(options.destination ?? defaultDestination);
  if (basename(destination) !== "login") {
    throw new Error("login artifact destination must end in /login");
  }
  const staging = resolve(dirname(destination), ".login-staging");
  rmSync(staging, { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });

  const result = await build({
    configFile: false,
    publicDir: false,
    plugins: [tailwindcss()],
    logLevel: "warn",
    build: {
      write: false,
      sourcemap: false,
      target: "es2022",
      rollupOptions: {
        input: loginCssSource,
        output: {
          assetFileNames: "assets/login-[hash][extname]",
        },
      },
    },
  });

  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  const emitted = outputs.flatMap((output) => output.output);
  const chunks = emitted.filter((item): item is Rollup.OutputChunk => item.type === "chunk");
  const assets = emitted.filter((item): item is Rollup.OutputAsset => item.type === "asset");
  const cssAssets = assets.filter((asset) => asset.fileName.endsWith(".css"));
  if (chunks.length !== 0 || assets.length !== 1 || cssAssets.length !== 1) {
    throw new Error("login CSS build must emit exactly one CSS asset and no JavaScript");
  }

  const cssAsset = cssAssets[0];
  if (!cssAsset || !/^assets\/login-[A-Za-z0-9_-]{6,64}\.css$/.test(cssAsset.fileName)) {
    throw new Error("login CSS build emitted an invalid fingerprinted path");
  }
  const cssBytes =
    typeof cssAsset.source === "string"
      ? Buffer.from(cssAsset.source, "utf8")
      : Buffer.from(cssAsset.source);
  if (cssBytes.byteLength === 0) throw new Error("login CSS build emitted an empty stylesheet");

  const files = new Map<string, Uint8Array>();
  files.set(cssAsset.fileName, cssBytes);
  const entries = [createLoginArtifactEntry("stylesheet", cssAsset.fileName, cssBytes)];
  for (const variant of LOGIN_VARIANTS) {
    const path = LOGIN_HTML_PATHS[variant];
    const document = renderLoginDocument(variant, cssAsset.fileName);
    const bytes = Buffer.from(document, "utf8");
    files.set(path, bytes);
    entries.push(createLoginArtifactEntry(variant, path, bytes));
  }
  const manifest = createLoginManifest(entries);

  mkdirSync(staging, { recursive: true });
  try {
    for (const [path, content] of [...files].sort(([left], [right]) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    })) {
      const destinationPath = resolve(staging, ...path.split("/"));
      mkdirSync(dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, content, { flag: "wx" });
    }
    writeFileSync(resolve(staging, LOGIN_MANIFEST_FILENAME), serializeLoginManifest(manifest), {
      flag: "wx",
    });
    verifyLoginArtifactDirectory(staging);

    renameSync(staging, destination);
    verifyLoginArtifactDirectory(destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  await buildLoginArtifacts();
}
