import { describe, expect, test } from "bun:test";
import { formatAgentMailInboundDiagnostic } from "../../../src/augments/agentMail/diagnostics";
import { AgentMailProviderError } from "../../../src/augments/agentMail/provider";

const now = Date.parse("2026-10-04T12:34:56.000Z");
const details = {
  code: "permission_missing" as const,
  operation: "list_messages",
  phase: "catch_up",
  httpStatus: 403,
  retryable: false,
  providerCode: "missing_permission",
  nextAction: "Do not log this instruction.",
};

function metadata(error: unknown) {
  const line = formatAgentMailInboundDiagnostic("degraded", error, now);
  return JSON.parse(line.slice(line.indexOf(" {") + 1)) as Record<string, unknown>;
}

describe("AgentMail inbound diagnostics", () => {
  test("preserves the failure prefix and useful bounded HTTP 403 metadata", () => {
    const error = new AgentMailProviderError(details);
    const expected = {
      timestamp: "2026-10-04T12:34:56.000Z",
      category: "permission_missing",
      operation: "list_messages",
      phase: "catch_up",
      httpStatus: 403,
      retryable: false,
      providerCode: "missing_permission",
    };
    expect(formatAgentMailInboundDiagnostic("degraded", error, now)).toBe(
      `[agentMail] inbound degraded code=permission_missing ${JSON.stringify(expected)}`,
    );
    expect(formatAgentMailInboundDiagnostic("recovered", error, now)).toBe(
      `[agentMail] inbound recovered code=permission_missing ${JSON.stringify(expected)}`,
    );
  });

  for (const providerCode of [
    "missing_permission",
    "message_rejected",
    "resource_taken",
    "already_exists",
  ]) {
    test(`retains recognized provider code ${providerCode}`, () => {
      expect(metadata({ details: { ...details, providerCode } }).providerCode).toBe(providerCode);
    });
  }

  test("rejects untrusted category, operation, phase, and provider strings", () => {
    for (const value of [
      "am_private_key_fixture",
      "https://example.invalid/mail?token=private",
      "resource_taken\r\n[agentMail] forged recovery\u001b[2J",
      "unexpected_provider_code",
      "x".repeat(100_000),
      { toString: () => "missing_permission" },
    ]) {
      const line = formatAgentMailInboundDiagnostic(
        "degraded",
        {
          details: { ...details, code: value, operation: value, phase: value, providerCode: value },
        },
        now,
      );
      expect(line).toBe(
        '[agentMail] inbound degraded code=unknown {"timestamp":"2026-10-04T12:34:56.000Z","category":"unknown","operation":"unknown","phase":"unknown","httpStatus":403,"retryable":false,"providerCode":"unknown"}',
      );
      expect(line.length).toBeLessThan(400);
    }
  });

  test("excludes raw errors, resource identifiers, bodies, credentials, and serialization hooks", () => {
    const secret = "am_private_key_fixture";
    const error = new AgentMailProviderError({
      ...details,
      nextAction: secret,
      inboxId: secret,
      messageId: secret,
      draftId: secret,
      threadId: secret,
      attachmentId: secret,
    });
    let serialized = false;
    Object.assign(error, {
      message: secret,
      stack: secret,
      body: secret,
      url: secret,
      headers: { authorization: secret },
      toJSON() {
        serialized = true;
        throw new Error(secret);
      },
    });
    const line = formatAgentMailInboundDiagnostic("degraded", error, now);
    expect(line).not.toContain(secret);
    expect(metadata(error)).toEqual(metadata(new AgentMailProviderError(details)));
    expect(serialized).toBe(false);
  });

  test("ignores getters, hostile proxies, and malformed objects without throwing", () => {
    let accessed = false;
    const getter = {
      get() {
        accessed = true;
        throw new Error("secret getter");
      },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("secret descriptor");
        },
      },
    );
    const malformed = [
      undefined,
      null,
      403,
      "secret raw error",
      new Error("secret message"),
      Object.create({ details }),
      Object.defineProperty({}, "details", getter),
      { details: Object.defineProperty({}, "code", getter) },
      hostile,
      { details: hostile },
      revoked.proxy,
      { details: revoked.proxy },
    ];
    for (const error of malformed) {
      expect(metadata(error)).toEqual({
        timestamp: "2026-10-04T12:34:56.000Z",
        category: "runtime_failure",
        operation: "unknown",
        phase: "unknown",
      });
    }
    expect(accessed).toBe(false);
  });

  test("only emits valid HTTP status numbers and boolean retryability", () => {
    for (const value of ["403", -1, 99, 600, 403.5, NaN, Infinity, null, {}]) {
      const result = metadata({ details: { ...details, httpStatus: value, retryable: value } });
      expect(result).not.toHaveProperty("httpStatus");
      expect(result).not.toHaveProperty("retryable");
    }
    expect(metadata({ details: { ...details, httpStatus: 503, retryable: true } })).toMatchObject({
      httpStatus: 503,
      retryable: true,
    });
    expect(metadata({ details: { ...details, providerCode: undefined } })).not.toHaveProperty(
      "providerCode",
    );
  });

  test("uses a fixed UTC fallback for invalid numeric timestamps", () => {
    for (const invalid of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      expect(formatAgentMailInboundDiagnostic("degraded", null, invalid)).toContain(
        '"timestamp":"1970-01-01T00:00:00.000Z"',
      );
    }
    const line = formatAgentMailInboundDiagnostic("degraded", null);
    const parsed = JSON.parse(line.slice(line.indexOf(" {") + 1));
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });
});
