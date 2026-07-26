import { describe, expect, test } from "bun:test";
import { canonicalMemoryNamespace } from "@/augments/memory-namespace";

describe("canonicalMemoryNamespace", () => {
  test("canonicalizes whitespace, Unicode, and the historical trailing-colon alias", () => {
    const composed = canonicalMemoryNamespace(" Caf\u00e9 ");
    const decomposed = canonicalMemoryNamespace("Cafe\u0301:");
    expect(composed).toEqual(decomposed);
    expect(composed.prefix).toBe("Caf\u00e9:");
    expect(composed.key).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
  });

  test("rejects empty, NUL-bearing, and oversized namespaces", () => {
    for (const value of ["", " : ", "bad\0owner", "x".repeat(257)]) {
      expect(() => canonicalMemoryNamespace(value)).toThrow(/namespace.*1 to 256/i);
    }
  });

  test("rejects unpaired UTF-16 surrogates before UTF-8 key encoding", () => {
    for (const value of ["x\ud800", "x\ud801", "x\udc00", "x\udfff"]) {
      expect(() => canonicalMemoryNamespace(value)).toThrow(/well-formed Unicode/i);
    }
    expect(() => canonicalMemoryNamespace("x\ud83d\ude80")).not.toThrow();
  });

  test("assigns distinct exact keys to parent, child, and case variants", () => {
    const keys = ["Foo", "Foo:bar", "foo"].map(
      (namespace) => canonicalMemoryNamespace(namespace).key,
    );
    expect(new Set(keys).size).toBe(3);
  });
});
