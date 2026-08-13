import { describe, expect, test } from "bun:test";
import { validateAgentMailConfig } from "../../../src/augments/agentMail/config";
import { readAgentMailTextAttachment } from "../../../src/augments/agentMail/attachment";
import type { AgentMailAttachmentMetadata } from "../../../src/augments/agentMail/provider";
import type { HttpResponse } from "../../../src/http";

function config() {
  return validateAgentMailConfig({
    apiKey: "am_test",
    inboxId: "support@agentmail.to",
    mailbox: {
      allowAttachmentAccess: true,
      maxAttachmentBytes: 10,
      allowedAttachmentTypes: ["text/plain", "application/json"],
    },
  });
}

function metadata(
  overrides: Partial<AgentMailAttachmentMetadata> = {},
): AgentMailAttachmentMetadata {
  return {
    attachmentId: "attachment_1",
    filename: "note.txt",
    size: 5,
    contentType: "text/plain",
    downloadUrl: "https://files.agentmail.example/download?signature=secret",
    expiresAt: 20_000,
    ...overrides,
  };
}

function response(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    finalUrl: "https://files.agentmail.example/download?signature=secret",
    status: 200,
    statusText: "OK",
    contentType: "text/plain; charset=utf-8",
    headers: new Headers({ "content-type": "text/plain", "content-length": "5" }),
    body: "hello",
    ...overrides,
  };
}

describe("AgentMail attachment read boundary", () => {
  test("returns bounded UTF-8 text and a digest without the signed URL", async () => {
    const result = await readAgentMailTextAttachment(metadata(), {
      config: config(),
      clock: () => 10_000,
      client: { get: async () => response() },
    });
    expect(result).toMatchObject({
      ok: true,
      attachment: {
        attachmentId: "attachment_1",
        filename: "note.txt",
        contentType: "text/plain",
        size: 5,
        text: "hello",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    });
    expect(JSON.stringify(result)).not.toContain("signature");
    expect(JSON.stringify(result)).not.toContain("download");
  });

  test("rejects expired metadata before dispatch", async () => {
    let dispatched = false;
    const result = await readAgentMailTextAttachment(metadata({ expiresAt: 10_000 }), {
      config: config(),
      clock: () => 10_000,
      client: {
        async get() {
          dispatched = true;
          return response();
        },
      },
    });
    expect(result).toEqual({ ok: false, reason: "metadata_expired" });
    expect(dispatched).toBe(false);
  });

  test("uses the public DNS-pinned client and redacts unsafe URL failures", async () => {
    const result = await readAgentMailTextAttachment(
      metadata({
        downloadUrl: "https://127.0.0.1/latest/meta-data",
        expiresAt: Date.now() + 60_000,
      }),
      { config: config() },
    );
    expect(result).toEqual({ ok: false, reason: "attachment_fetch_failed" });
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain("meta-data");
  });

  test("rejects a redirect result that leaves HTTPS even with an injected client", async () => {
    const result = await readAgentMailTextAttachment(metadata(), {
      config: config(),
      clock: () => 10_000,
      client: {
        get: async () => response({ finalUrl: "http://169.254.169.254/latest/meta-data" }),
      },
    });
    expect(result).toEqual({ ok: false, reason: "attachment_response_invalid" });
  });

  test("rejects metadata, headers, or bodies above the configured byte cap", async () => {
    expect(
      await readAgentMailTextAttachment(metadata({ size: 11 }), {
        config: config(),
        clock: () => 10_000,
        client: { get: async () => response() },
      }),
    ).toEqual({ ok: false, reason: "attachment_too_large" });
    expect(
      await readAgentMailTextAttachment(metadata(), {
        config: config(),
        clock: () => 10_000,
        client: {
          get: async () =>
            response({
              headers: new Headers({ "content-type": "text/plain", "content-length": "11" }),
            }),
        },
      }),
    ).toEqual({ ok: false, reason: "attachment_too_large" });
    expect(
      await readAgentMailTextAttachment(metadata({ size: 10 }), {
        config: config(),
        clock: () => 10_000,
        client: {
          get: async () =>
            response({
              body: "hello world",
              headers: new Headers({ "content-type": "text/plain" }),
            }),
        },
      }),
    ).toEqual({ ok: false, reason: "attachment_too_large" });
  });

  test("rejects disallowed, missing, or mismatched MIME and declared sizes", async () => {
    expect(
      await readAgentMailTextAttachment(metadata({ contentType: "application/pdf" }), {
        config: config(),
        clock: () => 10_000,
        client: { get: async () => response() },
      }),
    ).toEqual({ ok: false, reason: "attachment_type_not_allowed" });
    expect(
      await readAgentMailTextAttachment(metadata(), {
        config: config(),
        clock: () => 10_000,
        client: {
          get: async () =>
            response({
              contentType: "application/json",
              headers: new Headers({ "content-type": "application/json", "content-length": "5" }),
            }),
        },
      }),
    ).toEqual({ ok: false, reason: "attachment_type_not_allowed" });
    expect(
      await readAgentMailTextAttachment(metadata({ size: 6 }), {
        config: config(),
        clock: () => 10_000,
        client: { get: async () => response() },
      }),
    ).toEqual({ ok: false, reason: "attachment_response_invalid" });
  });
});
