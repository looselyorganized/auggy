import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_CONFIG_BYTES = 64 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function invalid(reason: string): never {
  throw new Error(`Invalid security eval candidate: ${reason}.`);
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) invalid(`missing ${name}`);
  return value;
}

function readRegularFile(path: string, label: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
      invalid(`${label} must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    const content = Buffer.allocUnsafe(metadata.size + 1);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesRead = readSync(descriptor, content, offset, content.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== metadata.size) invalid(`${label} changed while it was being read`);
    return content.subarray(0, offset);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifySecurityEvalCandidate(input: {
  candidate: Buffer;
  trusted: Buffer;
  sourceSha: string;
}): { sourceSha: string; configSha256: string; scope: "trusted-harness-candidate-config" } {
  if (!SHA_PATTERN.test(input.sourceSha)) invalid("source SHA must be 40 lowercase hex characters");
  const candidateHash = createHash("sha256").update(input.candidate).digest("hex");
  const trustedHash = createHash("sha256").update(input.trusted).digest("hex");
  if (candidateHash !== trustedHash || !input.candidate.equals(input.trusted)) {
    invalid(
      "candidate configuration differs from the trusted fixture; the paid workflow never executes candidate-controlled configuration",
    );
  }
  return {
    sourceSha: input.sourceSha,
    configSha256: candidateHash,
    scope: "trusted-harness-candidate-config",
  };
}

function main(): void {
  const verified = verifySecurityEvalCandidate({
    candidate: readRegularFile(argument("--candidate"), "candidate config"),
    trusted: readRegularFile(argument("--trusted"), "trusted config"),
    sourceSha: argument("--source-sha"),
  });
  process.stdout.write(
    `candidate_config_sha256=${verified.configSha256}\nevaluation_scope=${verified.scope}\n`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid security eval candidate.");
    process.exit(1);
  }
}
