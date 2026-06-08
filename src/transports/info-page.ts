import type { AgentCard } from "../types";

/**
 * Escape a string for safe inclusion in HTML text content or attribute values.
 * Order matters: `&` must be replaced first so subsequent replacements don't
 * double-encode their introduced ampersands.
 *
 * Covers the five HTML metacharacters that matter for both element content and
 * double-quoted attribute values: `&`, `<`, `>`, `"`, `'`.
 */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const FALLBACK = "An Auggy agent";

const PUBLIC_PAGE_THEME_SCRIPT = `<script>
(function () {
  var themeKey = "auggy-theme";
  var legacyThemeKey = "auggy-admin-theme";
  var integrationKey = "auggy-public-integration";
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  var currentTheme = "light";
  function storedTheme() {
    try {
      var theme = localStorage.getItem(themeKey) || localStorage.getItem(legacyThemeKey);
      return theme === "light" || theme === "dark" ? theme : null;
    } catch (_) {
      return null;
    }
  }
  function applyTheme() {
    var theme = storedTheme() || (media.matches ? "dark" : "light");
    currentTheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    updateToggle();
  }
  function setTheme(theme) {
    try {
      localStorage.setItem(themeKey, theme);
      localStorage.removeItem(legacyThemeKey);
    } catch (_) {}
    applyTheme();
  }
  function updateToggle() {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    var next = currentTheme === "dark" ? "light" : "dark";
    button.textContent = next === "dark" ? "Dark mode" : "Light mode";
    button.setAttribute("aria-label", "Theme: " + currentTheme + ". Switch to " + next + ".");
    button.setAttribute("title", "Theme: " + currentTheme);
  }
  applyTheme();
  media.addEventListener("change", function () {
    if (!storedTheme()) applyTheme();
  });
  window.addEventListener("storage", function (event) {
    if (event.key === themeKey || event.key === legacyThemeKey) applyTheme();
    if (event.key === integrationKey) window.location.reload();
  });
  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme-toggle");
    if (!button) return;
    updateToggle();
    button.addEventListener("click", function () {
      setTheme(currentTheme === "dark" ? "light" : "dark");
    });
  });
})();
</script>`;

const PUBLIC_PAGE_CSS = `
    :root { color-scheme: light; --background: #f5f1e7; --foreground: #181a1e; --card: #fffaf0; --muted: #e9e2d2; --muted-foreground: #6f6457; --border: #d8cdb6; --primary: #181a1e; --primary-foreground: #f5f1e7; --accent: #e85d24; --ok: #176b5d; --ok-bg: #edf6f2; --warn: #8c5a18; --warn-bg: #fff7e8; --code: #ece6d9; --code-bg: #181a1e; --code-fg: #f5f1e7; --note-border: #f0dfbd; }
    :root.dark { color-scheme: dark; --background: #181a1e; --foreground: #f5f1e7; --card: #24262b; --muted: #2f3137; --muted-foreground: #c1b9ab; --border: #3d3f46; --primary: #f5f1e7; --primary-foreground: #181a1e; --accent: #e85d24; --ok: #5fd1a6; --ok-bg: #17342e; --warn: #f1b45f; --warn-bg: #322716; --code: #2f3137; --code-bg: #0f1115; --code-fg: #f5f1e7; --note-border: #574521; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--background); color: var(--foreground); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
    a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    code { border-radius: 4px; background: var(--code); padding: 0.1rem 0.34rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
    pre { margin: 10px 0 0; padding: 14px; border-radius: 7px; background: var(--code-bg); color: var(--code-fg); overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; white-space: pre; }
    .signal { height: 6px; background: var(--accent); }
    .status-row { width: min(1060px, calc(100% - 48px)); margin: 24px auto 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .brand-title { margin: 0; font-size: 15px; font-weight: 760; line-height: 1.2; }
    .brand-subtitle { margin: 1px 0 0; color: var(--muted-foreground); font-size: 12px; }
    .status-actions { display: inline-flex; align-items: center; gap: 8px; }
    .status-pill { display: inline-flex; min-height: 30px; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid #cfe5dc; border-radius: 999px; background: var(--ok-bg); color: var(--ok); font-size: 12px; font-weight: 760; white-space: nowrap; }
    .theme-toggle { min-height: 30px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--foreground); padding: 0 10px; font: inherit; font-size: 12px; font-weight: 760; cursor: pointer; white-space: nowrap; }
    .theme-toggle:hover { background: var(--muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #1ea66a; box-shadow: 0 0 0 4px rgba(30, 166, 106, 0.12); }
    .content { min-width: 0; padding: 28px 24px 42px; }
    .content-inner { width: min(1060px, 100%); margin: 0 auto; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: stretch; margin-bottom: 16px; }
    .below, .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel, .hero-main { border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
    .hero-main { padding: 28px; }
    .panel { padding: 18px; }
    .eyebrow { margin: 0 0 6px; color: var(--muted-foreground); font-size: 12px; font-weight: 760; }
    h1 { max-width: 760px; margin: 0; font-size: clamp(34px, 5vw, 56px); line-height: 1.02; letter-spacing: 0; }
    .purpose, .lede, .hero-main p:not([class]) { max-width: 70ch; margin: 12px 0 0; color: var(--muted-foreground); font-size: 15px; }
    .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 20px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 13px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--foreground); font-size: 13px; font-weight: 720; text-decoration: none; }
    .button.primary { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
    .panel h2 { margin: 0 0 10px; font-size: 16px; letter-spacing: 0; }
    .panel p { margin: 0 0 13px; color: var(--muted-foreground); font-size: 13px; }
    .meta-list, .facts { display: grid; gap: 11px; margin-top: 14px; }
    .meta-row, .fact { display: flex; justify-content: space-between; gap: 12px; padding-top: 11px; border-top: 1px solid color-mix(in srgb, var(--border) 72%, white); font-size: 13px; }
    .meta-row:first-child, .fact:first-child { padding-top: 0; border-top: 0; }
    .label { color: var(--muted-foreground); }
    .value { font-weight: 760; text-align: right; overflow-wrap: anywhere; }
    .notice, .note { border: 1px solid var(--note-border); border-radius: 8px; background: var(--warn-bg); padding: 13px; color: #4f3920; font-size: 13px; }
    .notice strong { display: block; margin-bottom: 4px; color: var(--warn); }
    .note { margin-top: 18px; }
    .steps { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
    .steps li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; align-items: start; color: var(--foreground); font-size: 13px; }
    .mark { width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 50%; background: var(--muted); color: var(--foreground); font-size: 12px; font-weight: 900; }
    @media (max-width: 900px) { .hero, .below, .grid { grid-template-columns: 1fr; } .status-row { width: calc(100% - 36px); margin-top: 18px; align-items: flex-start; } .status-actions { align-items: flex-end; flex-direction: column; } .content { padding: 18px; } .hero-main { padding: 22px; } }
`;

export interface InfoPageOptions {
  publicIntegration?: boolean;
}

interface AgentText {
  escapedName: string;
  escapedPurpose: string;
  hasName: boolean;
  hasPurpose: boolean;
  heading: string;
}

interface PublicDocumentOptions {
  body: string;
  description: string;
  extraHead?: string;
  title: string;
}

function getAgentText(card: AgentCard): AgentText {
  const rawName = card.provider.displayName ?? card.provider.name;
  const hasName = rawName.trim() !== "";
  const escapedName = hasName ? escapeHtml(rawName) : "";

  const purposeStr = card.purpose ?? "";
  const hasPurpose = purposeStr.trim() !== "";
  const escapedPurpose = hasPurpose ? escapeHtml(purposeStr) : "";

  return {
    escapedName,
    escapedPurpose,
    hasName,
    hasPurpose,
    heading: hasName ? escapedName : FALLBACK,
  };
}

function renderPublicDocument({
  body,
  description,
  extraHead = "",
  title,
}: PublicDocumentOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:type" content="website">
${extraHead}  ${PUBLIC_PAGE_THEME_SCRIPT}
  <style>${PUBLIC_PAGE_CSS}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderStatusRow({
  ariaLabel,
  subtitle,
  title,
  status,
}: {
  ariaLabel: string;
  subtitle: string;
  title: string;
  status: string;
}): string {
  return `  <div class="status-row" aria-label="${ariaLabel}">
    <div>
      <p class="brand-title">${title}</p>
      <p class="brand-subtitle">${subtitle}</p>
    </div>
    <div class="status-actions">
      <button id="theme-toggle" class="theme-toggle" type="button">Theme</button>
      <div class="status-pill"><span class="dot" aria-hidden="true"></span> ${status}</div>
    </div>
  </div>`;
}

function renderContent(inner: string): string {
  return `  <main class="content">
    <div class="content-inner">
${inner}
    </div>
  </main>`;
}

function renderPanel({
  ariaLabel,
  body,
  title,
}: {
  ariaLabel?: string;
  body: string;
  title: string;
}): string {
  const aria = ariaLabel ? ` aria-label="${ariaLabel}"` : "";
  return `        <section class="panel"${aria}>
          <h2>${title}</h2>
${body}
        </section>`;
}

function renderMetaRows(rows: Array<[string, string]>): string {
  return `<div class="meta-list">
${rows
  .map(
    ([label, value]) =>
      `            <div class="meta-row"><span class="label">${label}</span><span class="value">${value}</span></div>`,
  )
  .join("\n")}
          </div>`;
}

function renderFacts(rows: Array<[string, string]>): string {
  return `<div class="facts">
${rows
  .map(
    ([label, value]) =>
      `            <div class="fact"><span class="label">${label}</span><span class="value">${value}</span></div>`,
  )
  .join("\n")}
          </div>`;
}

function renderActions(actions: Array<{ href: string; label: string; primary?: boolean }>): string {
  return `<div class="actions">
${actions
  .map(
    (action) =>
      `            <a class="button${action.primary ? " primary" : ""}" href="${action.href}">${action.label}</a>`,
  )
  .join("\n")}
          </div>`;
}

/**
 * Render the unauthenticated info page served at `GET /` when no
 * `publicFrontendUrl` is configured. Pure function — no I/O, no kernel deps,
 * deterministic output for a given AgentCard. Cached at register-time by
 * `web-transport.ts` so per-request cost is just Response construction.
 */
export function renderInfoPage(card: AgentCard, opts: InfoPageOptions = {}): string {
  const { escapedName, escapedPurpose, hasName, hasPurpose, heading } = getAgentText(card);
  const title = hasName ? `${escapedName} — Auggy agent` : FALLBACK;
  const alternateLink = opts.publicIntegration
    ? `  <link rel="alternate" type="application/json" href="/.well-known/agent-card.json">\n`
    : "";
  const integrationValue = opts.publicIntegration ? '<a href="/agent">Published</a>' : "Private";
  const integrationLink = opts.publicIntegration
    ? `\n          <p>Developers can review the <a href="/agent">public integration page</a>.</p>`
    : "";

  const body = [
    `  <div class="signal" aria-hidden="true"></div>`,
    renderStatusRow({
      ariaLabel: "Agent status",
      subtitle: "Default backend home",
      title: "Auggy",
      status: "Agent running",
    }),
    renderContent(`      <section class="hero" aria-label="Agent home">
        <div class="hero-main">
          <p class="eyebrow">${heading} is ready</p>
          <h1>This agent backend is online.</h1>
          <p class="purpose">${hasPurpose ? escapedPurpose : "No public frontend is configured yet. Use the console to test and configure the agent, or publish a frontend when this is ready for visitors."}</p>
${renderActions([
  { href: "/console", label: "Open console", primary: true },
  ...(opts.publicIntegration ? [{ href: "/agent", label: "Integration page" }] : []),
])}
        </div>
        <aside class="panel" aria-label="Agent summary">
          <h2>Agent summary</h2>
          <p>Public-safe metadata for orientation. Operational details live in <code>/console</code>.</p>
          ${renderMetaRows([
            ["Name", heading],
            ["Frontend", "Not configured"],
            ["Integration", integrationValue],
          ])}
        </aside>
      </section>
      <section class="below">
${renderPanel({
  title: "For the creator",
  body: `          <p>Use the console for chat testing, identity, credentials, skills, memory, and frontend publishing.</p>
          <div class="actions"><a class="button" href="/console/integrations">Integration setup</a></div>`,
})}
${renderPanel({
  title: "For visitors",
  body: `          <div class="notice"><strong>No public chat frontend is attached yet.</strong>This URL is currently the agent backend home. Normal visitors should use the frontend configured by the creator.</div>${integrationLink}`,
})}
      </section>`),
  ].join("\n");

  return renderPublicDocument({
    body,
    description: escapedPurpose,
    extraHead: alternateLink,
    title,
  });
}

/**
 * Render the optional public human-readable integration surface at `GET /agent`.
 * Keep this intentionally conservative: full operator DX lives behind
 * `/console`; the public page only orients developers after the creator opts in.
 */
export function renderAgentIntegrationPage(card: AgentCard): string {
  const { escapedName, escapedPurpose, hasName, hasPurpose, heading } = getAgentText(card);
  const title = hasName ? `${escapedName} — integration` : "Agent integration";
  const purposeParagraph = hasPurpose ? `\n          <p>${escapedPurpose}</p>` : "";
  const body = [
    `  <div class="signal" aria-hidden="true"></div>`,
    renderStatusRow({
      ariaLabel: "Integration status",
      subtitle: "Public integration surface",
      title: heading,
      status: "Integration published",
    }),
    renderContent(`      <section class="hero" aria-label="Agent integration overview">
        <div class="hero-main">
          <p class="eyebrow">Connect a client to this agent</p>
          <h1>Integration details for ${heading}.</h1>
          <p class="lede">This page is safe to share with developers. It explains how to discover the agent, where to send AG-UI requests, and where creator-only setup lives.</p>${purposeParagraph}
${renderActions([
  { href: "/.well-known/agent-card.json", label: "View agent card JSON", primary: true },
  { href: "/console/integrations", label: "Creator setup" },
  { href: "/", label: "Back to home" },
])}
        </div>
        <aside class="panel" aria-label="Protocol summary">
          <h2>Protocol summary</h2>
          <p>Stable public metadata. Creator-only details stay in <code>/console</code>.</p>
          ${renderFacts([
            ["Protocol", "AG-UI over HTTP"],
            ["Run endpoint", "POST /agent/run"],
            ["Discovery", "/.well-known/agent-card.json"],
            ["Auth", "Bearer token required"],
          ])}
        </aside>
      </section>
      <section class="grid">
${renderPanel({
  title: "Start here",
  body: `          <ul class="steps">
            <li><span class="mark">1</span><span>Fetch the agent card to inspect capabilities, interfaces, and declared metadata.</span></li>
            <li><span class="mark">2</span><span>Build or configure an AG-UI client that sends messages to <code>POST /agent/run</code>.</span></li>
            <li><span class="mark">3</span><span>Use credentials or an access flow provided by the agent creator.</span></li>
          </ul>
          <pre>curl /.well-known/agent-card.json</pre>`,
})}
${renderPanel({
  title: "Minimal request shape",
  body: `          <p>This page shows shape, not secrets. Replace the token with credentials from the agent creator.</p>
          <pre>POST /agent/run
Authorization: Bearer &lt;token&gt;
Content-Type: application/json

{
  "threadId": "example",
  "messages": [
    { "role": "user", "content": "What can you help with?" }
  ]
}</pre>
          <div class="note">Credential management, CORS posture, generated snippets, and frontend redirect setup belong in <code>/console/integrations</code>.</div>`,
})}
      </section>`),
  ].join("\n");

  return renderPublicDocument({
    body,
    description: escapedPurpose,
    extraHead: `  <link rel="alternate" type="application/json" href="/.well-known/agent-card.json">\n`,
    title,
  });
}
