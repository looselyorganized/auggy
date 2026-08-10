/**
 * Shared `.env` parser/serializer used by both:
 *   - `loadEnvFile` in src/cli/config-parser.ts (runtime — populates
 *     process.env at agent boot)
 *   - `src/transports/admin/admin-credentials.ts` (operator UI — the
 *     Credentials tab read/write surface)
 *
 * Codex adversarial-review High-2 fix: a previous implementation had the
 * admin UI decoding `\n`, `\t`, `\"`, `\\` in double-quoted values while
 * the runtime loader did not. That meant a PEM, JSON blob, or any secret
 * containing newlines could silently render different values to the agent
 * after restart vs. what the operator saw in the UI. One parser, one
 * disk-format meaning.
 *
 * Quoting rules (parse + serialize, mirrored):
 *   - Bare value (no surrounding quotes): used verbatim, no escape decoding.
 *   - Double-quoted ("…"): outer quotes stripped; `\\`, `\"`, `\n`, `\t`,
 *     `\r` decoded inside (matches `dotenv` v15+).
 *   - Single-quoted ('…'): outer quotes stripped; contents are literal,
 *     no escape decoding (matches `dotenv`).
 *
 * Serialize chooses the minimal quoting that preserves the value:
 *   - empty / no special chars: bare
 *   - contains `\n`/`\t`/`"`/`\\` or whitespace/`=`/`$`/`#`: double-quoted
 *     with the escapes inverted.
 */

export type EnvLine =
  | { kind: "kv"; key: string; value: string; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank" };

// Bun accepts shell-compatible `export KEY=value` declarations in dotenv
// files. Treat the prefix as syntax, not as part of the key, so every shared
// dotenv consumer sees the same effective environment.
const KV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string): EnvLine[] {
  const lines = text.split(/\r?\n/);
  // Drop a trailing empty line caused by a file ending in \n so we don't
  // emit a phantom blank on every round-trip.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: EnvLine[] = [];
  for (const raw of lines) {
    if (raw.trim().length === 0) {
      out.push({ kind: "blank" });
      continue;
    }
    if (raw.trim().startsWith("#")) {
      out.push({ kind: "comment", raw });
      continue;
    }
    const m = raw.match(KV_LINE_RE);
    if (!m) {
      // Unrecognized — treat as a comment so it survives the round-trip.
      out.push({ kind: "comment", raw });
      continue;
    }
    const key = m[1]!;
    const value = decodeEnvValue(m[2]!);
    out.push({ kind: "kv", key, value, raw });
  }
  return out;
}

export function decodeEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // Single-pass scan so a literal `\\n` in the source (encoded form of a
    // backslash followed by "n") doesn't get misinterpreted as a real
    // newline. Chained .replace() would re-enter `\n` after `\\` was
    // shortened to `\`, double-decoding the sequence.
    const inner = trimmed.slice(1, -1);
    let out = "";
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!;
      if (c !== "\\" || i + 1 >= inner.length) {
        out += c;
        continue;
      }
      const next = inner[++i]!;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        default:
          // Unknown escape — keep the backslash so we don't corrupt the
          // value when round-tripping through encodeEnvValue, which would
          // re-escape the bare backslash.
          out += `\\${next}`;
      }
    }
    return out;
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function serializeEnv(lines: EnvLine[]): string {
  const body = lines
    .map((line) => {
      if (line.kind === "blank") return "";
      if (line.kind === "comment") return line.raw;
      return `${line.key}=${encodeEnvValue(line.value)}`;
    })
    .join("\n");
  return `${body}\n`;
}

export function encodeEnvValue(value: string): string {
  if (value === "") return "";
  // Quote when the value would round-trip ambiguously otherwise.
  const needsQuotes =
    /[\s"'=$#]|^\s|\s$/.test(value) || value.includes("\n") || value.includes("\t");
  if (!needsQuotes) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}
