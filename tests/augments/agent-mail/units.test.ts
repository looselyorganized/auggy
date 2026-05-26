import { describe, test, expect } from "bun:test";
import {
  checkRateLimit,
  createRateLimitState,
  hashSubject,
  recordSend,
} from "../../../src/augments/agent-mail/rate-limit";
import {
  containsSmtpDotSequence,
  normalizeSubject,
  recipientMatchesAllowlist,
  redactRecipients,
  scanForSensitive,
  validateOutbound,
} from "../../../src/augments/agent-mail/outbound";

// ---------------------------------------------------------------------------
// rate-limit pure helpers
// ---------------------------------------------------------------------------

describe("hashSubject", () => {
  test("collides on whitespace differences", () => {
    expect(hashSubject("Hello")).toBe(hashSubject("  Hello  "));
    expect(hashSubject("Hello world")).toBe(hashSubject("hello   WORLD"));
  });
  test("differs on punctuation", () => {
    expect(hashSubject("Hello")).not.toBe(hashSubject("Hello!"));
  });
});

describe("checkRateLimit", () => {
  const now = 1_000_000_000_000;

  test("permits when state is empty", () => {
    const s = createRateLimitState();
    const d = checkRateLimit(s, ["a@x.com"], "subj", {}, now);
    expect(d.allowed).toBe(true);
  });

  test("blocks once global hourly cap is reached", () => {
    const s = createRateLimitState();
    for (let i = 0; i < 10; i++) {
      recordSend(s, [`r${i}@x.com`], `subj-${i}`, now - i);
    }
    const d = checkRateLimit(s, ["new@x.com"], "fresh", { globalMaxPerHour: 10 }, now);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/global cap/);
    expect(d.retryAfterSec).toBeGreaterThan(0);
  });

  test("releases capacity after the window slides past oldest send", () => {
    const s = createRateLimitState();
    // Record 1 send an hour and 1ms ago — should not count toward current cap.
    recordSend(s, ["old@x.com"], "old", now - 3_600_001);
    const d = checkRateLimit(s, ["new@x.com"], "fresh", { globalMaxPerHour: 1 }, now);
    expect(d.allowed).toBe(true);
  });

  test("enforces per-recipient cooldown", () => {
    const s = createRateLimitState();
    recordSend(s, ["alice@x.com"], "first", now - 60_000); // 60s ago
    const d = checkRateLimit(
      s,
      ["alice@x.com"],
      "second",
      { perRecipientCooldownMs: 300_000 },
      now,
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/cooldown/);
  });

  test("per-recipient cooldown uses lowercased compare", () => {
    const s = createRateLimitState();
    recordSend(s, ["Alice@X.COM"], "first", now - 60_000);
    const d = checkRateLimit(
      s,
      ["alice@x.com"],
      "second",
      { perRecipientCooldownMs: 300_000 },
      now,
    );
    expect(d.allowed).toBe(false);
  });

  test("dedup blocks identical normalized subjects within window", () => {
    const s = createRateLimitState();
    recordSend(s, ["a@x.com"], "Daily Digest", now - 1_000);
    const d = checkRateLimit(s, ["b@x.com"], "  daily digest  ", { dedupWindowMs: 300_000 }, now);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/identical subject/);
  });

  test("dedup disabled when dedupWindowMs is 0", () => {
    const s = createRateLimitState();
    recordSend(s, ["a@x.com"], "Daily Digest", now - 1_000);
    const d = checkRateLimit(s, ["b@x.com"], "Daily Digest", { dedupWindowMs: 0 }, now);
    expect(d.allowed).toBe(true);
  });

  test("enabled: false bypasses every check", () => {
    const s = createRateLimitState();
    for (let i = 0; i < 100; i++) recordSend(s, [`r${i}@x.com`], `s${i}`, now);
    const d = checkRateLimit(s, ["alice@x.com"], "x", { enabled: false, globalMaxPerHour: 1 }, now);
    expect(d.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// outbound pure helpers
// ---------------------------------------------------------------------------

describe("normalizeSubject", () => {
  test("strips all C0 control chars including bare LF (header-injection guard)", () => {
    // Codex #2: previously preserved \n which downstream stacks can fold
    // into a header separator. Subjects are single-line by definition.
    expect(normalizeSubject("Hello\x00\x01World", {})).toBe("[Auggy] HelloWorld");
    expect(normalizeSubject("Hello\nBcc: evil@x.com", {})).toBe("[Auggy] HelloBcc: evil@x.com");
  });
  test("strips tabs / CR (header-injection guard)", () => {
    expect(normalizeSubject("Hello\tBcc:evil@x.com\rfoo", {})).toBe(
      "[Auggy] HelloBcc:evil@x.comfoo",
    );
  });
  test("applies operator-configured prefix", () => {
    expect(normalizeSubject("Test", { subjectPrefix: "[ACME] " })).toBe("[ACME] Test");
  });
  test("idempotent when subject already carries the prefix", () => {
    expect(normalizeSubject("[Auggy] Already prefixed", {})).toBe("[Auggy] Already prefixed");
  });
});

describe("containsSmtpDotSequence", () => {
  test("detects CRLF-dot-CRLF", () => {
    expect(containsSmtpDotSequence("body\r\n.\r\nmore")).toBe(true);
  });
  test("detects bare-LF dot variant", () => {
    expect(containsSmtpDotSequence("body\n.\nmore")).toBe(true);
  });
  test("does not flag legitimate dot at end of line", () => {
    expect(containsSmtpDotSequence("This sentence ends.\nNext line.")).toBe(false);
  });
});

describe("recipientMatchesAllowlist", () => {
  test("exact match (case-insensitive)", () => {
    expect(recipientMatchesAllowlist("Alice@Example.COM", ["alice@example.com"])).toBe(true);
  });
  test("domain glob", () => {
    expect(recipientMatchesAllowlist("bob@example.com", ["*@example.com"])).toBe(true);
    expect(recipientMatchesAllowlist("bob@other.com", ["*@example.com"])).toBe(false);
  });
  test("multi-entry allowlist", () => {
    const allow = ["alice@x.com", "*@trusted.com", "bob@y.com"];
    expect(recipientMatchesAllowlist("alice@x.com", allow)).toBe(true);
    expect(recipientMatchesAllowlist("anyone@trusted.com", allow)).toBe(true);
    expect(recipientMatchesAllowlist("eve@evil.com", allow)).toBe(false);
  });
});

describe("validateOutbound", () => {
  test("rejects empty recipient list", () => {
    const r = validateOutbound({ recipients: [], subject: "s", text: "t" }, {});
    expect(r.ok).toBe(false);
  });
  test("rejects malformed email", () => {
    const r = validateOutbound({ recipients: ["not-an-email"], subject: "s", text: "t" }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/well-formed/);
  });
  test("rejects when recipient count exceeds cap", () => {
    const tos = Array.from({ length: 11 }, (_, i) => `r${i}@x.com`);
    const r = validateOutbound({ recipients: tos, subject: "s", text: "t" }, { maxRecipients: 10 });
    expect(r.ok).toBe(false);
  });
  test("enforces allowlist (exact)", () => {
    const r = validateOutbound(
      { recipients: ["eve@evil.com"], subject: "s", text: "t" },
      { allowedRecipients: ["alice@good.com"] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowlist/);
  });
  test("permits allowlisted recipient (domain glob)", () => {
    const r = validateOutbound(
      { recipients: ["bob@good.com"], subject: "s", text: "t" },
      { allowedRecipients: ["*@good.com"] },
    );
    expect(r.ok).toBe(true);
  });
  test("rejects empty subject (for send)", () => {
    const r = validateOutbound({ recipients: ["a@x.com"], subject: "", text: "t" }, {});
    expect(r.ok).toBe(false);
  });
  test("rejects body exceeding byte cap", () => {
    const big = "x".repeat(10);
    const r = validateOutbound(
      { recipients: ["a@x.com"], subject: "s", text: big },
      { bodyMaxBytes: 5 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/bytes/);
  });
  test("body cap counts text + html together (Codex #4)", () => {
    // text alone is small, html alone is small, but combined exceed the cap.
    const r = validateOutbound(
      {
        recipients: ["a@x.com"],
        subject: "s",
        text: "x".repeat(60),
        html: "y".repeat(60),
      },
      { bodyMaxBytes: 100, allowHtml: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/text \+ html|bytes/);
  });
  test("rejects SMTP envelope-end body", () => {
    const r = validateOutbound(
      { recipients: ["a@x.com"], subject: "s", text: "body\r\n.\r\nbad" },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/envelope-end|SMTP/i);
  });
  test("rejects HTML when allowHtml is false", () => {
    const r = validateOutbound(
      { recipients: ["a@x.com"], subject: "s", text: "t", html: "<p>x</p>" },
      { allowHtml: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowHtml/);
  });
  test("permits HTML when allowHtml is true", () => {
    const r = validateOutbound(
      { recipients: ["a@x.com"], subject: "s", text: "t", html: "<p>x</p>" },
      { allowHtml: true },
    );
    expect(r.ok).toBe(true);
  });
});

describe("scanForSensitive", () => {
  test("flags OpenAI-style keys", () => {
    const r = scanForSensitive("here is sk-AbCdEf1234567890ABCDEF98 use it");
    expect(r.flagged).toBe(true);
    expect(r.hits).toContain("openai-key");
  });
  test("flags AgentMail-style keys", () => {
    const r = scanForSensitive("Token: am_abcdefghijklmnopqrstuvwxyz12");
    expect(r.flagged).toBe(true);
    expect(r.hits).toContain("agentmail-key");
  });
  test("flags JWT shapes", () => {
    const r = scanForSensitive(
      "header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    expect(r.flagged).toBe(true);
    expect(r.hits).toContain("jwt");
  });
  test("does not flag normal prose", () => {
    const r = scanForSensitive("This is a normal sentence about agentmail and APIs.");
    expect(r.flagged).toBe(false);
  });
});

describe("redactRecipients", () => {
  test("redacts single", () => {
    expect(redactRecipients(["alice@example.com"])).toBe("al***@example.com");
  });
  test("redacts list with +N suffix", () => {
    expect(redactRecipients(["alice@example.com", "bob@example.com", "carol@example.com"])).toBe(
      "al***@example.com (+2)",
    );
  });
  test("handles 1-char local part", () => {
    expect(redactRecipients(["a@example.com"])).toBe("a***@example.com");
  });
  test("handles malformed (no @)", () => {
    expect(redactRecipients(["broken"])).toBe("***");
  });
});
