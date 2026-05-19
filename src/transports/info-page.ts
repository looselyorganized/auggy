import type { AgentCard } from "../types";

/**
 * Escape a string for safe inclusion in HTML text content or attribute values.
 * Order matters: `&` must be replaced first so subsequent replacements don't
 * double-encode their introduced ampersands.
 *
 * Covers the five HTML metacharacters that matter for both element content and
 * double-quoted attribute values: `&`, `<`, `>`, `"`, `'`.
 */
function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const FALLBACK = "An Auggy agent";

/**
 * Render the unauthenticated info page served at `GET /` when no
 * `publicFrontendUrl` is configured. Pure function — no I/O, no kernel deps,
 * deterministic output for a given AgentCard. Cached at register-time by
 * `web-transport.ts` so per-request cost is just Response construction.
 */
export function renderInfoPage(card: AgentCard): string {
  const rawName = card.provider.name;
  const hasName = rawName.trim() !== "";
  const escapedName = hasName ? escape(rawName) : "";
  const title = hasName ? `${escapedName} — Auggy agent` : FALLBACK;
  const heading = hasName ? escapedName : FALLBACK;

  // `??` flattens `string | undefined` to `string` so the next escape() call
  // type-checks cleanly. The trim check then decides whether the paragraph
  // and meta tags render with the value or stay empty.
  const purposeStr = card.purpose ?? "";
  const hasPurpose = purposeStr.trim() !== "";
  const escapedPurpose = hasPurpose ? escape(purposeStr) : "";
  const purposeParagraph = hasPurpose ? `\n  <p>${escapedPurpose}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title}</title>
  <meta name="description" content="${escapedPurpose}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${escapedPurpose}">
  <meta property="og:type" content="website">
  <link rel="alternate" type="application/json" href="/.well-known/agent-card.json">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
    code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.95em; }
    a { color: #0a66c2; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  <p>This is an <a href="https://github.com/looselyorganized/augment-1">Auggy</a> agent backend.</p>${purposeParagraph}
  <p>To interact:</p>
  <ul>
    <li>Inspect the <a href="/.well-known/agent-card.json">agent card</a></li>
    <li>Bring your own AG-UI client and <code>POST /agent/run</code></li>
    <li>Or configure <code>publicFrontendUrl</code> in <code>agent.yaml</code> to redirect visitors to a polished frontend</li>
  </ul>
</body>
</html>`;
}
