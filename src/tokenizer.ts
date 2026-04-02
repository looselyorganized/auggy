export interface Tokenizer {
  count(text: string): number;
}

export function createTokenizer(): Tokenizer {
  return {
    count(text: string): number {
      if (text.length === 0) return 0;
      // ~4 chars per token approximation. Accurate to ±15% for English.
      // Replace with tiktoken for production accuracy.
      return Math.ceil(text.length / 4);
    },
  };
}
