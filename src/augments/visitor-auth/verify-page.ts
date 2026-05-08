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

export interface VerifyConfirmPageInput {
  token: string;
  publicUrl: string;
}

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

/**
 * Confirmation page returned by GET /visitor-auth/verify.
 *
 * Mail scanners follow links passively (GET); they do NOT auto-submit forms.
 * Returning this page on GET means the scanner harmlessly receives the
 * confirmation page without consuming the one-time token. The human clicks
 * "Verify my email" which triggers a form POST that actually consumes it.
 *
 * Security notes:
 *   - <meta name="referrer" content="no-referrer"> prevents the token from
 *     leaking in Referer headers to third parties.
 *   - The form POSTs to an absolute URL (publicUrl) to guarantee same-site
 *     submission even if the user opened the link on a different device.
 *   - Inline JS disables the button after click to prevent accidental double-
 *     submit within the same page load.
 *   - NO localStorage write, NO history.replaceState — those happen on the
 *     success page served after the POST.
 */
export function buildVerifyConfirmPage(input: VerifyConfirmPageInput): string {
  const base = input.publicUrl.endsWith("/") ? input.publicUrl.slice(0, -1) : input.publicUrl;
  const actionUrl = `${base}/visitor-auth/verify`;
  // Token comes from validated UUID input — safe to embed as a hidden field value.
  // htmlEscape is applied for correctness even though UUIDs are [0-9a-f-] only.
  const safeToken = htmlEscape(input.token);
  return `${COMMON_HEAD}
<body>
<h1>Verify your email</h1>
<p>Click the button below to complete email verification. This link can only be used once.</p>
<form method="POST" action="${htmlEscape(actionUrl)}" id="vf">
  <input type="hidden" name="token" value="${safeToken}">
  <button type="submit" id="btn" style="font-size:1rem;padding:0.6rem 1.4rem;cursor:pointer;">Verify my email</button>
</form>
<script>
(function(){
  var btn = document.getElementById('btn');
  var form = document.getElementById('vf');
  if (form && btn) {
    form.addEventListener('submit', function(){
      btn.disabled = true;
      btn.textContent = 'Verifying…';
    });
  }
})();
</script>
<noscript><p>Submit the form above to verify your email.</p></noscript>
</body>
</html>`;
}

export function buildVerifySuccessPage(input: VerifySuccessPageInput): string {
  const tokenLit = jsStringLiteral(input.visitorToken);
  const emailLit = jsStringLiteral(input.email);
  return `${COMMON_HEAD}
<body>
<h1 id="title">Verifying…</h1>
<p id="msg">Please wait.</p>
<p id="storage-fallback" style="display:none">
  Verified, but your browser blocked storage access. Copy this token manually to your chat tab:
  <br><code id="manual-token" style="word-break:break-all"></code>
  <br><small>(This may happen in private/incognito mode or sandboxed iframes.)</small>
</p>
<script>
(function () {
  var token = ${tokenLit};
  var email = ${emailLit};
  var storageWorks = false;
  try {
    localStorage.setItem('auggy-visitor-token', token);
    storageWorks = true;
  } catch (_) { /* storage may be denied in private/incognito mode or sandboxed iframes */ }
  try {
    history.replaceState(null, '', './verified');
  } catch (_) { /* older browsers — best-effort */ }
  var titleEl = document.getElementById('title');
  var msgEl = document.getElementById('msg');
  var fallbackEl = document.getElementById('storage-fallback');
  var manualEl = document.getElementById('manual-token');
  if (titleEl) titleEl.textContent = 'Verified.';
  if (storageWorks) {
    if (msgEl) {
      msgEl.textContent = 'Email verified: ' + email + '. You may close this tab; your chat tab will pick up the new identity on its next message. If you opened this link on a different device, refresh your chat tab.';
    }
  } else {
    if (msgEl) msgEl.style.display = 'none';
    if (fallbackEl) fallbackEl.style.display = '';
    if (manualEl) manualEl.textContent = token;
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
  consumed:
    "This verification link has already been used. If you didn't expect this, request a new link.",
  unknown: "We don't recognize this verification link. It may be malformed or out of date.",
  malformed: "This verification link is malformed.",
  "bad-body":
    "The verification request was malformed (could not parse the request body).",
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
