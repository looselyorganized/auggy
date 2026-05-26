import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { useToast } from "@/lib/toast";
import { useConfirm } from "@/lib/confirm";
import {
  erasePeer,
  fetchMemoryDashboard,
  type MemoryDashboard,
  type MemoryEntryView,
  type MemoryProviderSummary,
} from "@/lib/memory-api";
import { cn } from "@/lib/utils";

type Grouping = "peer" | "label" | "flat";

export function MemoryTab() {
  const { data } = useDashboardContext();
  const { push } = useToast();
  const confirm = useConfirm();
  const [dashboard, setDashboard] = useState<MemoryDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<Grouping>("peer");
  const [query, setQuery] = useState("");
  const [busyPeer, setBusyPeer] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchMemoryDashboard();
      setDashboard(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredEntries = useMemo(() => {
    if (!dashboard) return [];
    const q = query.trim().toLowerCase();
    if (!q) return dashboard.entries.filter((e) => !!e.peerId);
    return dashboard.entries
      .filter((e) => !!e.peerId)
      .filter(
        (e) =>
          e.label.toLowerCase().includes(q) ||
          (e.peerId ?? "").toLowerCase().includes(q) ||
          e.content.toLowerCase().includes(q),
      );
  }, [dashboard, query]);

  const staticEntries = useMemo(
    () => (dashboard ? dashboard.entries.filter((e) => !e.peerId) : []),
    [dashboard],
  );

  const handleErasePeer = useCallback(
    async (peerId: string) => {
      const ok = await confirm({
        message: `Erase EVERY memory entry for ${peerId} across all providers? This walks each provider's forget(peerId) implementation. The agent will have no recollection of this peer.`,
        confirmLabel: "Erase peer",
        destructive: true,
      });
      if (!ok) return;
      setBusyPeer(peerId);
      const r = await erasePeer(data?.csrfTokens ?? [], peerId);
      push(r.ok ? "success" : "error", r.message);
      if (r.ok) await refresh();
      setBusyPeer(null);
    },
    [confirm, data, push, refresh],
  );

  if (error && !dashboard) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Memory load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!dashboard) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Memory</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { totals } = dashboard;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Facts
          </h2>
          <p className="text-xs text-muted-foreground">
            {totals.providers} provider{totals.providers === 1 ? "" : "s"} ·{" "}
            {totals.peers} peer{totals.peers === 1 ? "" : "s"} known ·{" "}
            {totals.entries.toLocaleString()} entr{totals.entries === 1 ? "y" : "ies"}
          </p>
        </div>
        <div className="flex gap-1 rounded-md border bg-muted/30 p-0.5">
          {(["peer", "label", "flat"] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGrouping(g)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                grouping === g
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              By {g === "flat" ? "(flat)" : g}
            </button>
          ))}
        </div>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search content, label, or peerId…"
          className="pl-8"
        />
      </div>

      {filteredEntries.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {dashboard.entries.filter((e) => e.peerId).length === 0
                ? "No peer-scoped memory yet"
                : "No matches"}
            </CardTitle>
            <CardDescription>
              {dashboard.entries.filter((e) => e.peerId).length === 0
                ? "Once visitors chat with this agent and the autosave layer extracts facts, they'll appear here."
                : "Try a broader search."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : grouping === "peer" ? (
        <ByPeerView
          entries={filteredEntries}
          busyPeer={busyPeer}
          onErasePeer={handleErasePeer}
        />
      ) : grouping === "label" ? (
        <ByLabelView entries={filteredEntries} />
      ) : (
        <FlatView entries={filteredEntries} />
      )}

      <ProvidersFooter providers={dashboard.providers} staticEntries={staticEntries} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouped views
// ---------------------------------------------------------------------------

function ByPeerView({
  entries,
  busyPeer,
  onErasePeer,
}: {
  entries: MemoryEntryView[];
  busyPeer: string | null;
  onErasePeer: (peerId: string) => void;
}) {
  const groups = useMemo(() => groupByPeer(entries), [entries]);
  return (
    <div className="space-y-3">
      {groups.map(({ peerId, trustLevel, items }) => (
        <PeerCard
          key={peerId}
          peerId={peerId}
          trustLevel={trustLevel}
          items={items}
          busy={busyPeer === peerId}
          onErase={() => onErasePeer(peerId)}
        />
      ))}
    </div>
  );
}

function PeerCard({
  peerId,
  trustLevel,
  items,
  busy,
  onErase,
}: {
  peerId: string;
  trustLevel: string | null;
  items: MemoryEntryView[];
  busy: boolean;
  onErase: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Card>
      <CardHeader className="p-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex flex-1 items-center gap-2 text-left"
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
            <CardTitle className="font-mono text-sm">{peerId}</CardTitle>
            {trustLevel && <TrustTag trust={trustLevel} />}
            <span className="text-xs text-muted-foreground">
              {items.length} fact{items.length === 1 ? "" : "s"}
            </span>
          </button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onErase}
            title="Walk every provider's forget(peerId) and aggregate the result"
          >
            {busy ? "Erasing…" : "Erase peer"}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 p-3 pt-0">
          {items.map((e) => (
            <EntryRow key={`${e.augmentName}:${e.label}`} entry={e} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function ByLabelView({ entries }: { entries: MemoryEntryView[] }) {
  const groups = useMemo(() => groupByLabel(entries), [entries]);
  return (
    <div className="space-y-3">
      {groups.map(({ label, items }) => (
        <LabelCard key={label} label={label} items={items} />
      ))}
    </div>
  );
}

function LabelCard({ label, items }: { label: string; items: MemoryEntryView[] }) {
  const [open, setOpen] = useState(true);
  const peerCount = new Set(items.map((i) => i.peerId)).size;
  return (
    <Card>
      <CardHeader className="p-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
          <CardTitle className="font-mono text-sm">{label}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {items.length} fact{items.length === 1 ? "" : "s"} across {peerCount} peer
            {peerCount === 1 ? "" : "s"}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 p-3 pt-0">
          {items.map((e) => (
            <EntryRow key={`${e.augmentName}:${e.peerId}:${e.label}`} entry={e} showPeer />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function FlatView({ entries }: { entries: MemoryEntryView[] }) {
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (a.createdAtIso && b.createdAtIso) return b.createdAtIso.localeCompare(a.createdAtIso);
        return 0;
      }),
    [entries],
  );
  return (
    <Card>
      <CardContent className="space-y-1 p-2">
        {sorted.map((e) => (
          <EntryRow
            key={`${e.augmentName}:${e.peerId}:${e.label}`}
            entry={e}
            showPeer
            compact
          />
        ))}
      </CardContent>
    </Card>
  );
}

function EntryRow({
  entry,
  showPeer = false,
  compact = false,
}: {
  entry: MemoryEntryView;
  showPeer?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded border bg-muted/20", compact && "border-transparent bg-transparent")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs">{entry.label}</span>
        {showPeer && entry.peerId && (
          <span className="font-mono text-[10px] text-muted-foreground">{entry.peerId}</span>
        )}
        {entry.trustLevel && <TrustTag trust={entry.trustLevel} />}
        {entry.superseded && (
          <span className="text-[10px] uppercase tracking-wide text-amber-500">superseded</span>
        )}
        <span className="ml-1 flex-1 truncate text-xs text-muted-foreground">{entry.content}</span>
        {entry.createdAtIso && (
          <span className="text-[10px] text-muted-foreground" title={entry.createdAtIso}>
            {formatRelative(entry.createdAtIso)}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t bg-background px-2 py-2 text-xs">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
            {entry.content || "(empty)"}
          </pre>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <dt>provider</dt>
            <dd className="font-mono">{entry.augmentName}</dd>
            <dt>scope</dt>
            <dd className="font-mono">{entry.scope}</dd>
            {entry.origin && (
              <>
                <dt>origin</dt>
                <dd className="font-mono">{entry.origin}</dd>
              </>
            )}
            {entry.createdAtIso && (
              <>
                <dt>created</dt>
                <dd className="font-mono">{entry.createdAtIso}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function TrustTag({ trust }: { trust: string }) {
  const cls =
    trust === "creator"
      ? "text-amber-500"
      : trust === "agent"
        ? "text-sky-500"
        : trust === "public"
          ? "text-emerald-500"
          : "text-muted-foreground";
  return <span className={`text-[10px] uppercase tracking-wide ${cls}`}>{trust}</span>;
}

// ---------------------------------------------------------------------------
// Providers footer (static + non-listing providers)
// ---------------------------------------------------------------------------

function ProvidersFooter({
  providers,
  staticEntries,
}: {
  providers: MemoryProviderSummary[];
  staticEntries: MemoryEntryView[];
}) {
  if (providers.length === 0) return null;
  return (
    <div className="space-y-2 pt-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Providers
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {providers.map((p) => {
          const staticForThis = staticEntries.filter((e) => e.augmentName === p.augmentName);
          return (
            <Card key={p.augmentName}>
              <CardHeader className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="font-mono text-xs">{p.augmentName}</CardTitle>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {p.kind}
                  </span>
                </div>
                <CardDescription className="text-[11px]">
                  scope: <span className="font-mono">{p.scope}</span> · {p.entryCount} entr
                  {p.entryCount === 1 ? "y" : "ies"}
                  {!p.listSupported && (
                    <span className="ml-1 text-amber-500">· no admin listing</span>
                  )}
                  {p.listError && (
                    <span className="ml-1 text-destructive">· error: {p.listError}</span>
                  )}
                </CardDescription>
              </CardHeader>
              {staticForThis.length > 0 && (
                <CardContent className="space-y-1 p-3 pt-0">
                  {staticForThis.map((e) => (
                    <EntryRow key={`${e.augmentName}:${e.label}`} entry={e} compact />
                  ))}
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PeerGroup {
  peerId: string;
  trustLevel: string | null;
  items: MemoryEntryView[];
}

function groupByPeer(entries: MemoryEntryView[]): PeerGroup[] {
  const map = new Map<string, PeerGroup>();
  for (const e of entries) {
    if (!e.peerId) continue;
    const existing = map.get(e.peerId);
    if (existing) {
      existing.items.push(e);
      // Prefer the highest-trust label across the peer's entries.
      if (e.trustLevel && !existing.trustLevel) existing.trustLevel = e.trustLevel;
    } else {
      map.set(e.peerId, { peerId: e.peerId, trustLevel: e.trustLevel, items: [e] });
    }
  }
  return [...map.values()].sort((a, b) => a.peerId.localeCompare(b.peerId));
}

interface LabelGroup {
  label: string;
  items: MemoryEntryView[];
}

function groupByLabel(entries: MemoryEntryView[]): LabelGroup[] {
  const map = new Map<string, LabelGroup>();
  for (const e of entries) {
    const existing = map.get(e.label);
    if (existing) existing.items.push(e);
    else map.set(e.label, { label: e.label, items: [e] });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - t) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h`;
  return `${Math.round(diffSec / 86400)}d`;
}
