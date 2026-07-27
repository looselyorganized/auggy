import { describe, expect, test } from "bun:test";
import { MAX_CRON_EXPRESSION_BYTES, nextUtcCron, parseUtcCron } from "../../src/jobs/cron";

const utc = (value: string) => new Date(value);

describe("UTC cron", () => {
  test("calculates the next matching minute strictly after the input minute", () => {
    const cron = parseUtcCron("*/15 9-17/2 * * 1-5");

    expect(nextUtcCron(cron, utc("2026-07-24T09:14:59.999Z"))).toEqual(
      utc("2026-07-24T09:15:00.000Z"),
    );
    expect(nextUtcCron(cron, utc("2026-07-24T09:15:00.000Z"))).toEqual(
      utc("2026-07-24T09:30:00.000Z"),
    );
  });

  test("uses UTC clock values across day, month, and year boundaries", () => {
    expect(nextUtcCron("0 0 1 * *", utc("2026-01-31T23:59:00.000Z"))).toEqual(
      utc("2026-02-01T00:00:00.000Z"),
    );
    expect(nextUtcCron("0 0 1 1 *", utc("2026-12-31T23:59:00.000Z"))).toEqual(
      utc("2027-01-01T00:00:00.000Z"),
    );
    expect(nextUtcCron("0 0 29 2 *", utc("2027-03-01T00:00:00.000Z"))).toEqual(
      utc("2028-02-29T00:00:00.000Z"),
    );
    expect(nextUtcCron("0 0 1 1 *", utc("0099-12-31T23:59:00.000Z"))).toEqual(
      utc("0100-01-01T00:00:00.000Z"),
    );
  });

  test("accepts lists, ranges, and positive steps", () => {
    expect(nextUtcCron("5,25,45 8-10/2 * 1,7 0,7", utc("2026-01-03T23:59:00.000Z"))).toEqual(
      utc("2026-01-04T08:05:00.000Z"),
    );
  });

  test("applies standard day-of-month/day-of-week OR semantics", () => {
    const cron = "0 12 13 * 5";

    expect(nextUtcCron(cron, utc("2026-07-12T12:00:00.000Z"))).toEqual(
      utc("2026-07-13T12:00:00.000Z"),
    );
    expect(nextUtcCron(cron, utc("2026-07-13T12:00:00.000Z"))).toEqual(
      utc("2026-07-17T12:00:00.000Z"),
    );
  });

  test("treats a wildcard day field as unconstrained by that field", () => {
    expect(nextUtcCron("0 0 * * 1", utc("2026-07-26T00:00:00.000Z"))).toEqual(
      utc("2026-07-27T00:00:00.000Z"),
    );
    expect(nextUtcCron("0 0 27 * *", utc("2026-07-26T00:00:00.000Z"))).toEqual(
      utc("2026-07-27T00:00:00.000Z"),
    );
  });

  test("accepts either 0 or 7 for Sunday", () => {
    expect(nextUtcCron("0 0 * * 7", utc("2026-07-25T00:00:00.000Z"))).toEqual(
      utc("2026-07-26T00:00:00.000Z"),
    );
  });

  test("returns null rather than searching indefinitely when a valid expression cannot match", () => {
    expect(nextUtcCron("0 0 31 2 *", utc("2026-01-01T00:00:00.000Z"))).toBeNull();
  });

  test.each([
    "@daily",
    "0 0 * * * *",
    "0 0 * JAN *",
    "0 0 * * MON",
    "0 0 * * 8",
    "0 0 * * -1",
    "0 0 * * 1-0",
    "0 0 * * */0",
    "0 0 * * 1/2",
    "0 0 * * 1,,2",
    "0 0 * * 1/2/3",
    "0 0 * * 1\t",
    " 0 0 * * *",
  ])("rejects unsupported or malformed expressions: %s", (expression) => {
    expect(() => parseUtcCron(expression)).toThrow();
  });

  test("rejects invalid clock inputs and unsafe or pathological expressions", () => {
    expect(() => nextUtcCron("* * * * *", new Date("invalid"))).toThrow();
    expect(() => parseUtcCron(`* * * * ${"1,".repeat(40)}1`)).toThrow();
    expect(() => parseUtcCron(`${"1".repeat(MAX_CRON_EXPRESSION_BYTES + 1)} * * * *`)).toThrow();
    expect(() => parseUtcCron("9007199254740992 * * * *")).toThrow();
  });

  test("rejects oversized input before allocating a proportional UTF-8 encoder buffer", () => {
    const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
    if (!originalTextEncoder) {
      throw new Error("TextEncoder descriptor is unavailable");
    }
    let encoderCalled = false;
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: class {
        encode(): Uint8Array {
          encoderCalled = true;
          throw new Error("encoder must not be reached");
        }
      },
    });

    try {
      expect(() => parseUtcCron("1".repeat(1024 * 1024))).toThrow(
        `Cron expression exceeds ${MAX_CRON_EXPRESSION_BYTES} bytes.`,
      );
      expect(encoderCalled).toBeFalse();
    } finally {
      Object.defineProperty(globalThis, "TextEncoder", originalTextEncoder);
    }
  });
});
