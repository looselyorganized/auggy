/**
 * Tiny line-level diff. Walks both sides via a classic LCS table and emits
 * a sequence of `{ kind: "context" | "add" | "remove", line, oldLine?, newLine? }`
 * chunks suitable for an inline unified-style render.
 *
 * Good enough for identity.md (a few KB max). Not optimized for very large
 * files — the LCS table is O(m × n) memory; cap inputs to ~50k lines and
 * we'll fall back to a "files differ" placeholder if the table would blow
 * past that threshold.
 */

export type DiffOp =
  | { kind: "context"; oldLine: number; newLine: number; text: string }
  | { kind: "remove"; oldLine: number; text: string }
  | { kind: "add"; newLine: number; text: string };

const MAX_LINES = 50_000;

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      { kind: "remove", oldLine: 1, text: `(file too large for inline diff — ${a.length} → ${b.length} lines)` },
    ];
  }

  // Build LCS table. dp[i][j] = length of LCS of a[..i-1] + b[..j-1].
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // Backtrack to produce ops in reverse, then flip.
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "context", oldLine: i, newLine: j, text: a[i - 1]! });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: "remove", oldLine: i, text: a[i - 1]! });
      i--;
    } else {
      ops.push({ kind: "add", newLine: j, text: b[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ kind: "remove", oldLine: i, text: a[i - 1]! });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: "add", newLine: j, text: b[j - 1]! });
    j--;
  }
  ops.reverse();
  return ops;
}

export interface DiffStats {
  added: number;
  removed: number;
  context: number;
}

export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  let context = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "remove") removed++;
    else context++;
  }
  return { added, removed, context };
}

function splitLines(s: string): string[] {
  // Preserve a trailing empty line for files that end in \n so the diff
  // reflects edits at the EOF position. `String.split` already does this.
  return s.split("\n");
}
