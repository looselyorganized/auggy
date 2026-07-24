export class RequestBodyTooLargeError extends Error {
  readonly code = "request_body_too_large";

  constructor(readonly limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidRequestBodyError extends Error {
  readonly code = "invalid_request_body";

  constructor() {
    super("Request body is malformed.");
    this.name = "InvalidRequestBodyError";
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new InvalidRequestBodyError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidRequestBodyError();
  return parsed;
}

export async function readRequestBodyBytes(
  request: Request,
  limitBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new TypeError("request body limit must be a non-negative safe integer");
  }

  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > limitBytes) {
    await request.body?.cancel().catch(() => {});
    throw new RequestBodyTooLargeError(limitBytes);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError(limitBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw new InvalidRequestBodyError();
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readRequestBodyText(request: Request, limitBytes: number): Promise<string> {
  const bytes = await readRequestBodyBytes(request, limitBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidRequestBodyError();
  }
}

export async function readRequestBodyJson(request: Request, limitBytes: number): Promise<unknown> {
  const text = await readRequestBodyText(request, limitBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestBodyError();
  }
}

export async function cloneRequestWithBoundedBody(
  request: Request,
  limitBytes: number,
): Promise<Request> {
  const bytes = await readRequestBodyBytes(request, limitBytes);
  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.byteLength));
  return new Request(request, { body: bytes, headers });
}
