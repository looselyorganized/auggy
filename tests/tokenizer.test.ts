import { describe, it, expect } from "bun:test";
import { createTokenizer } from "@/tokenizer";

describe("createTokenizer", () => {
  it("counts tokens for a simple string", () => {
    const tokenizer = createTokenizer();
    const count = tokenizer.count("Hello, world!");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it("returns 0 for empty string", () => {
    const tokenizer = createTokenizer();
    expect(tokenizer.count("")).toBe(0);
  });

  it("scales roughly with text length", () => {
    const tokenizer = createTokenizer();
    const short = tokenizer.count("Hello");
    const long = tokenizer.count("Hello ".repeat(100));
    expect(long).toBeGreaterThan(short * 10);
  });
});
