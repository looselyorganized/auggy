import { lstatSync, readFileSync } from "node:fs";

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

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) invalid(`missing ${name}`);
  return value;
}

function main(): void {
  const requestPath = argument("--request");
  const metadata = lstatSync(requestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_REQUEST_BYTES) {
    invalid(`request file must be a regular file no larger than ${MAX_REQUEST_BYTES} bytes`);
  }
  const validated = validateSecurityEvalRequest(readFileSync(requestPath, "utf8"));
  process.stdout.write(
    `config_path=${validated.configPath}\nmodel=${validated.model}\nsource_sha=${validated.sourceSha}\n`,
  );
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
