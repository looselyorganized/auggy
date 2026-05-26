/**
 * Server-side helpers for the `/admin` Memory tab.
 *
 * Walks every mounted memory provider and emits a unified entries list so
 * the SPA can group by peer / by label / flat with a single round-trip.
 * Static providers (fileMemory, supabaseMemory without listEntries) come
 * out as summary cards instead of entry rows — the SPA renders them at
 * the bottom of the tab.
 */

import type {
  Augment,
  MemoryEntry,
  NamespaceMemoryProvider,
  StaticMemoryProvider,
  TransportKernel,
} from "../../types";

export interface MemoryEntryView {
  /** Augment that owns this entry (`layered-memory-test_agent`, `file-memory-learned`, …). */
  augmentName: string;
  /** Canonical augment type (`layeredMemory`, `fileMemory`, …). */
  augmentType: string;
  /** Provider scope identifier — namespace prefix or static label. */
  scope: string;
  label: string;
  content: string;
  peerId: string | null;
  trustLevel: string | null;
  createdAtIso: string | null;
  origin: string | null;
  /** True when supersededBy is set — entry is shadowed by a newer write. */
  superseded: boolean;
}

export interface MemoryProviderSummary {
  augmentName: string;
  augmentType: string;
  kind: "namespace" | "static";
  scope: string;
  entryCount: number;
  /**
   * Reason a provider didn't surface its entries:
   *   - `listEntries` not implemented (namespace provider w/o admin browser)
   *   - static labels successfully enumerated (entries available; for symmetry)
   *   - the call threw
   */
  listSupported: boolean;
  listError: string | null;
}

export interface MemoryDashboard {
  entries: MemoryEntryView[];
  providers: MemoryProviderSummary[];
  totals: {
    entries: number;
    peers: number;
    providers: number;
  };
  /** Augment names that expose `forget(peerId)` — drives the "Erase peer" button. */
  peerForgetCapable: string[];
}

export async function collectMemoryDashboard(
  kernel: TransportKernel,
): Promise<MemoryDashboard> {
  const augments = kernel.getAugments();
  const entries: MemoryEntryView[] = [];
  const providers: MemoryProviderSummary[] = [];
  const peerForgetCapable: string[] = [];

  for (const aug of augments) {
    if (!aug.memory) continue;
    const augmentName = aug.name;
    const augmentType = aug.type ?? aug.name;

    if (aug.memory.owns.kind === "namespace") {
      const spec = aug.memory as NamespaceMemoryProvider;
      const scope = spec.owns.prefix;
      if (typeof spec.forget === "function") peerForgetCapable.push(augmentName);

      if (typeof spec.listEntries !== "function") {
        providers.push({
          augmentName,
          augmentType,
          kind: "namespace",
          scope,
          entryCount: 0,
          listSupported: false,
          listError: null,
        });
        continue;
      }
      try {
        const rows = await spec.listEntries({ limit: 1000 });
        for (const r of rows) entries.push(toView(augmentName, augmentType, scope, r));
        providers.push({
          augmentName,
          augmentType,
          kind: "namespace",
          scope,
          entryCount: rows.length,
          listSupported: true,
          listError: null,
        });
      } catch (err) {
        providers.push({
          augmentName,
          augmentType,
          kind: "namespace",
          scope,
          entryCount: 0,
          listSupported: true,
          listError: (err as Error).message,
        });
      }
      continue;
    }

    // Static provider — labels are known up front; read each for content.
    const spec = aug.memory as StaticMemoryProvider;
    const labels = spec.owns.labels;
    let staticCount = 0;
    let staticError: string | null = null;
    for (const label of labels) {
      try {
        const entry = await spec.read(label);
        if (entry) {
          entries.push(toView(augmentName, augmentType, label, entry));
          staticCount++;
        }
      } catch (err) {
        staticError = (err as Error).message;
      }
    }
    providers.push({
      augmentName,
      augmentType,
      kind: "static",
      scope: labels.join(", "),
      entryCount: staticCount,
      listSupported: true,
      listError: staticError,
    });
  }

  // Total peer count = distinct non-null peerIds across all entries.
  const peerSet = new Set<string>();
  for (const e of entries) if (e.peerId) peerSet.add(e.peerId);

  return {
    entries,
    providers,
    totals: {
      entries: entries.length,
      peers: peerSet.size,
      providers: providers.length,
    },
    peerForgetCapable,
  };
}

function toView(
  augmentName: string,
  augmentType: string,
  scope: string,
  entry: MemoryEntry,
): MemoryEntryView {
  return {
    augmentName,
    augmentType,
    scope,
    label: entry.label,
    content: entry.content,
    peerId: entry.peerId ?? null,
    trustLevel: entry.trustLevel ?? null,
    createdAtIso: entry.createdAt ? new Date(entry.createdAt).toISOString() : null,
    origin: entry.origin ?? null,
    superseded: !!entry.supersededBy,
  };
}

// ---------------------------------------------------------------------------
// Erase-peer mutation
// ---------------------------------------------------------------------------

export interface ErasePeerResult {
  ok: boolean;
  message: string;
  erasedByAugment: Record<string, number>;
}

/**
 * Walk every augment whose memory provider exposes `forget(peerId)` and
 * call it. Aggregates the counts. A single peerId may exist across
 * multiple providers (layered-memory + supabaseMemory, say), so this is
 * the bulk operation backing the "Erase peer" button — the augment-level
 * `memory-erase` action only covers one provider at a time.
 */
export async function erasePeerAcrossProviders(
  augments: readonly Augment[],
  peerId: string,
): Promise<ErasePeerResult> {
  const erasedByAugment: Record<string, number> = {};
  let total = 0;
  for (const aug of augments) {
    if (!aug.memory || aug.memory.owns.kind !== "namespace") continue;
    const spec = aug.memory as NamespaceMemoryProvider;
    if (typeof spec.forget !== "function") continue;
    try {
      const erased = await spec.forget(peerId);
      erasedByAugment[aug.name] = erased;
      total += erased;
    } catch (err) {
      erasedByAugment[aug.name] = -1;
      return {
        ok: false,
        message: `${aug.name}.forget failed: ${(err as Error).message}`,
        erasedByAugment,
      };
    }
  }
  return {
    ok: true,
    message: `Erased ${total} entries for ${peerId}.`,
    erasedByAugment,
  };
}

const PEER_ID_RE = /^[A-Za-z0-9._:-]+$/;
export function validatePeerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  if (!PEER_ID_RE.test(trimmed)) return null;
  return trimmed;
}
