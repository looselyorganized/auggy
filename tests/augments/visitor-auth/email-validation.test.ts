import { describe, test, expect } from "bun:test";
import {
  emailAppearsInRecentMessages,
  isWellFormedEmail,
} from "../../../src/augments/visitor-auth/email-validation";
import type { RecentVisitorMessage } from "../../../src/augments/visitor-auth/types";

const m = (text: string, messageId = "msg"): RecentVisitorMessage => ({ text, messageId });

describe("isWellFormedEmail", () => {
  test("accepts simple addresses", () => {
    expect(isWellFormedEmail("alice@example.com")).toBe(true);
    expect(isWellFormedEmail("a.b+tag@sub.example.co.uk")).toBe(true);
  });

  test("rejects malformed addresses", () => {
    expect(isWellFormedEmail("")).toBe(false);
    expect(isWellFormedEmail("nope")).toBe(false);
    expect(isWellFormedEmail("a@")).toBe(false);
    expect(isWellFormedEmail("@b")).toBe(false);
    expect(isWellFormedEmail("a@b")).toBe(false); // no TLD
    expect(isWellFormedEmail("a b@c.com")).toBe(false);
    expect(isWellFormedEmail("a@b..c.com")).toBe(false);
  });

  test("rejects header-injection attempts", () => {
    expect(isWellFormedEmail("alice@example.com\nBcc: victim@x.com")).toBe(false);
    expect(isWellFormedEmail("alice@example.com\r\nFrom: victim@x.com")).toBe(false);
  });

  test("rejects addresses longer than 254 chars (RFC 5321)", () => {
    const tooLong = "a".repeat(250) + "@b.com";
    expect(isWellFormedEmail(tooLong)).toBe(false);
  });
});

describe("emailAppearsInRecentMessages", () => {
  test("matches exact substring in any message", () => {
    const msgs = [m("hi I'm alice"), m("alice@example.com")];
    expect(emailAppearsInRecentMessages("alice@example.com", msgs)).toEqual({
      matched: true,
      messageId: "msg",
    });
  });

  test("case-insensitive match (real-world: caps in chat)", () => {
    expect(emailAppearsInRecentMessages("alice@example.com", [m("Alice@Example.COM")])).toEqual({
      matched: true,
      messageId: "msg",
    });
  });

  test("does not match when email is absent", () => {
    expect(emailAppearsInRecentMessages("alice@example.com", [m("hi"), m("bye")])).toEqual({
      matched: false,
    });
  });

  test("does not match a different email substring", () => {
    expect(emailAppearsInRecentMessages("alice@example.com", [m("malice@example.com")])).toEqual({
      matched: false,
      hint: "near-match",
    });
  });

  test("returns the messageId of the FIRST match", () => {
    const msgs = [m("alice@example.com here", "first"), m("alice@example.com again", "second")];
    expect(emailAppearsInRecentMessages("alice@example.com", msgs)).toEqual({
      matched: true,
      messageId: "first",
    });
  });

  test("treats the email itself as case-insensitive too", () => {
    expect(emailAppearsInRecentMessages("ALICE@example.com", [m("alice@example.com")])).toEqual({
      matched: true,
      messageId: "msg",
    });
  });

  test("rejects malformed search target without scanning", () => {
    expect(emailAppearsInRecentMessages("not-an-email", [m("doesn't matter")])).toEqual({
      matched: false,
      hint: "malformed",
    });
  });

  test("uses word-boundary matching to avoid partial-substring confusion", () => {
    // The visitor mentioned "alice@example.com" but the email being checked
    // is "ice@example.com" — must NOT match.
    expect(emailAppearsInRecentMessages("ice@example.com", [m("alice@example.com")])).toEqual({
      matched: false,
      hint: "near-match",
    });
  });

  test("ignores empty messages safely", () => {
    expect(emailAppearsInRecentMessages("a@b.com", [m(""), m("a@b.com")])).toEqual({
      matched: true,
      messageId: "msg",
    });
  });
});
