import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_REQUEST_BYTES = 4096;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FIXTURES = {
  haiku: "packages/evals/src/security/fixtures/test-agent.yaml",
  sonnet: "packages/evals/src/security/fixtures/test-agent-sonnet.yaml",
} as const;

export interface ValidatedSecurityEvalRequest {
  model: keyof typeof FIXTURES;
  sourceSha: string;
  configPath: (typeof FIXTURES)[keyof typeof FIXTURES];
}

function invalid(reason: string): never {
  throw new Error(`Invalid security eval request: ${reason}.`);
}

export function validateSecurityEvalRequest(
  raw: string,
  expectedSourceSha?: string,
): ValidatedSecurityEvalRequest {
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
    invalid(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  if (expectedSourceSha !== undefined && !SHA_PATTERN.test(expectedSourceSha)) {
    invalid("trusted workflow supplied an invalid source SHA");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalid("body must be an object");
  }

  const request = parsed as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  if (keys.join(",") !== "model,schema,sourceSha") {
    invalid("body contains missing or unsupported fields");
  }
  if (request.schema !== 1) invalid("schema must equal 1");
  if (request.model !== "haiku" && request.model !== "sonnet") {
    invalid("model must be haiku or sonnet");
  }
  if (
    typeof request.sourceSha !== "string" ||
    !SHA_PATTERN.test(request.sourceSha) ||
    (expectedSourceSha !== undefined && request.sourceSha !== expectedSourceSha)
  ) {
    invalid("source SHA does not match the triggering workflow");
  }

  return {
    model: request.model,
    sourceSha: request.sourceSha,
    configPath: FIXTURES[request.model],
  };
}

function readRequestFile(descriptor: number): string {
  const buffer = Buffer.allocUnsafe(MAX_REQUEST_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_REQUEST_BYTES) {
    invalid(`request file must be a regular file no larger than ${MAX_REQUEST_BYTES} bytes`);
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) invalid(`missing ${name}`);
  return value;
}

function main(): void {
  const requestPath = argument("--request");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      requestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_REQUEST_BYTES) {
      invalid(`request file must be a regular file no larger than ${MAX_REQUEST_BYTES} bytes`);
    }
    const validated = validateSecurityEvalRequest(readRequestFile(descriptor));
    process.stdout.write(
      `config_path=${validated.configPath}\nmodel=${validated.model}\nsource_sha=${validated.sourceSha}\n`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid security eval request.";
    console.error(message);
    process.exit(1);
  }
}
