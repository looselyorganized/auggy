import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const TEST_AGENT_ID = "aug1_12345678-1234-1234-1234-123456789abc";
export interface TarEntry {
  name: string;
  bytes?: Uint8Array;
  type?: string;
  size?: number;
}

export function tarball(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${(entry.size ?? bytes.length).toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function packageArchive(name: string, dependencies?: Record<string, string>): Buffer {
  return tarball([
    {
      name: "package/package.json",
      bytes: Buffer.from(
        JSON.stringify({ name, version: "1.0.0", ...(dependencies ? { dependencies } : {}) }),
      ),
    },
    {
      name: "package/index.ts",
      bytes: Buffer.from('throw new Error("PROJECT_IMPORT_MUST_NOT_RUN");\n'),
    },
  ]);
}

export function fixture(project: string, augments: unknown[] = []): void {
  mkdirSync(join(project, "vendor"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "vendor", "auggy.tgz"), packageArchive("auggy"));
  writeFileSync(
    join(project, "src", "index.ts"),
    'throw new Error("PROJECT_IMPORT_MUST_NOT_RUN");\n',
  );
  writeFileSync(join(project, "identity.md"), "Operator-owned identity.\n");
  writeFileSync(
    join(project, "agent.yaml"),
    JSON.stringify({
      id: TEST_AGENT_ID,
      name: "fixture",
      identity: "./identity.md",
      application: { contractVersion: 1, entrypoint: "./src/index.ts" },
      augments,
    }),
  );
  const dependencies = { auggy: "file:./vendor/auggy.tgz" };
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "fixture", dependencies }));
  writeFileSync(
    join(project, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: { "": { name: "fixture", dependencies } },
      packages: { auggy: ["auggy@./vendor/auggy.tgz", {}, "sha512-fixture"] },
    }),
  );
}
