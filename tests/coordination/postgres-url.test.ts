import { describe, expect, test } from "bun:test";
import { assertSecurePostgresCoordinationUrl } from "../../src/coordination/postgres-url";

const SENTINEL = "postgresql://auggy-secret-sentinel@db.example.invalid/coordination";

describe("PostgreSQL coordination URL policy", () => {
  test("requires verified TLS for remote PostgreSQL URLs without leaking credentials", () => {
    const invalid = [
      SENTINEL,
      `${SENTINEL}?sslmode=require`,
      `${SENTINEL}?SSLMODE=verify-full`,
      `${SENTINEL}?sslmode=verify-full&sslmode=verify-full`,
      `${SENTINEL}?sslmode=verify-full&tls=true`,
      "postgresql://postgres@localhost/coordination?host=db.example.invalid",
      "postgresql://postgres@localhost/coordination?service=remote",
      `${SENTINEL}?sslmode=verify-full#sslmode=disable`,
      ` ${SENTINEL}?sslmode=verify-full`,
      "mysql://auggy-secret-sentinel@db.example.invalid/coordination?sslmode=verify-full",
      "postgresql:///coordination?sslmode=verify-full",
    ];

    for (const value of invalid) {
      let thrown: unknown;
      try {
        assertSecurePostgresCoordinationUrl(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("PostgreSQL coordination URL is invalid");
      expect(String(thrown)).not.toContain("auggy-secret-sentinel");
    }

    expect(() =>
      assertSecurePostgresCoordinationUrl(`${SENTINEL}?sslmode=verify-full`),
    ).not.toThrow();
  });

  test("allows plaintext only for exact localhost or literal loopback URLs", () => {
    for (const value of [
      "postgresql://postgres@localhost/coordination",
      "postgresql://postgres@127.0.0.1/coordination?sslmode=disable",
      "postgresql://postgres@127.23.45.67/coordination?sslmode=prefer",
      "postgresql://postgres@[::1]/coordination",
    ]) {
      expect(() => assertSecurePostgresCoordinationUrl(value)).not.toThrow();
    }

    expect(() =>
      assertSecurePostgresCoordinationUrl(
        "postgresql://postgres@localhost/coordination?SSL=disable",
      ),
    ).toThrow("PostgreSQL coordination URL is invalid");
  });
});
