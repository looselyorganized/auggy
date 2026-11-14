/**
 * Finite rehearsal commands only; never install this as a public executor.
 * The controller supplies the reviewed bundle hash. Its private container files
 * and reviewed scripts are trusted: hashes do not sandbox arbitrary code or a
 * malicious filesystem owner. Commands must not detach from their owned group.
 * A claim without a committed receipt is unknown, never permission to replay.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPinnedFile,
  openPinnedChildDirectory,
  pinDirectory,
  readPinnedFile,
} from "../../../../src/lib/anchored-files";
import { startApplicationChild } from "../../application-child";
import { readBoundedRegularFile } from "../../bounded-file";

declare const HOSTED_REGISTRY_SHA256: string;
export const HOSTED_COMMAND_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  resultBytes: 1024 * 1024,
  inputMs: 5_000,
  outputMs: 5_000,
  commandMs: 60_000,
  commands: 16,
});
export const HOSTED_COMMAND_FLAGS = [
  "--no-env-file",
  "--no-install",
  "--config=/dev/null",
] as const;
const CONTROL_TOKEN = "AUGGY_FIXTURE_CONTROL_TOKEN";
const GENERATION_ID = "AUGGY_FIXTURE_GENERATION_ID";
export interface HostedCommandDefinition {
  commandId: string;
  script: string;
  sourceSHA256: string;
  timeoutMs: number;
  envKeys: string[];
}
export interface HostedCommandRegistry {
  version: 1;
  commands: HostedCommandDefinition[];
}
export interface HostedCommandRequest {
  version: 1;
  operation: "execute";
  requestId: string;
  commandId: string;
  payload: Record<string, unknown>;
}
export interface HostedCommandReadRequest {
  version: 1;
  operation: "read-receipt";
  requestId: string;
}
/** Command stdout must be exactly one such acknowledgement, with no logging. */
export interface HostedCommandAcknowledgement {
  version: 1;
  requestId: string;
  commandId: string;
  inputSHA256: string;
  result: unknown;
}
export interface HostedCommandReceipt {
  version: 1;
  requestId: string;
  commandId: string;
  inputSHA256: string;
  registrySHA256: string;
  bundleSHA256: string;
  sourceSHA256: string;
  status: "passed" | "failed";
  interrupted: string | null;
  acknowledged: boolean;
  result: unknown;
  child: {
    exitCode: number | null;
    signal: string | null;
    spawnFailed: boolean;
    timedOut: boolean;
    exceededOutput: boolean;
    orphanedGroup: boolean;
    cleanupConfirmed: boolean;
    inputComplete: boolean;
    inputFailed: boolean;
    stdoutSHA256: string;
    stderrSHA256: string;
  } | null;
}
export function hostedCommandHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function check(value: unknown, message = "Rejected hosted command"): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  check(Object.keys(value).length === expected.length && expected.every((key) => key in value));
}
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const digest = /^[a-f0-9]{64}$/;
export function parseHostedCommandRequest(
  bytes: Uint8Array,
): HostedCommandRequest | HostedCommandReadRequest {
  check(bytes.byteLength > 0 && bytes.byteLength <= HOSTED_COMMAND_LIMITS.bytes);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  object(value);
  check(
    value.version === 1 && typeof value.requestId === "string" && identifier.test(value.requestId),
  );
  if (value.operation === "read-receipt") {
    keys(value, ["version", "operation", "requestId"]);
  } else {
    keys(value, ["version", "operation", "requestId", "commandId", "payload"]);
    check(
      value.operation === "execute" &&
        typeof value.commandId === "string" &&
        identifier.test(value.commandId),
    );
    object(value.payload);
  }
  return value as unknown as HostedCommandRequest | HostedCommandReadRequest;
}
export function parseHostedCommandRegistry(bytes: Uint8Array): HostedCommandRegistry {
  check(bytes.byteLength <= HOSTED_COMMAND_LIMITS.bytes);
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  object(value);
  keys(value, ["version", "commands"]);
  check(
    value.version === 1 &&
      Array.isArray(value.commands) &&
      value.commands.length > 0 &&
      value.commands.length <= HOSTED_COMMAND_LIMITS.commands,
  );
  const seen = new Set<string>();
  for (const entry of value.commands) {
    object(entry);
    keys(entry, ["commandId", "script", "sourceSHA256", "timeoutMs", "envKeys"]);
    check(
      typeof entry.commandId === "string" &&
        identifier.test(entry.commandId) &&
        !seen.has(entry.commandId),
    );
    seen.add(entry.commandId);
    check(entry.script === `commands/${entry.commandId}.js`);
    check(typeof entry.sourceSHA256 === "string" && digest.test(entry.sourceSHA256));
    check(
      typeof entry.timeoutMs === "number" &&
        Number.isSafeInteger(entry.timeoutMs) &&
        entry.timeoutMs > 0 &&
        entry.timeoutMs <= HOSTED_COMMAND_LIMITS.commandMs,
    );
    check(
      Array.isArray(entry.envKeys) &&
        entry.envKeys.length <= 16 &&
        new Set(entry.envKeys).size === entry.envKeys.length,
    );
    // Additional environment inputs require review, not generic forwarding.
    for (const key of entry.envKeys) check(key === CONTROL_TOKEN || key === GENERATION_ID);
  }
  return value as unknown as HostedCommandRegistry;
}

function readInput(registerCancel: (cancel: () => void) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", data).off("end", end).off("error", failed).off("close", closed);
      process.stdin.pause();
      registerCancel(() => {});
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const failed = () => finish(new Error("Input failed"));
    const closed = () => finish(new Error("Input closed before EOF"));
    const end = () => finish();
    const data = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > HOSTED_COMMAND_LIMITS.bytes) failed();
      else chunks.push(chunk);
    };
    const timer = setTimeout(failed, HOSTED_COMMAND_LIMITS.inputMs);
    registerCancel(failed);
    process.stdin.on("data", data).once("end", end).once("error", failed).once("close", closed);
  });
}

/** A stalled/disconnected caller cannot keep a finished remote envelope alive. */
async function publish(bytes: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) process.stdout.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), HOSTED_COMMAND_LIMITS.outputMs);
    process.stdout.once("error", () => finish(false));
    process.stdout.write(bytes, (error) => finish(!error));
  });
}

export async function runHostedCommandEnvelope(): Promise<boolean> {
  let child: ReturnType<typeof startApplicationChild> | undefined;
  let cancelInput = () => {};
  let interrupted: string | null = null;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = () => {
      interrupted ??= signal;
      cancelInput();
      child?.signal("SIGKILL");
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  let rootFd: number | undefined;
  let receiptsFd: number | undefined;
  try {
    check(process.versions.bun && process.argv.length === 3 && digest.test(process.argv[2]!));
    const bundleSHA256 = hostedCommandHash(
      readBoundedRegularFile(import.meta.path, HOSTED_COMMAND_LIMITS.bytes).bytes,
    );
    check(bundleSHA256 === process.argv[2]);
    const root = pinDirectory(dirname(import.meta.path), "Hosted command fixture");
    rootFd = root.fd;
    check((fstatSync(rootFd).mode & 0o777) === 0o700);
    const registryBytes = readPinnedFile(
      rootFd,
      "commands.json",
      "Command registry",
      HOSTED_COMMAND_LIMITS.bytes,
    );
    const registrySHA256 = hostedCommandHash(registryBytes);
    check(registrySHA256 === HOSTED_REGISTRY_SHA256);
    const registry = parseHostedCommandRegistry(registryBytes);
    const input = await readInput((cancel) => {
      cancelInput = cancel;
    });
    check(!interrupted);
    const request = parseHostedCommandRequest(input);
    receiptsFd = openPinnedChildDirectory(rootFd, "receipts", "Private command receipts", true);
    const claimName = `${request.requestId}.claim.json`;
    const receiptName = `${request.requestId}.receipt.json`;
    const commitName = `${request.requestId}.commit.json`;
    if (request.operation === "read-receipt") {
      const claim = JSON.parse(
        readPinnedFile(
          receiptsFd,
          claimName,
          "Command claim",
          HOSTED_COMMAND_LIMITS.bytes,
        ).toString("utf8"),
      );
      const bytes = readPinnedFile(
        receiptsFd,
        receiptName,
        "Command receipt",
        HOSTED_COMMAND_LIMITS.bytes,
      );
      const commit = JSON.parse(
        readPinnedFile(receiptsFd, commitName, "Command commit", 1024).toString("utf8"),
      );
      check(commit.receiptSHA256 === hostedCommandHash(bytes));
      const receipt = JSON.parse(bytes.toString("utf8")) as HostedCommandReceipt;
      check(
        receipt.version === 1 &&
          receipt.requestId === request.requestId &&
          receipt.registrySHA256 === registrySHA256 &&
          receipt.bundleSHA256 === bundleSHA256,
      );
      check(
        claim.inputSHA256 === receipt.inputSHA256 &&
          claim.commandId === receipt.commandId &&
          claim.registrySHA256 === registrySHA256 &&
          claim.requestId === request.requestId,
      );
      check(
        registry.commands.some(
          (entry) =>
            entry.commandId === receipt.commandId && entry.sourceSHA256 === receipt.sourceSHA256,
        ),
      );
      return await publish(bytes);
    }
    const command = registry.commands.find((entry) => entry.commandId === request.commandId);
    check(command);
    const commandDir = pinDirectory(join(root.canonical, "commands"), "Command sources");
    try {
      check(
        hostedCommandHash(
          readPinnedFile(
            commandDir.fd,
            `${command.commandId}.js`,
            "Command source",
            HOSTED_COMMAND_LIMITS.bytes,
          ),
        ) === command.sourceSHA256,
      );
    } finally {
      closeSync(commandDir.fd);
    }
    const inputSHA256 = hostedCommandHash(input);
    const privateToken = command.envKeys.includes(CONTROL_TOKEN)
      ? process.env[CONTROL_TOKEN]
      : undefined;
    if (privateToken && digest.test(privateToken)) {
      check(
        ![
          request.requestId,
          command.commandId,
          inputSHA256,
          registrySHA256,
          bundleSHA256,
          command.sourceSHA256,
          process.env[GENERATION_ID],
        ].includes(privateToken),
      );
    }
    check(
      createPinnedFile(
        receiptsFd,
        claimName,
        JSON.stringify({
          version: 1,
          requestId: request.requestId,
          commandId: command.commandId,
          inputSHA256,
          registrySHA256,
        }),
        "Exclusive command claim",
      ),
      "Request already admitted; never replay",
    );
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
    for (const key of command.envKeys) {
      const value = process.env[key];
      check(value !== undefined);
      check(key === CONTROL_TOKEN ? digest.test(value) : /^[a-zA-Z0-9:_-]{1,128}$/.test(value));
      env[key] = value;
    }
    const receipt: HostedCommandReceipt = {
      version: 1,
      requestId: request.requestId,
      commandId: command.commandId,
      inputSHA256,
      registrySHA256,
      bundleSHA256,
      sourceSHA256: command.sourceSHA256,
      status: "failed",
      interrupted,
      acknowledged: false,
      result: null,
      child: null,
    };
    try {
      check(!interrupted);
      child = startApplicationChild({
        command: [process.execPath, ...HOSTED_COMMAND_FLAGS, join(root.canonical, command.script)],
        cwd: root.canonical,
        env,
        // The only supported private value is a fixed-format control token.
        secrets: command.envKeys.filter((key) => key === CONTROL_TOKEN).map((key) => env[key]!),
        input,
        timeoutMs: command.timeoutMs,
        maxOutputBytes: HOSTED_COMMAND_LIMITS.bytes,
      });
      const result = await child.finish();
      receipt.child = {
        exitCode: result.exitCode,
        signal: result.signal,
        spawnFailed: result.spawnFailed,
        timedOut: result.timedOut,
        exceededOutput: result.exceededOutput,
        orphanedGroup: result.orphanedGroup,
        cleanupConfirmed: result.cleanupConfirmed,
        inputComplete: result.inputComplete === true,
        inputFailed: result.inputFailed !== false,
        stdoutSHA256: result.stdoutSHA256,
        stderrSHA256: result.stderrSHA256,
      };
      try {
        const ack: unknown = JSON.parse(result.stdout);
        object(ack);
        keys(ack, ["version", "requestId", "commandId", "inputSHA256", "result"]);
        check(
          ack.version === 1 &&
            ack.requestId === request.requestId &&
            ack.commandId === command.commandId &&
            ack.inputSHA256 === inputSHA256,
        );
        const resultJson = JSON.stringify(ack.result);
        check(Buffer.byteLength(resultJson) <= HOSTED_COMMAND_LIMITS.resultBytes);
        // Decoded JSON covers tokens hidden by escapes in nested values/keys.
        check(!privateToken || !resultJson.includes(privateToken));
        receipt.acknowledged = true;
        receipt.result = ack.result;
      } catch {
        /* Missing or malformed application acknowledgement is failure. */
      }
      if (
        result.exitCode === 0 &&
        result.signal === null &&
        !result.spawnFailed &&
        !result.timedOut &&
        !result.exceededOutput &&
        !result.orphanedGroup &&
        result.cleanupConfirmed &&
        result.inputComplete === true &&
        result.inputFailed === false &&
        receipt.acknowledged &&
        !interrupted
      )
        receipt.status = "passed";
    } catch {
      /* The durable claim prevents replay even when no child can start. */
    }
    receipt.interrupted = interrupted;
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    check(bytes.byteLength <= HOSTED_COMMAND_LIMITS.bytes);
    check(createPinnedFile(receiptsFd, receiptName, bytes, "Immutable command receipt"));
    check(
      createPinnedFile(
        receiptsFd,
        commitName,
        JSON.stringify({ receiptSHA256: hostedCommandHash(bytes) }),
        "Immutable command receipt commit",
      ),
    );
    const published = await publish(bytes);
    return published && receipt.status === "passed";
  } catch {
    if (child) {
      child.signal("SIGKILL");
      await child.finish();
    }
    return false;
  } finally {
    cancelInput();
    process.stdin.destroy();
    if (receiptsFd !== undefined) closeSync(receiptsFd);
    if (rootFd !== undefined) closeSync(rootFd);
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

if (import.meta.main) process.exitCode = (await runHostedCommandEnvelope()) ? 0 : 1;
