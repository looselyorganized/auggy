import { isIP } from "node:net";
import { openBrowser, type OpenBrowserResult } from "./open-browser";

const LOGIN_PATH_RE = /^\/console\/cli-login\/[A-Za-z0-9_-]{43}$/;
const MAX_TICKET_RESPONSE_BYTES = 4096;

export interface OpenConsoleResult {
  opened: boolean;
  automaticSignIn: boolean;
  consoleUrl: string;
  reason?: string;
}

export async function openConsoleWithSignIn(args: {
  baseUrl: string;
  bearer: string;
  fetch?: typeof fetch;
  open?: (url: string) => OpenBrowserResult;
  timeoutMs?: number;
}): Promise<OpenConsoleResult> {
  const baseUrl = normalizeConsoleBaseUrl(args.baseUrl);
  const consoleUrl = new URL("/console", baseUrl).toString();
  const open = args.open ?? openBrowser;

  try {
    const loginUrl = await requestConsoleLoginUrl({
      baseUrl,
      bearer: args.bearer,
      fetch: args.fetch,
      timeoutMs: args.timeoutMs,
    });
    const opened = open(loginUrl).ok;
    if (opened) return { opened: true, automaticSignIn: true, consoleUrl };
    return {
      opened: false,
      automaticSignIn: true,
      consoleUrl,
      reason: "the browser could not be launched",
    };
  } catch (error) {
    const fallback = open(new URL("/console/login", baseUrl).toString());
    return {
      opened: fallback.ok,
      automaticSignIn: false,
      consoleUrl,
      reason: safeConsoleLoginError(error),
    };
  }
}

export async function requestConsoleLoginUrl(args: {
  baseUrl: string;
  bearer: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const baseUrl = normalizeConsoleBaseUrl(args.baseUrl);
  if (!args.bearer || args.bearer.length > 8192 || containsControlCharacter(args.bearer)) {
    throw new Error("invalid Console credential");
  }

  const request = args.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 3_000);
  let response: Response;
  try {
    response = await request(new URL("/console/api/cli-login", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`auggy:${args.bearer}`, "utf8").toString("base64")}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error("the agent did not accept automatic Console sign-in");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error("the agent did not accept automatic Console sign-in");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("the agent returned an invalid automatic sign-in response");
  }

  const text = await readBoundedResponseText(response, MAX_TICKET_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the agent returned an invalid automatic sign-in response");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the agent returned an invalid automatic sign-in response");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.loginPath !== "string" ||
    !LOGIN_PATH_RE.test(record.loginPath) ||
    typeof record.expiresInSeconds !== "number" ||
    !Number.isSafeInteger(record.expiresInSeconds) ||
    record.expiresInSeconds < 1 ||
    record.expiresInSeconds > 30
  ) {
    throw new Error("the agent returned an invalid automatic sign-in response");
  }

  return new URL(record.loginPath, baseUrl).toString();
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      throw new Error("the agent returned an invalid automatic sign-in response");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("the agent returned an invalid automatic sign-in response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export function normalizeConsoleBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid Console URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("invalid Console URL");
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url.origin;
  throw new Error("automatic Console sign-in requires HTTPS, except on this computer");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (normalized.toLowerCase() === "localhost") return true;
  if (isIP(normalized) === 6) return normalized === "::1";
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeConsoleLoginError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("automatic Console sign-in requires")) {
    return error.message;
  }
  if (error instanceof Error && error.message === "invalid Console URL") return error.message;
  if (error instanceof Error && error.message === "invalid Console credential")
    return error.message;
  return "automatic sign-in was unavailable";
}
