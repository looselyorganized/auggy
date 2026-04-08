import { describe, it, expect } from "bun:test";
import { extractText, textPart, dataPart } from "@/parts";
import type { Part } from "@/types";

describe("extractText", () => {
  it("returns empty string for empty parts array", () => {
    expect(extractText([])).toBe("");
  });

  it("extracts text from a single text part", () => {
    const parts: Part[] = [{ kind: "text", text: "hello" }];
    expect(extractText(parts)).toBe("hello");
  });

  it("concatenates multiple text parts with newlines", () => {
    const parts: Part[] = [
      { kind: "text", text: "line one" },
      { kind: "text", text: "line two" },
    ];
    expect(extractText(parts)).toBe("line one\nline two");
  });

  it("ignores file parts when extracting text", () => {
    const parts: Part[] = [
      { kind: "text", text: "hello" },
      { kind: "file", uri: "file:///foo.pdf", mimeType: "application/pdf" },
    ];
    expect(extractText(parts)).toBe("hello");
  });

  it("serializes data parts to JSON when extracting text", () => {
    const parts: Part[] = [
      { kind: "text", text: "summary:" },
      { kind: "data", data: { count: 3 } },
    ];
    expect(extractText(parts)).toBe('summary:\n{"count":3}');
  });
});

describe("textPart", () => {
  it("constructs a text part", () => {
    expect(textPart("hello")).toEqual({ kind: "text", text: "hello" });
  });
});

describe("dataPart", () => {
  it("constructs a data part", () => {
    expect(dataPart({ key: "value" })).toEqual({
      kind: "data",
      data: { key: "value" },
    });
  });
});
