import type { AdminActionInput, AdminInfoBlock, AdminSection, AgentCard } from "../../types";

export interface RenderAdminPageOpts {
  card: AgentCard;
  blocks: AdminInfoBlock[];
  csrfToken: string;
  flashMessage?: string;
}

const FOOTER_NOTICE =
  "Admin credentials are visible in browser devtools; don't share screenshots that include the Network tab.";

const CSS = `
  body { font-family: system-ui, sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; color: #222; line-height: 1.4; }
  h1 { margin-bottom: 0; }
  .meta { color: #666; font-size: 0.9em; margin-top: 0; }
  .flash-ok { background: #d4edda; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1rem; }
  section { border: 1px solid #ddd; padding: 1rem 1.5rem; margin-bottom: 1.5rem; border-radius: 4px; }
  section h2 { margin-top: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  dd .source { color: #666; font-size: 0.85em; margin-left: 0.5rem; }
  table { width: 100%; border-collapse: collapse; }
  table caption { color: #666; font-size: 0.85em; text-align: left; margin-bottom: 0.5rem; }
  th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f4f4f4; }
  code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9em; }
  form.action-form { display: inline-flex; gap: 0.5rem; align-items: end; margin-top: 0.75rem; }
  form.reset-form { display: inline; }
  .status-ok { background: #d4edda; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .status-warn { background: #fff3cd; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .status-error { background: #f8d7da; padding: 0.5rem 0.75rem; border-radius: 4px; }
  button { padding: 0.4rem 0.8rem; cursor: pointer; }
`.trim();

export function renderAdminPage(opts: RenderAdminPageOpts): string {
  const name = opts.card.provider.name || "this agent";
  const escapedName = escapeHtml(name);
  const flash = opts.flashMessage
    ? `\n  <div class="flash-ok">${escapeHtml(opts.flashMessage)}</div>`
    : "";

  const blocksHtml = opts.blocks
    .filter((b) => b.sections.length > 0 || (b.actions && b.actions.length > 0))
    .map((b) => renderBlock(b, opts.csrfToken))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapedName} — admin</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>${escapedName}</h1>
  <p class="meta">admin · auggy</p>${flash}
${blocksHtml}
  <footer>
    <p style="color: #666; font-size: 0.85em">${escapeHtml(FOOTER_NOTICE)}</p>
  </footer>
</body>
</html>`;
}

function renderBlock(block: AdminInfoBlock, csrfToken: string): string {
  const sectionsHtml = block.sections.map((s) => renderSection(s, csrfToken)).join("\n");
  const actionsHtml = (block.actions ?? [])
    .map((action) => renderAction(action, csrfToken))
    .join("\n");

  return `  <section>
    <h2>${escapeHtml(block.title)}</h2>
${sectionsHtml}
${actionsHtml}
  </section>`;
}

function renderSection(section: AdminSection, csrfToken: string): string {
  switch (section.kind) {
    case "keyValue": {
      const rows = section.rows
        .map((r) => {
          const src = r.source ? ` <span class="source">${escapeHtml(r.source)}</span>` : "";
          const resetBtn = r.resetAction ? renderResetButton(r.resetAction, csrfToken) : "";
          return `      <dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}${src}${resetBtn}</dd>`;
        })
        .join("\n");
      return `    <dl>\n${rows}\n    </dl>`;
    }
    case "table": {
      const caption = section.caption
        ? `      <caption>${escapeHtml(section.caption)}</caption>\n`
        : "";
      const head = `      <thead><tr>${section.columns
        .map((c) => `<th>${escapeHtml(c)}</th>`)
        .join("")}</tr></thead>`;
      const body = `      <tbody>${section.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      return `    <table>\n${caption}${head}\n${body}\n    </table>`;
    }
    case "status": {
      return `    <div class="status-${section.level}">${escapeHtml(section.message)}</div>`;
    }
    case "eventStream": {
      const head = `      <thead><tr><th>Time</th><th>Type</th><th>Summary</th></tr></thead>`;
      const body = `      <tbody>${section.events
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.timestamp)}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.summary)}</td></tr>`,
        )
        .join("")}</tbody>`;
      const caption = section.caption
        ? `      <caption>${escapeHtml(section.caption)}</caption>\n`
        : "";
      return `    <table>\n${caption}${head}\n${body}\n    </table>`;
    }
  }
}

function renderAction(
  action: { id: string; label: string; confirmRequired: boolean; inputs?: AdminActionInput[] },
  csrfToken: string,
): string {
  // M1 fix — generic confirm message instead of interpolating action.label
  // into JS. Action labels containing `'` or `"` would otherwise break the
  // inline onsubmit JS string (the HTML parser decodes &#39; → ' INSIDE the
  // attribute value before the JS sees it).
  const confirmAttr = action.confirmRequired
    ? ` onsubmit="return confirm('Confirm this action?')"`
    : "";
  const inputs = (action.inputs ?? [])
    .map((input) => {
      const type = input.type === "boolean" ? "checkbox" : input.type;
      const def = input.default !== undefined ? ` value="${escapeHtml(input.default)}"` : "";
      const req = input.required ? " required" : "";
      const help = input.helpText ? `<small>${escapeHtml(input.helpText)}</small>` : "";
      return `      <label>${escapeHtml(input.label)}: <input type="${type}" name="${escapeHtml(
        input.name,
      )}"${def}${req}></label>${help}`;
    })
    .join("\n");
  return `    <form class="action-form" action="/admin/action/${escapeHtml(
    action.id,
  )}" method="POST"${confirmAttr}>
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
${inputs}
      <button type="submit">${escapeHtml(action.label)}</button>
    </form>`;
}

// S6 — reset-to-yaml button rendered next to keyValue rows whose resetAction
// is set. The augment's adminInfo() decides when to populate resetAction
// (Phase 3 work). Phase 2's renderer just honors the field.
function renderResetButton(reset: { id: string; label: string }, csrfToken: string): string {
  return ` <form class="reset-form" action="/admin/action/${escapeHtml(
    reset.id,
  )}" method="POST" onsubmit="return confirm('Confirm this action?')"><input type="hidden" name="_csrf" value="${escapeHtml(
    csrfToken,
  )}"><button type="submit">${escapeHtml(reset.label)}</button></form>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
