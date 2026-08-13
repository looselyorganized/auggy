import { createHash } from "node:crypto";
import { createHttpClient, type HttpClient, type HttpResponse } from "../../http";
import type { ValidatedAgentMailConfig } from "./config";
import type { AgentMailAttachmentMetadata } from "./provider";

const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export type AgentMailTextAttachmentResult =
  | {
      ok: true;
      attachment: {
        attachmentId: string;
        filename?: string;
        contentType: string;
        size: number;
        sha256: string;
        text: string;
      };
    }
  | {
      ok: false;
      reason:
        | "metadata_expired"
        | "metadata_invalid"
        | "attachment_too_large"
        | "attachment_type_not_allowed"
        | "attachment_fetch_failed"
        | "attachment_response_invalid";
    };

export interface AgentMailAttachmentReaderOptions {
  config: ValidatedAgentMailConfig;
  client?: Pick<HttpClient, "get">;
  clock?: () => number;
}

function normalizeContentType(value: string): string | undefined {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && CONTENT_TYPE_PATTERN.test(normalized) ? normalized : undefined;
}

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) =>
    entry.endsWith("/*") ? contentType.startsWith(entry.slice(0, -1)) : contentType === entry,
  );
}

function safeDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function responseAllowed(response: HttpResponse): boolean {
  try {
    const final = new URL(response.finalUrl);
    return final.protocol === "https:" && !final.username && !final.password;
  } catch {
    return false;
  }
}

/**
 * Fetch one provider-signed attachment without forwarding credentials or
 * exposing its signed URL. Only bounded UTF-8 text is returned; bytes are
 * never executed or persisted by this boundary.
 */
export async function readAgentMailTextAttachment(
  metadata: AgentMailAttachmentMetadata,
  options: AgentMailAttachmentReaderOptions,
  signal?: AbortSignal,
): Promise<AgentMailTextAttachmentResult> {
  const { config } = options;
  const now = (options.clock ?? Date.now)();
  if (
    metadata.attachmentId.length === 0 ||
    metadata.attachmentId.length > 512 ||
    !safeDownloadUrl(metadata.downloadUrl) ||
    !Number.isFinite(metadata.expiresAt) ||
    metadata.expiresAt <= now
  ) {
    return {
      ok: false,
      reason:
        Number.isFinite(metadata.expiresAt) && metadata.expiresAt <= now
          ? "metadata_expired"
          : "metadata_invalid",
    };
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    return { ok: false, reason: "metadata_invalid" };
  }
  if (metadata.size > config.mailbox.maxAttachmentBytes) {
    return { ok: false, reason: "attachment_too_large" };
  }
  const declaredType = normalizeContentType(metadata.contentType ?? "");
  if (
    declaredType === undefined ||
    !contentTypeAllowed(declaredType, config.mailbox.allowedAttachmentTypes)
  ) {
    return { ok: false, reason: "attachment_type_not_allowed" };
  }

  const client =
    options.client ??
    createHttpClient({
      urlPolicy: "public",
      timeoutMs: 10_000,
      maxRedirects: 2,
      maxBodyBytes: config.mailbox.maxAttachmentBytes + 1,
      userAgent: "auggy-agentmail-attachment/1",
    });
  let response: HttpResponse;
  try {
    // Deliberately send no provider key, cookies, or custom headers. The URL
    // itself is the provider's short-lived capability.
    response = await client.get(metadata.downloadUrl, { signal });
  } catch {
    return { ok: false, reason: "attachment_fetch_failed" };
  }
  if (response.status < 200 || response.status >= 300 || !responseAllowed(response)) {
    return { ok: false, reason: "attachment_response_invalid" };
  }
  const responseType = normalizeContentType(response.contentType);
  if (
    responseType === undefined ||
    responseType !== declaredType ||
    !contentTypeAllowed(responseType, config.mailbox.allowedAttachmentTypes)
  ) {
    return { ok: false, reason: "attachment_type_not_allowed" };
  }
  const contentLength = validContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > config.mailbox.maxAttachmentBytes) {
    return { ok: false, reason: "attachment_too_large" };
  }
  if (response.body.includes("\uFFFD")) {
    return { ok: false, reason: "attachment_response_invalid" };
  }
  const bytes = Buffer.from(response.body, "utf8");
  if (bytes.byteLength > config.mailbox.maxAttachmentBytes) {
    return { ok: false, reason: "attachment_too_large" };
  }
  if (
    bytes.byteLength !== metadata.size ||
    (contentLength !== undefined && bytes.byteLength !== contentLength)
  ) {
    return { ok: false, reason: "attachment_response_invalid" };
  }
  return {
    ok: true,
    attachment: {
      attachmentId: metadata.attachmentId,
      ...(metadata.filename === undefined ? {} : { filename: metadata.filename.slice(0, 512) }),
      contentType: responseType,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: response.body,
    },
  };
}
