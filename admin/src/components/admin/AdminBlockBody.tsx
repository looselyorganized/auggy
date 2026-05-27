/**
 * Shared renderer for an `AdminInfoBlock`'s sections + action forms.
 *
 * Single source of truth for how augment-contributed blocks render in the
 * SPA — used by the Augments tab (inline expansion), Budget tab (the
 * promoted budgets block), and Security tab (composes webTransport's
 * Posture block + visitorAuth's visitor block).
 *
 * Keeping the section routing here means new section kinds (`status`,
 * `eventStream`, future variants) gain support in one place, not three.
 */

import { KeyValueSection } from "./sections/KeyValueSection";
import { TableSection } from "./sections/TableSection";
import { StatusSection } from "./sections/StatusSection";
import { EventStreamSection } from "./sections/EventStreamSection";
import { ActionForm } from "./ActionForm";
import type { AdminInfoBlock } from "@/lib/types";

export function SectionRouter({ section }: { section: AdminInfoBlock["sections"][number] }) {
  switch (section.kind) {
    case "keyValue":
      return <KeyValueSection rows={section.rows} />;
    case "table":
      return (
        <TableSection
          columns={section.columns}
          rows={section.rows}
          rowActions={section.rowActions}
          caption={section.caption}
        />
      );
    case "status":
      return <StatusSection level={section.level} message={section.message} />;
    case "eventStream":
      return <EventStreamSection events={section.events} caption={section.caption} />;
  }
}

/**
 * Renders the body of an admin block: all sections in order, followed by
 * any augment-level action forms. Container styling is left to the caller
 * — pass children inside whatever Card / panel suits the tab.
 */
export function AdminBlockBody({ block }: { block: AdminInfoBlock }) {
  return (
    <div className="space-y-4">
      {block.sections.map((section, i) => (
        <SectionRouter key={i} section={section} />
      ))}
      {block.actions?.length ? (
        <div className="flex flex-wrap gap-3 border-t pt-3">
          {block.actions.map((action) => (
            <ActionForm key={action.id} action={action} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
