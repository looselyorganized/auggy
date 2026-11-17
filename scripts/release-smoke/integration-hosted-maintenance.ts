/** Preparation and bounded transfer for the one approved offline rehearsal. */
import { closeSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { createPinnedFile, pinDirectory } from "../../src/lib/anchored-files";
import {
  prepareHostedCommandFixture,
  type PreparedHostedCommandFixture,
} from "./integration-hosted-command-fixture";
import {
  MAINTENANCE_LIMITS,
  createMaintenanceBundleDirectories,
  decodeMaintenanceTransfer,
  indexMaintenanceBundle,
  parseHostedMaintenanceOperation,
  readMaintenanceBundleFile,
  writeMaintenanceBundleFile,
  type HostedMaintenanceOperation,
  type HostedMaintenanceStopped,
  type HostedRailwayMaintenanceStopped,
} from "./integration-fixtures/hosted/maintenance-command";
export { MAINTENANCE_LIMITS } from "./integration-fixtures/hosted/maintenance-command";
export type {
  HostedMaintenanceOperation,
  HostedMaintenanceStopped,
  HostedRailwayMaintenanceStopped,
} from "./integration-fixtures/hosted/maintenance-command";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function prepareHostedMaintenanceFixtures(destination: string) {
  return prepareHostedCommandFixture({
    destination,
    commands: [
      {
        commandId: "maintenance",
        sourcePath: fileURLToPath(
          new URL("./integration-fixtures/hosted/maintenance-command.ts", import.meta.url),
        ),
        timeoutMs: MAINTENANCE_LIMITS.commandMs,
      },
    ],
  });
}
/** Preserve the real runtime inventory config; select a separate none-profile export document. */
export function prepareHostedMaintenanceExportConfig(consumer: string) {
  const original = readFileSync(join(consumer, "agent.yaml"));
  const config = parse(original.toString("utf8"));
  check(
    typeof config.id === "string" &&
      (config.application?.contractVersion === 1 || config.application?.contractVersion === 2),
    "Expected owned application configuration",
  );
  const maintenance = Buffer.from(
    `# Fixture-only no-ingress export. The direct Bun entrypoint owns offline maintenance.\n${stringify({ ...config, augments: [], application: { ...config.application, entrypoint: "./src/fixtures/g4-maintenance/commands/maintenance.js" } })}`,
  );
  const directory = pinDirectory(consumer, "Maintenance source configuration");
  try {
    check(
      createPinnedFile(
        directory.fd,
        "maintenance.yaml",
        maintenance,
        "Exclusive maintenance config",
      ),
      "Maintenance config exists",
    );
  } finally {
    closeSync(directory.fd);
  }
  check(
    hash(readFileSync(join(consumer, "agent.yaml"))) === hash(original),
    "Runtime config changed",
  );
  return {
    runtimeConfig: { path: "agent.yaml", sha256: hash(original) },
    exportConfig: { path: "maintenance.yaml", sha256: hash(maintenance) },
    agentId: config.id,
  };
}
/** Only call on a newly exported --ingress none context; record this exact overlay. */
export function installHostedMaintenanceEntrypoint(
  context: string,
  prepared: PreparedHostedCommandFixture,
) {
  const deployment = JSON.parse(readFileSync(join(context, "auggy-deployment.json"), "utf8"));
  check(deployment.profile?.kind === "none", "Maintenance requires a no-ingress export");
  const path = join(context, "Dockerfile");
  const before = readFileSync(path, "utf8");
  check(!/^EXPOSE\s|^ENV PORT=/m.test(before), "Maintenance image declares ingress");
  const lines = before.split("\n").filter((line) => line.startsWith("ENTRYPOINT "));
  check(lines.length === 1, "Maintenance entrypoint anchor changed");
  const command = prepared.registry.commands.find((entry) => entry.commandId === "maintenance");
  check(command && prepared.registry.commands.length === 1, "Maintenance registry changed");
  check(prepared.files.length === 3, "Maintenance fixture inventory changed");
  for (const file of prepared.files) {
    check(
      ["commands/maintenance.js", "commands.json", "remote-command.js"].includes(file.path),
      "Unexpected maintenance artifact",
    );
    check(
      hash(readFileSync(join(context, "src/fixtures/g4-maintenance", file.path))) === file.sha256,
      "Exported maintenance artifact differs from preparation",
    );
  }
  const directory = "/app/src/fixtures/g4-maintenance";
  const after = before.replace(
    lines[0]!,
    `RUN chmod 700 ${directory}\nENTRYPOINT ${JSON.stringify(["bun", "--no-env-file", "--no-install", "--config=/dev/null", `${directory}/${command.script}`, "--hold"])}`,
  );
  writeFileSync(path, after, { mode: 0o600 });
  return {
    path: "Dockerfile",
    beforeSHA256: hash(before),
    afterSHA256: hash(after),
    entry: `${directory}/remote-command.js`,
    entrySHA256: prepared.entrySHA256,
    registrySHA256: prepared.registrySHA256,
  };
}
/** Platform/controller observation is separate from the command's local lease check. */
export function persistHostedMaintenanceStopped(options: {
  evidenceDirectory: string;
  name: string;
  runtimeId: string;
  volumeId: string;
  status: { running: boolean; exitCode: number };
  observedAtMs: number;
}): HostedMaintenanceStopped {
  check(/^[a-z][a-z0-9-]{0,63}\.json$/.test(options.name), "Invalid stopped receipt name");
  const record = {
    version: 1,
    runtimeId: options.runtimeId,
    volumeId: options.volumeId,
    ...options.status,
    observedAtMs: options.observedAtMs,
  };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const proof = {
    runtimeId: options.runtimeId,
    volumeId: options.volumeId,
    ...options.status,
    observedAtMs: options.observedAtMs,
    controllerReceiptSHA256: hash(bytes),
  };
  const parsed = parseHostedMaintenanceOperation({ operation: "backup", stopped: proof });
  check(parsed.operation === "backup", "Stopped proof changed");
  const directory = pinDirectory(options.evidenceDirectory, "Stopped controller receipt");
  try {
    check(
      createPinnedFile(directory.fd, options.name, bytes, "Exclusive stopped proof"),
      "Stopped receipt exists",
    );
  } finally {
    closeSync(directory.fd);
  }
  return parsed.stopped;
}
/** Controller must bind the actual complete readback to its prior instance and fixture receipts. */
export function persistHostedRailwayMaintenanceStopped(options: {
  evidenceDirectory: string;
  name: string;
  observation: Omit<HostedRailwayMaintenanceStopped, "controllerReceiptSHA256">;
}): HostedRailwayMaintenanceStopped {
  check(/^[a-z][a-z0-9-]{0,63}\.json$/.test(options.name), "Invalid stopped receipt name");
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, ...options.observation })}\n`);
  const parsed = parseHostedMaintenanceOperation({
    operation: "backup",
    stopped: { ...options.observation, controllerReceiptSHA256: hash(bytes) },
  });
  check(
    parsed.operation === "backup" &&
      "provider" in parsed.stopped &&
      parsed.stopped.provider === "railway",
    "Expected Railway stopped observation",
  );
  const directory = pinDirectory(options.evidenceDirectory, "Railway stopped controller receipt");
  try {
    check(
      createPinnedFile(directory.fd, options.name, bytes, "Exclusive Railway stopped proof"),
      "Stopped receipt exists",
    );
  } finally {
    closeSync(directory.fd);
  }
  return parsed.stopped;
}
/** Caller must validate the enclosing envelope receipt and own its command deadline. */
export type HostedMaintenanceControl = (
  payload: HostedMaintenanceOperation,
) => Promise<Record<string, unknown>>;
async function control(call: HostedMaintenanceControl, operation: HostedMaintenanceOperation) {
  const result = await call(operation);
  check(result.operation === operation.operation, "Maintenance result operation mismatch");
  return result;
}
export async function exportHostedMaintenanceBundle(options: {
  directory: string;
  control: HostedMaintenanceControl;
}) {
  const exported = await control(options.control, { operation: "export-manifest" });
  check(
    typeof exported.base64 === "string" && typeof exported.manifestSHA256 === "string",
    "Invalid exported manifest",
  );
  const bytes = decodeMaintenanceTransfer(
    exported.base64,
    exported.manifestSHA256,
    MAINTENANCE_LIMITS.manifestBytes,
  );
  const index = indexMaintenanceBundle(bytes);
  mkdirSync(options.directory, { mode: 0o700 });
  mkdirSync(join(options.directory, "payload"), { mode: 0o700 });
  writeMaintenanceBundleFile(options.directory, "manifest.json", bytes);
  createMaintenanceBundleDirectories(options.directory, index);
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex++) {
    const entry = index.files[fileIndex]!;
    const result = await control(options.control, { operation: "export-file", index: fileIndex });
    check(
      result.index === fileIndex &&
        result.path === entry.path &&
        result.bytes === entry.bytes &&
        result.sha256 === entry.sha256 &&
        typeof result.base64 === "string",
      "Exported file binding changed",
    );
    const data = decodeMaintenanceTransfer(
      result.base64,
      entry.sha256,
      MAINTENANCE_LIMITS.fileBytes,
    );
    check(data.byteLength === entry.bytes, "Exported byte count changed");
    writeMaintenanceBundleFile(join(options.directory, "payload"), entry.path, data);
  }
  return { directory: options.directory, ...index };
}
export async function importHostedMaintenanceBundle(options: {
  directory: string;
  control: HostedMaintenanceControl;
}) {
  const bytes = readMaintenanceBundleFile(
    options.directory,
    "manifest.json",
    MAINTENANCE_LIMITS.manifestBytes,
  );
  const index = indexMaintenanceBundle(bytes);
  const imported = await control(options.control, {
    operation: "import-manifest",
    base64: bytes.toString("base64"),
    sha256: index.manifestSHA256,
  });
  check(imported.manifestSHA256 === index.manifestSHA256, "Imported manifest identity changed");
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex++) {
    const entry = index.files[fileIndex]!;
    const data = readMaintenanceBundleFile(
      join(options.directory, "payload"),
      entry.path,
      MAINTENANCE_LIMITS.fileBytes,
    );
    check(
      data.byteLength === entry.bytes && hash(data) === entry.sha256,
      "Controller backup changed before import",
    );
    const result = await control(options.control, {
      operation: "import-file",
      index: fileIndex,
      base64: data.toString("base64"),
      sha256: entry.sha256,
    });
    check(
      result.index === fileIndex && result.sha256 === entry.sha256 && result.bytes === entry.bytes,
      "Imported file identity changed",
    );
  }
  const verified = await control(options.control, { operation: "verify" });
  check(
    verified.manifestSHA256 === index.manifestSHA256,
    "Verified remote bundle identity changed",
  );
  return index;
}
