/** Build an exact finite command set locally. No network or hosted actions. */
import { closeSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPinnedFile, pinDirectory } from "../../src/lib/anchored-files";
import { readBoundedRegularFile } from "./bounded-file";
import {
  HOSTED_COMMAND_FLAGS,
  HOSTED_COMMAND_LIMITS,
  hostedCommandHash,
  parseHostedCommandRegistry,
  type HostedCommandRegistry,
} from "./integration-fixtures/hosted/remote-command";
export type {
  HostedCommandAcknowledgement,
  HostedCommandReceipt,
  HostedCommandReadRequest,
  HostedCommandRequest,
} from "./integration-fixtures/hosted/remote-command";

export interface PreparedHostedCommandFixture {
  directory: string;
  entry: string;
  entrySHA256: string;
  registrySHA256: string;
  registry: HostedCommandRegistry;
  files: { path: string; sha256: string; bytes: number }[];
  /** Replace only entry's directory when copying these exact bytes into a container. */
  launchArgs: string[];
}
export async function prepareHostedCommandFixture(options: {
  destination: string;
  commands: { commandId: string; sourcePath: string; timeoutMs: number; envKeys?: string[] }[];
}): Promise<PreparedHostedCommandFixture> {
  const registry: HostedCommandRegistry = {
    version: 1,
    commands: options.commands.map((command) => ({
      commandId: command.commandId,
      script: `commands/${command.commandId}.js`,
      sourceSHA256: "0".repeat(64),
      timeoutMs: command.timeoutMs,
      envKeys: command.envKeys ?? [],
    })),
  };
  parseHostedCommandRegistry(Buffer.from(JSON.stringify(registry)));
  mkdirSync(options.destination, { mode: 0o700 });
  const root = pinDirectory(options.destination, "Hosted command build");
  const files: PreparedHostedCommandFixture["files"] = [];
  function write(name: string, bytes: Uint8Array) {
    if (bytes.byteLength > HOSTED_COMMAND_LIMITS.bytes)
      throw new Error("Hosted fixture file exceeds bounds");
    const parent = pinDirectory(join(root.canonical, dirname(name)), "Hosted fixture output");
    try {
      const leaf = name.split("/").at(-1)!;
      if (!createPinnedFile(parent.fd, leaf, bytes, "Exclusive hosted fixture output"))
        throw new Error("Hosted fixture output already exists");
      files.push({ path: name, sha256: hostedCommandHash(bytes), bytes: bytes.byteLength });
    } finally {
      closeSync(parent.fd);
    }
  }
  try {
    mkdirSync(join(root.canonical, "commands"), { mode: 0o700 });
    for (let index = 0; index < options.commands.length; index++) {
      const command = options.commands[index]!;
      readBoundedRegularFile(command.sourcePath, HOSTED_COMMAND_LIMITS.bytes);
      const result = await Bun.build({
        entrypoints: [command.sourcePath],
        target: "bun",
        format: "esm",
        minify: false,
        sourcemap: "none",
      });
      if (!result.success || result.outputs.length !== 1)
        throw new Error("Could not bundle reviewed hosted command");
      const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer());
      registry.commands[index]!.sourceSHA256 = hostedCommandHash(bytes);
      write(registry.commands[index]!.script, bytes);
    }
    const registryBytes = Buffer.from(`${JSON.stringify(registry)}\n`);
    const registrySHA256 = hostedCommandHash(registryBytes);
    write("commands.json", registryBytes);
    const result = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("./integration-fixtures/hosted/remote-command.ts", import.meta.url)),
      ],
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
      define: { HOSTED_REGISTRY_SHA256: JSON.stringify(registrySHA256) },
    });
    if (!result.success || result.outputs.length !== 1)
      throw new Error("Could not bundle hosted command envelope");
    const entryBytes = new Uint8Array(await result.outputs[0]!.arrayBuffer());
    write("remote-command.js", entryBytes);
    const entry = join(root.canonical, "remote-command.js");
    const entrySHA256 = hostedCommandHash(entryBytes);
    return {
      directory: root.canonical,
      entry,
      entrySHA256,
      registrySHA256,
      registry,
      files,
      launchArgs: [...HOSTED_COMMAND_FLAGS, entry, entrySHA256],
    };
  } finally {
    closeSync(root.fd);
  }
}
