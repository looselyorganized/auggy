/**
 * Pure HTML builders for the verify-success + verify-failure pages.
 *
 * Security posture (spec fix #5):
 *   - <meta name="referrer" content="no-referrer">
 *   - Zero external assets (inline CSS, no fonts, no analytics, no images)
 *   - history.replaceState fires on load to drop the token from the URL bar
 *     before any browser history snapshot
 *   - The visitor token is JSON-encoded and </script>-escaped before being
 *     written into the inline <script> block
 *   - The email is rendered via document.createTextNode (innerText), not innerHTML
 */

export interface VerifySuccessPageInput {
  visitorToken: string;
  email: string;
}

export interface VerifyFailurePageInput {
  reason: "expired" | "consumed" | "unknown" | "malformed" | string;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON-encode a string for safe interpolation inside an inline <script>.
 * The U+003C escape neutralizes any embedded `</script>` so the script block
 * cannot be terminated by attacker-controlled content.
 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const COMMON_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auggy — verification</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; padding: 3rem 1rem; max-width: 36rem; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0.5rem 0; color: #555; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #eee; }
  p { color: #aaa; }
}
</style>
</head>`;

export function buildVerifySuccessPage(input: VerifySuccessPageInput): string {
  const tokenLit = jsStringLiteral(input.visitorToken);
  const emailLit = jsStringLiteral(input.email);
  return `${COMMON_HEAD}
<body>
<h1 id="title">Verifying…</h1>
<p id="msg">Please wait.</p>
<script>
(function () {
  var token = ${tokenLit};
  var email = ${emailLit};
  try {
    localStorage.setItem('auggy-visitor-token', token);
  } catch (_) { /* storage may be denied; surface manual fallback below */ }
  try {
    history.replaceState(null, '', '/visitor-auth/verified');
  } catch (_) { /* older browsers — best-effort */ }
  var titleEl = document.getElementById('title');
  var msgEl = document.getElementById('msg');
  if (titleEl) titleEl.textContent = 'Verified.';
  if (msgEl) {
    msgEl.textContent = 'Email verified: ' + email + '. You may close this tab; your chat tab will pick up the new identity on its next message. If you opened this link on a different device, refresh your chat tab.';
  }
})();
</script>
<noscript>
<p>Email verified, but JavaScript is required to apply the new identity to your chat tab. Please re-open your chat tab manually.</p>
</noscript>
</body>
</html>`;
}

const FAILURE_COPY: Record<string, string> = {
  expired: "This verification link has expired. Please ask the agent to send a new one.",
  consumed: "This verification link has already been used. If you didn't expect this, request a new link.",
  unknown: "We don't recognize this verification link. It may be malformed or out of date.",
  malformed: "This verification link is malformed.",
};

export function buildVerifyFailurePage(input: VerifyFailurePageInput): string {
  const known = FAILURE_COPY[input.reason];
  const safeReason = known ?? "Verification failed.";
  return `${COMMON_HEAD}
<body>
<h1>Verification failed</h1>
<p>${htmlEscape(safeReason)}</p>
</body>
</html>`;
}
